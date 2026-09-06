/**
 * Benchmark runner (RFC 11 §13, implementation spec §12.4): executes a suite
 * over the requested engines and seeds through the same `routeBoard` path
 * the CLI uses (never a bench-only path), writing one run directory per
 * board plus a report with the §13.4 record: versions, licenses,
 * adopted-versus-built layers, per-board raw metrics, failure counts,
 * overhead, and the reproduction command.
 */
import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { routeBoard, defaultRegistry } from '../pcb/engines/route.js';
import { placeBoard, defaultPlacerRegistry } from '../pcb/engines/place.js';
import type { ExecutionMode } from '../pcb/engines/runner.js';
import type { EnginePolicy } from '../pcb/engines/registry.js';
import { kicadCliVersion } from '../kicad/cli.js';
import { loadScoringProfile } from '../pcb/verify/profiles/scoring/index.js';
import { renderHtml, summaryCsv } from './report.js';

export const BENCHMARK_VERSION = '1';

export interface SuiteFile {
  suite: string;
  corpus: 'golden' | 'pcbench';
  commit?: string;
  tracks: string[];
  criteria?: string;
  /** golden: case directory names. */
  cases?: string[];
  /** pcbench: board records from bench/corpora. */
  boards?: { id: string; file?: string; license?: string; footprints?: number }[];
  /** routing (default) or placement: which harness path the suite drives. */
  kind?: 'routing' | 'placement';
  routers?: string[];
  placers?: string[];
  /** placement: router used by the routability probe (default router-freerouting). */
  probeRouter?: string;
  mode?: ExecutionMode;
  seeds?: number[];
  budgetSeconds?: number;
}

export interface BenchOptions {
  repoRoot: string;
  suitePath: string;
  outDir?: string;
  kind?: 'routing' | 'placement';
  routers?: string[];
  placers?: string[];
  probeRouter?: string;
  mode?: ExecutionMode;
  seeds?: number[];
  budgetSeconds?: number;
  /** Run only these board ids. */
  boards?: string[];
  track?: string;
  allowHarnessEngines?: boolean;
  maxParallel?: number;
  noKicad?: boolean;
  log?: (line: string) => void;
}

export interface CandidateRecord {
  id: string;
  rank: number;
  eligible: boolean;
  gateFailures: string[];
  score: number;
  metrics: Record<string, number>;
}

export interface BoardRecord {
  id: string;
  board: string;
  seed: number;
  status: string;
  summary: string;
  selected: string | null;
  wallSeconds: number;
  engineSeconds: number;
  /** Harness time around the engines (wall beyond the slowest engine when they run concurrently): import, snapshot, materialize, verify, rank. */
  overheadSeconds: number;
  candidates: CandidateRecord[];
  ineligible: { engineId: string; reasons: string[] }[];
  errors: string[];
  /** Score of the best eligible candidate minus the selected one's (0 unless selection and ranking disagree). */
  selectionRegret: number;
  /** 1 when an ineligible candidate was selected while an eligible one existed. */
  invalidOverValid: number;
  /** golden cases: the status `pcb verify` owes the seeded fault (informational; routing rips the copper up unless preserved). */
  expectedVerifyStatus?: string;
  runDir: string;
}

export interface BenchReport {
  benchmarkVersion: string;
  kind: 'routing' | 'placement';
  suite: string;
  corpus: string;
  corpusCommit?: string;
  track: string;
  startedAt: string;
  finishedAt: string;
  harness: { copperhead: string; commit: string; kicad: string; node: string; platform: string };
  engines: { id: string; version: string; license: string; adopted: 'wrapped' | 'harness-only'; executionMode: string; determinism: string }[];
  scoring: string;
  mode: string;
  seeds: number[];
  budgetSeconds: number;
  reproduce: string;
  boards: BoardRecord[];
  summary: {
    boards: number;
    runs: number;
    byStatus: Record<string, number>;
    cleanPassRate: number;
    meanCompletion: number;
    selectionRegretTotal: number;
    invalidOverValidCount: number;
    meanOverheadSeconds: number;
    meanEngineSeconds: number;
    seedVariance: Record<string, number>;
    /** placement: over every gate-passing candidate with a probe, Pearson r between HPWL and probe completion (the B2 question). */
    hpwlVsRoutability?: { candidates: number; r: number | null; meanCompletion: number };
  };
}

export async function loadSuite(suitePath: string): Promise<SuiteFile> {
  const suite = JSON.parse(await readFile(suitePath, 'utf8')) as SuiteFile;
  if (!suite.suite || !suite.corpus) throw new Error(`${suitePath}: a suite needs "suite" and "corpus"`);
  return suite;
}

async function gitCommit(repoRoot: string): Promise<string> {
  try {
    return (await execa('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot })).stdout.trim();
  } catch {
    return 'unknown';
  }
}

/** Resolve a suite entry to a board file, upgrading corpus boards on a copy inside the run directory. */
async function resolveBoard(opts: BenchOptions, suite: SuiteFile, id: string, file: string | undefined, runRoot: string): Promise<string> {
  if (suite.corpus === 'golden') {
    const p = path.join(opts.repoRoot, 'bench', 'golden', id, 'board.kicad_pcb');
    if (!existsSync(p)) throw new Error(`golden case ${id}: ${path.relative(opts.repoRoot, p)} not found`);
    return p;
  }
  // bench/corpora/pcbench.sh leaves upgraded copies beside the clone; fall back to upgrading the raw board here
  const upgraded = path.join(opts.repoRoot, 'bench', 'var', 'corpora', 'pcbench-upgraded', `${id}.kicad_pcb`);
  const src = existsSync(upgraded) ? upgraded : path.join(opts.repoRoot, 'bench', 'var', 'corpora', 'pcbench', 'PCBs', id, file ?? 'processed.kicad_pcb');
  if (!existsSync(src)) throw new Error(`pcbench board ${id}: ${path.relative(opts.repoRoot, src)} not found (run bench/corpora/pcbench.sh)`);
  const dir = path.join(runRoot, 'boards', id);
  await mkdir(dir, { recursive: true });
  const dst = path.join(dir, 'board.kicad_pcb');
  await cp(src, dst);
  if (src !== upgraded && !opts.noKicad) await execa('kicad-cli', ['pcb', 'upgrade', '--force', dst]);
  return dst;
}

export async function runSuite(opts: BenchOptions): Promise<{ report: BenchReport; dir: string }> {
  const log = opts.log ?? (() => {});
  const suite = await loadSuite(opts.suitePath);
  const startedAt = new Date().toISOString();
  const dir = opts.outDir ?? path.join(opts.repoRoot, 'bench', 'var', 'runs', `${startedAt.replace(/[:.]/g, '-')}-${suite.suite}`);
  await mkdir(dir, { recursive: true });
  const kind = opts.kind ?? suite.kind ?? 'routing';
  const registry = kind === 'placement' ? defaultPlacerRegistry(opts.repoRoot) : defaultRegistry(opts.repoRoot);
  const routers = opts.routers ?? suite.routers ?? defaultRegistry(opts.repoRoot).list('router').map((e) => e.manifest.id);
  const placers = opts.placers ?? suite.placers ?? registry.list('placer').map((e) => e.manifest.id);
  const engineIds = kind === 'placement' ? placers : routers;
  const probeRouter = opts.probeRouter ?? suite.probeRouter ?? 'router-freerouting';
  const mode = opts.mode ?? suite.mode ?? 'ensemble';
  const seeds = opts.seeds ?? suite.seeds ?? [0];
  const budgetSeconds = opts.budgetSeconds ?? suite.budgetSeconds ?? 300;
  const track = opts.track ?? suite.tracks[0] ?? 'b';
  const scoringId = kind === 'placement' ? 'default-placement-2-layer' : 'default-low-speed-2-layer';
  const scoring = loadScoringProfile(scoringId);
  const policy: EnginePolicy = { network: 'none', allowHarnessEngines: opts.allowHarnessEngines ?? false, denyLicenses: [] };
  const entries = suite.corpus === 'golden' ? (suite.cases ?? []).map((id) => ({ id, file: undefined as string | undefined })) : (suite.boards ?? []).map((b) => ({ id: b.id, file: b.file }));
  const wanted = opts.boards ? entries.filter((e) => opts.boards!.includes(e.id)) : entries;
  const pkg = JSON.parse(await readFile(path.join(opts.repoRoot, 'package.json'), 'utf8')) as { version: string };
  let kicad = 'unknown';
  if (!opts.noKicad) {
    try {
      kicad = await kicadCliVersion();
    } catch {
      kicad = 'unknown';
    }
  }
  const boards: BoardRecord[] = [];
  for (const entry of wanted) {
    let boardPath: string;
    try {
      boardPath = await resolveBoard(opts, suite, entry.id, entry.file, dir);
    } catch (err) {
      log(`${entry.id}: ${(err as Error).message}`);
      for (const seed of seeds) boards.push({ id: entry.id, board: '', seed, status: 'ENGINE_ERROR', summary: (err as Error).message, selected: null, wallSeconds: 0, engineSeconds: 0, overheadSeconds: 0, candidates: [], ineligible: [], errors: [(err as Error).message], selectionRegret: 0, invalidOverValid: 0, runDir: '' });
      continue;
    }
    for (const seed of seeds) {
      const runDir = path.join(dir, 'runs', `${entry.id}-s${seed}`);
      const t0 = Date.now();
      log(`${entry.id} seed ${seed}: ${engineIds.join(',')} (${kind}, ${mode})`);
      try {
        const res =
          kind === 'placement'
            ? await placeBoard({ repoRoot: opts.repoRoot, boardPath, runDir, placers, mode: mode === 'staged' ? 'single' : mode, seed, limits: { engineSeconds: budgetSeconds, wallSeconds: budgetSeconds }, scoring: scoringId, policy, registry, probe: { routerId: probeRouter, budgetSeconds: Math.min(120, budgetSeconds) }, ...(opts.maxParallel ? { maxParallel: opts.maxParallel } : {}), ...(opts.noKicad ? { noKicad: true } : {}), log: (l) => log(`  ${l}`) })
            : await routeBoard({ repoRoot: opts.repoRoot, boardPath, runDir, routers, mode, seed, limits: { engineSeconds: budgetSeconds, wallSeconds: budgetSeconds }, scoring: scoringId, policy, registry, ...(opts.maxParallel ? { maxParallel: opts.maxParallel } : {}), ...(opts.noKicad ? { noKicad: true } : {}), log: (l) => log(`  ${l}`) });
        const wallSeconds = (Date.now() - t0) / 1000;
        const engineSeconds = res.invocations.reduce((a, i) => a + (i.result?.runtime.wallSeconds ?? 0), 0);
        // engines in race/ensemble run concurrently, so the harness overhead is the wall beyond the slowest engine
        // an engine that timed out or crashed still occupied its wall: take the invocation span from provenance
        const spans = res.invocations.map((i) => i.provenance.startedAt && i.provenance.finishedAt ? (Date.parse(i.provenance.finishedAt) - Date.parse(i.provenance.startedAt)) / 1000 : (i.result?.runtime.wallSeconds ?? 0));
        const engineWall = mode === 'race' || mode === 'ensemble' ? Math.max(0, ...spans) : spans.reduce((a, x) => a + x, 0);
        const candidates: CandidateRecord[] = res.ranking.candidates.map((c) => ({ id: c.id, rank: c.rank, eligible: c.eligible, gateFailures: [...c.gateFailures, ...c.profileGateFailures], score: c.score ?? Number.POSITIVE_INFINITY, metrics: c.metrics as Record<string, number> }));
        const eligible = candidates.filter((c) => c.eligible);
        const selected = candidates.find((c) => c.id === res.ranking.selected);
        const oracle = eligible.length ? Math.min(...eligible.map((c) => c.score)) : 0;
        const selectionRegret = selected && selected.eligible ? Math.max(0, selected.score - oracle) : 0;
        const invalidOverValid = selected && !selected.eligible && eligible.length ? 1 : 0;
        const errors = res.invocations.filter((i) => i.error).map((i) => `${i.engineId}: ${i.error!.kind}: ${i.error!.message}`);
        for (const i of res.invocations) if (!i.error && i.result && (i.result.status === 'failed' || i.result.status === 'unsupported')) errors.push(`${i.engineId}: ${i.result.status}${i.result.diagnostics[0] ? `: ${i.result.diagnostics[0].message}` : ' (no copper, no explanation from the engine)'}`);
        const rec: BoardRecord = { id: entry.id, board: path.relative(opts.repoRoot, boardPath), seed, status: res.outcome.status, summary: res.outcome.summary, selected: res.ranking.selected ?? null, wallSeconds, engineSeconds, overheadSeconds: Math.max(0, wallSeconds - engineWall), candidates, ineligible: res.ineligible, errors, selectionRegret, invalidOverValid, runDir: path.relative(opts.repoRoot, runDir) };
        const expectedPath = path.join(path.dirname(boardPath), 'expected.json');
        if (suite.corpus === 'golden' && existsSync(expectedPath)) {
          const expected = JSON.parse(await readFile(expectedPath, 'utf8')) as { status?: string };
          if (expected.status) rec.expectedVerifyStatus = expected.status;
        }
        boards.push(rec);
        log(`  ${res.outcome.status}: ${res.outcome.summary} (${wallSeconds.toFixed(1)} s, engines ${engineSeconds.toFixed(1)} s)`);
      } catch (err) {
        const wallSeconds = (Date.now() - t0) / 1000;
        log(`  ENGINE_ERROR: ${(err as Error).message}`);
        boards.push({ id: entry.id, board: path.relative(opts.repoRoot, boardPath), seed, status: 'ENGINE_ERROR', summary: (err as Error).message, selected: null, wallSeconds, engineSeconds: 0, overheadSeconds: wallSeconds, candidates: [], ineligible: [], errors: [(err as Error).message], selectionRegret: 0, invalidOverValid: 0, runDir: path.relative(opts.repoRoot, runDir) });
      }
    }
  }
  const finishedAt = new Date().toISOString();
  const engines = engineIds.map((id) => registry.get(id)).filter((e): e is NonNullable<typeof e> => !!e).map((e) => ({ id: e.manifest.id, version: e.manifest.version, license: e.manifest.license, adopted: e.manifest.harnessOnly ? ('harness-only' as const) : ('wrapped' as const), executionMode: e.manifest.executionMode, determinism: e.manifest.determinism }));
  const byStatus: Record<string, number> = {};
  for (const b of boards) byStatus[b.status] = (byStatus[b.status] ?? 0) + 1;
  const withCandidates = boards.filter((b) => b.selected);
  const completionKey = kind === 'placement' ? 'routability_completion' : 'completion_rate';
  const completion = withCandidates.map((b) => b.candidates.find((c) => c.id === b.selected)?.metrics[completionKey] ?? 0);
  // B2's question: does HPWL predict routing completion? Over every eligible probed candidate.
  let hpwlVsRoutability: BenchReport['summary']['hpwlVsRoutability'];
  if (kind === 'placement') {
    const pts = boards.flatMap((b) => b.candidates.filter((c) => c.eligible && c.metrics.routability_completion !== undefined && c.metrics.hpwl_nm !== undefined).map((c) => [c.metrics.hpwl_nm!, c.metrics.routability_completion!] as [number, number]));
    hpwlVsRoutability = { candidates: pts.length, r: pearson(pts), meanCompletion: pts.length ? pts.reduce((a, p) => a + p[1], 0) / pts.length : 0 };
  }
  const seedVariance: Record<string, number> = {};
  if (seeds.length > 1) {
    for (const id of new Set(boards.map((b) => b.id))) {
      const wl = boards.filter((b) => b.id === id && b.selected).map((b) => b.candidates.find((c) => c.id === b.selected)?.metrics.total_wirelength_nm ?? 0);
      if (wl.length > 1) {
        const mean = wl.reduce((a, x) => a + x, 0) / wl.length;
        seedVariance[id] = Math.sqrt(wl.reduce((a, x) => a + (x - mean) ** 2, 0) / wl.length) / (mean || 1);
      }
    }
  }
  const report: BenchReport = {
    benchmarkVersion: BENCHMARK_VERSION, kind, suite: suite.suite, corpus: suite.corpus, ...(suite.commit ? { corpusCommit: suite.commit } : {}), track, startedAt, finishedAt,
    harness: { copperhead: pkg.version, commit: await gitCommit(opts.repoRoot), kicad, node: process.version, platform: `${os.platform()} ${os.arch()}` },
    engines, scoring: scoring.id, mode, seeds, budgetSeconds,
    reproduce: `copperbench run ${path.relative(opts.repoRoot, opts.suitePath)} --kind ${kind} ${kind === 'placement' ? `--placers ${placers.join(',')} --probe-router ${probeRouter}` : `--routers ${routers.join(',')}`} --mode ${mode} --seeds ${seeds.join(',')} --budget-seconds ${budgetSeconds}${opts.allowHarnessEngines ? ' --allow-harness-engines' : ''}${opts.boards ? ` --boards ${opts.boards.join(',')}` : ''}`,
    boards,
    summary: {
      boards: new Set(boards.map((b) => b.id)).size, runs: boards.length, byStatus,
      cleanPassRate: boards.length ? boards.filter((b) => b.status === 'PASS').length / boards.length : 0,
      meanCompletion: completion.length ? completion.reduce((a, x) => a + x, 0) / completion.length : 0,
      selectionRegretTotal: boards.reduce((a, b) => a + b.selectionRegret, 0),
      invalidOverValidCount: boards.reduce((a, b) => a + b.invalidOverValid, 0),
      meanOverheadSeconds: boards.length ? boards.reduce((a, b) => a + b.overheadSeconds, 0) / boards.length : 0,
      meanEngineSeconds: boards.length ? boards.reduce((a, b) => a + b.engineSeconds, 0) / boards.length : 0,
      seedVariance,
      ...(hpwlVsRoutability ? { hpwlVsRoutability } : {}),
    },
  };
  await writeReport(dir, report);
  return { report, dir };
}

export async function writeReport(dir: string, report: BenchReport): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  await writeFile(path.join(dir, 'report.html'), renderHtml(report), 'utf8');
  await writeFile(path.join(dir, 'summary.csv'), summaryCsv(report), 'utf8');
}

function pearson(pts: [number, number][]): number | null {
  if (pts.length < 3) return null;
  const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of pts) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}
