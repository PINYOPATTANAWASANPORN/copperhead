/**
 * Benchmark runner (RFC 11 §13, implementation spec §12.4): executes a suite
 * over the requested engines and seeds through the same `routeBoard` path
 * the CLI uses (never a bench-only path), writing one run directory per
 * board plus a report with the §13.4 record: versions, licenses,
 * adopted-versus-built layers, per-board raw metrics, failure counts,
 * overhead, and the reproduction command.
 */
import { readFile, writeFile, mkdir, cp, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { routeBoard, defaultRegistry } from '../pcb/engines/route.js';
import { placeBoard, defaultPlacerRegistry } from '../pcb/engines/place.js';
import { layoutBoard } from '../pcb/agent/orchestrate.js';
import { loadConfig } from '../config.js';
import { importBoard } from '../pcb/ir/kicad/import.js';
import { verifyDesign } from '../pcb/verify/index.js';
import { loadConstraints } from '../pcb/intent/load.js';
import { refillZones, extractFills } from '../pcb/ir/kicad/zones.js';
import { cp as copyDir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
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
  kind?: 'routing' | 'placement' | 'verify' | 'layout';
  routers?: string[];
  placers?: string[];
  /** placement: router used by the routability probe (default router-freerouting). */
  probeRouter?: string;
  mode?: ExecutionMode;
  seeds?: number[];
  budgetSeconds?: number;
  /** layout suites: run placement (default true); false keeps the given placement. */
  place?: boolean;
}

export interface BenchOptions {
  repoRoot: string;
  suitePath: string;
  outDir?: string;
  kind?: 'routing' | 'placement' | 'verify' | 'layout';
  routers?: string[];
  placers?: string[];
  probeRouter?: string;
  /** layout: repair cycles after the first pass (default 3). */
  maxRepairCycles?: number;
  /** layout: run placement before routing (default true); false keeps the placement as given (track D). */
  place?: boolean;
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
  /** layout kind: the closed loop's cycles. */
  cycles?: { n: number; action: string | null; status: string; errors: number; owed: number; seconds: number }[];
  /** verify kind: the harness's own verdict on the board as given. */
  verify?: { gates: { preflight: boolean; placement: boolean; routing: boolean }; errors: string[]; intentHardApplicable: number; intentHardViolations: number; expectedStatus?: string; matched?: boolean };
  /** golden cases: the status `pcb verify` owes the seeded fault (informational; routing rips the copper up unless preserved). */
  expectedVerifyStatus?: string;
  runDir: string;
  /** Repo-relative directory of the selected candidate (candidate.svg, candidate.kicad_pcb live there). */
  selectedDir?: string;
}

export interface BenchReport {
  benchmarkVersion: string;
  kind: 'routing' | 'placement' | 'verify' | 'layout';
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
    /** verify (tracks E and F): hard intent constraints passed over applicable, and expected-status agreement. */
    intent?: { hardApplicable: number; hardPassed: number; passRate: number; expectedMatched: number; expectedTotal: number };
    /** layout (tracks C and D): boards that needed repair cycles, and how many those cycles fixed. */
    repair?: { needed: number; fixed: number; meanCycles: number; holds: number };
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
  if (kind === 'verify') return runVerifySuite(opts, suite, kind);
  if (kind === 'layout') return runLayoutSuite(opts, suite, kind);
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
        const selCand = res.ranking.selected ? res.candidates.find((c) => c.engineId === res.ranking.selected) : undefined;
        const rec: BoardRecord = { id: entry.id, board: path.relative(opts.repoRoot, boardPath), seed, status: res.outcome.status, summary: res.outcome.summary, selected: res.ranking.selected ?? null, wallSeconds, engineSeconds, overheadSeconds: Math.max(0, wallSeconds - engineWall), candidates, ineligible: res.ineligible, errors, selectionRegret, invalidOverValid, runDir: path.relative(opts.repoRoot, runDir), ...(selCand ? { selectedDir: path.relative(opts.repoRoot, selCand.workDir) } : {}) };
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
  // older records: find the selected candidate's directory by its engine id
  const repoRoot = path.resolve(dir, '..', '..', '..', '..');
  for (const b of report.boards) {
    if (b.selectedDir || !b.selected || !b.runDir || report.kind === 'layout' || report.kind === 'verify') continue;
    const cdir = path.join(repoRoot, b.runDir, 'candidates');
    if (!existsSync(cdir)) continue;
    const hit = (await readdir(cdir)).find((d) => d.startsWith(`${b.selected}-`));
    if (hit) b.selectedDir = path.join(b.runDir, 'candidates', hit);
  }
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

/** Tracks E (intent) and F (refusal): verify each board as given, no engine; compare against expected.json where present. */
async function runVerifySuite(opts: BenchOptions, suite: SuiteFile, kind: 'verify'): Promise<{ report: BenchReport; dir: string }> {
  const log = opts.log ?? (() => {});
  const startedAt = new Date().toISOString();
  const dir = opts.outDir ?? path.join(opts.repoRoot, 'bench', 'var', 'runs', `${startedAt.replace(/[:.]/g, '-')}-${suite.suite}`);
  await mkdir(dir, { recursive: true });
  const track = opts.track ?? suite.tracks[0] ?? 'e';
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
  let hardApplicable = 0, hardPassed = 0, expectedTotal = 0, expectedMatched = 0;
  for (const entry of wanted) {
    const t0 = Date.now();
    try {
      const boardPath = await resolveBoard(opts, suite, entry.id, entry.file, dir);
      let text = await readFile(boardPath, 'utf8');
      const proPath = boardPath.replace(/\.kicad_pcb$/, '.kicad_pro');
      const projectText = existsSync(proPath) ? await readFile(proPath, 'utf8') : undefined;
      let drc;
      if (!opts.noKicad) {
        const tmp = await mkdtemp(path.join(tmpdir(), 'copperbench-verify-'));
        try {
          await copyDir(path.dirname(boardPath), tmp, { recursive: true });
          const copy = path.join(tmp, path.basename(boardPath));
          drc = await refillZones(copy);
          text = await readFile(copy, 'utf8');
        } finally {
          await rm(tmp, { recursive: true, force: true });
        }
      }
      const { design } = importBoard({ boardText: text, boardPath, ...(projectText ? { projectText } : {}), kicadVersion: kicad });
      const { registry, holds } = await loadConstraints(design, boardPath);
      const v = verifyDesign({ design, fills: extractFills(text), ...(drc ? { drc } : {}), constraints: registry });
      const errors = v.diagnostics.filter((d) => d.severity === 'error');
      const status = holds.length ? 'HOLD' : !v.gates.preflight.passed || !v.gates.placement.passed ? 'REFUSE' : errors.length ? 'PARTIAL' : (v.metrics.unrouted_count ?? 0) > 0 ? 'PARTIAL' : 'PASS';
      const applicable = v.metrics.intent_hard_total ?? 0;
      const violations = v.metrics.intent_hard_violations ?? 0;
      hardApplicable += applicable;
      hardPassed += Math.max(0, applicable - violations);
      const rec: BoardRecord = { id: entry.id, board: path.relative(opts.repoRoot, boardPath), seed: 0, status, summary: `${errors.length} error(s), gates ${v.gates.preflight.passed ? 'preflight ok' : 'PREFLIGHT'} / ${v.gates.placement.passed ? 'placement ok' : 'PLACEMENT'} / ${v.gates.routing.passed ? 'routing ok' : 'ROUTING'}`, selected: null, wallSeconds: (Date.now() - t0) / 1000, engineSeconds: 0, overheadSeconds: (Date.now() - t0) / 1000, candidates: [], ineligible: [], errors: holds, selectionRegret: 0, invalidOverValid: 0, runDir: '', verify: { gates: { preflight: v.gates.preflight.passed, placement: v.gates.placement.passed, routing: v.gates.routing.passed }, errors: [...new Set(errors.map((d) => d.code))], intentHardApplicable: applicable, intentHardViolations: violations } };
      const expectedPath = path.join(path.dirname(boardPath), 'expected.json');
      if (suite.corpus === 'golden' && existsSync(expectedPath)) {
        const expected = JSON.parse(await readFile(expectedPath, 'utf8')) as { status?: string; diagnostics?: { code: string }[] };
        if (expected.status) {
          const codes = new Set(v.diagnostics.map((d) => d.code));
          const matched = expected.status === status && (expected.diagnostics ?? []).every((d) => codes.has(d.code));
          rec.verify!.expectedStatus = expected.status;
          rec.verify!.matched = matched;
          rec.expectedVerifyStatus = expected.status;
          expectedTotal++;
          if (matched) expectedMatched++;
        }
      }
      boards.push(rec);
      log(`${entry.id}: ${status}${rec.verify!.expectedStatus ? ` (expected ${rec.verify!.expectedStatus}${rec.verify!.matched ? ', matched' : ', MISMATCH'})` : ''}; ${applicable} hard intent constraint(s), ${violations} violated`);
    } catch (err) {
      log(`${entry.id}: ENGINE_ERROR: ${(err as Error).message}`);
      boards.push({ id: entry.id, board: '', seed: 0, status: 'ENGINE_ERROR', summary: (err as Error).message, selected: null, wallSeconds: (Date.now() - t0) / 1000, engineSeconds: 0, overheadSeconds: 0, candidates: [], ineligible: [], errors: [(err as Error).message], selectionRegret: 0, invalidOverValid: 0, runDir: '' });
    }
  }
  const byStatus: Record<string, number> = {};
  for (const b of boards) byStatus[b.status] = (byStatus[b.status] ?? 0) + 1;
  const report: BenchReport = {
    benchmarkVersion: BENCHMARK_VERSION, kind, suite: suite.suite, corpus: suite.corpus, ...(suite.commit ? { corpusCommit: suite.commit } : {}), track, startedAt, finishedAt: new Date().toISOString(),
    harness: { copperhead: pkg.version, commit: await gitCommit(opts.repoRoot), kicad, node: process.version, platform: `${os.platform()} ${os.arch()}` },
    engines: [], scoring: 'none', mode: 'verify', seeds: [0], budgetSeconds: 0,
    reproduce: `copperbench run ${path.relative(opts.repoRoot, opts.suitePath)} --kind verify --track ${track}${opts.boards ? ` --boards ${opts.boards.join(',')}` : ''}`,
    boards,
    summary: { boards: boards.length, runs: boards.length, byStatus, cleanPassRate: boards.length ? boards.filter((b) => b.status === 'PASS').length / boards.length : 0, meanCompletion: 0, selectionRegretTotal: 0, invalidOverValidCount: 0, meanOverheadSeconds: boards.length ? boards.reduce((a, b) => a + b.overheadSeconds, 0) / boards.length : 0, meanEngineSeconds: 0, seedVariance: {}, intent: { hardApplicable, hardPassed, passRate: hardApplicable ? hardPassed / hardApplicable : 1, expectedMatched, expectedTotal } },
  };
  await writeReport(dir, report);
  return { report, dir };
}

/** Tracks C (end to end) and D (repair): the closed loop per board, no model; cycles and their effect recorded. */
async function runLayoutSuite(opts: BenchOptions, suite: SuiteFile, kind: 'layout'): Promise<{ report: BenchReport; dir: string }> {
  const log = opts.log ?? (() => {});
  const startedAt = new Date().toISOString();
  const dir = opts.outDir ?? path.join(opts.repoRoot, 'bench', 'var', 'runs', `${startedAt.replace(/[:.]/g, '-')}-${suite.suite}`);
  await mkdir(dir, { recursive: true });
  const track = opts.track ?? suite.tracks[0] ?? 'c';
  const budgetSeconds = opts.budgetSeconds ?? suite.budgetSeconds ?? 600;
  const routers = opts.routers ?? suite.routers;
  const placers = opts.placers ?? suite.placers;
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
  const baseConfig = await loadConfig(opts.repoRoot);
  const config = { ...baseConfig, pcb: { ...(baseConfig.pcb ?? {}), ...(routers ? { routers } : {}), ...(placers ? { placers } : {}), budgetSeconds, allowHarnessEngines: opts.allowHarnessEngines ?? false, ...(opts.maxParallel ? { maxParallelEngines: opts.maxParallel } : {}) } };
  const boards: BoardRecord[] = [];
  let needed = 0, fixed = 0, cyclesTotal = 0, holds = 0;
  const registry = defaultRegistry(opts.repoRoot);
  for (const entry of wanted) {
    const t0 = Date.now();
    try {
      const boardPath = await resolveBoard(opts, suite, entry.id, entry.file, dir);
      const runDir = path.join(dir, 'runs', `${entry.id}-s0`);
      log(`${entry.id}: layout (${kind})`);
      const res = await layoutBoard({ repoRoot: opts.repoRoot, config, boardPath, runDir, budgetSeconds, place: opts.place ?? suite.place ?? true, ...(opts.maxRepairCycles !== undefined ? { maxRepairCycles: opts.maxRepairCycles } : {}), apply: false, provider: null, policy: { network: 'none', allowHarnessEngines: opts.allowHarnessEngines ?? false, denyLicenses: [] }, ...(opts.probeRouter ? { probeRouter: opts.probeRouter } : {}), log: (l) => log(`  ${l}`) });
      const wallSeconds = (Date.now() - t0) / 1000;
      const first = res.cycles[0];
      const last = res.cycles[res.cycles.length - 1];
      if (first && first.status !== 'PASS') {
        needed++;
        if (last && last.status === 'PASS') fixed++;
      }
      cyclesTotal += Math.max(0, res.cycles.length - 1);
      if (res.outcome.status === 'HOLD') holds++;
      const sel = res.routing?.ranking.selected ? res.routing.candidates.find((c) => c.engineId === res.routing!.ranking.selected) : undefined;
      const metrics = sel ? Object.fromEntries(Object.entries(sel.verify.metrics).filter((kv): kv is [string, number] => typeof kv[1] === 'number')) : {};
      const engineSeconds = [...(res.placement?.invocations ?? []), ...(res.routing?.invocations ?? [])].reduce((a, i) => a + (i.result?.runtime.wallSeconds ?? 0), 0);
      boards.push({ id: entry.id, board: path.relative(opts.repoRoot, boardPath), seed: 0, status: res.outcome.status, summary: res.outcome.summary, selected: res.routing?.ranking.selected ?? res.placement?.ranking.selected ?? null, wallSeconds, engineSeconds, overheadSeconds: Math.max(0, wallSeconds - engineSeconds), candidates: sel ? [{ id: sel.engineId, rank: 1, eligible: true, gateFailures: [], score: 0, metrics }] : [], ineligible: [], errors: res.holds, selectionRegret: 0, invalidOverValid: 0, runDir: path.relative(opts.repoRoot, runDir), cycles: res.cycles.map((c) => ({ n: c.n, action: c.action?.type ?? null, status: c.status, errors: c.errors, owed: c.owed, seconds: c.seconds })) });
      log(`  ${res.outcome.status} after ${res.cycles.length} cycle(s)${res.cycles.length > 1 ? `: ${res.cycles.slice(1).map((c) => `${c.action?.type} -> ${c.status}`).join(', ')}` : ''}`);
    } catch (err) {
      log(`${entry.id}: ENGINE_ERROR: ${(err as Error).message}`);
      boards.push({ id: entry.id, board: '', seed: 0, status: 'ENGINE_ERROR', summary: (err as Error).message, selected: null, wallSeconds: (Date.now() - t0) / 1000, engineSeconds: 0, overheadSeconds: 0, candidates: [], ineligible: [], errors: [(err as Error).message], selectionRegret: 0, invalidOverValid: 0, runDir: '' });
    }
  }
  const byStatus: Record<string, number> = {};
  for (const b of boards) byStatus[b.status] = (byStatus[b.status] ?? 0) + 1;
  const engines = [...registry.list('router'), ...defaultPlacerRegistry(opts.repoRoot).list('placer')].filter((e) => (routers ?? []).includes(e.manifest.id) || (placers ?? []).includes(e.manifest.id) || (!routers && !placers)).map((e) => ({ id: e.manifest.id, version: e.manifest.version, license: e.manifest.license, adopted: e.manifest.harnessOnly ? ('harness-only' as const) : ('wrapped' as const), executionMode: e.manifest.executionMode, determinism: e.manifest.determinism }));
  const report: BenchReport = {
    benchmarkVersion: BENCHMARK_VERSION, kind, suite: suite.suite, corpus: suite.corpus, ...(suite.commit ? { corpusCommit: suite.commit } : {}), track, startedAt, finishedAt: new Date().toISOString(),
    harness: { copperhead: pkg.version, commit: await gitCommit(opts.repoRoot), kicad, node: process.version, platform: `${os.platform()} ${os.arch()}` },
    engines, scoring: 'default-low-speed-2-layer + default-placement-2-layer', mode: 'layout', seeds: [0], budgetSeconds,
    reproduce: `copperbench run ${path.relative(opts.repoRoot, opts.suitePath)} --kind layout --track ${track}${routers ? ` --routers ${routers.join(',')}` : ''}${placers ? ` --placers ${placers.join(',')}` : ''} --budget-seconds ${budgetSeconds}${opts.allowHarnessEngines ? ' --allow-harness-engines' : ''}${opts.boards ? ` --boards ${opts.boards.join(',')}` : ''}`,
    boards,
    summary: { boards: boards.length, runs: boards.length, byStatus, cleanPassRate: boards.length ? boards.filter((b) => b.status === 'PASS').length / boards.length : 0, meanCompletion: boards.length ? boards.reduce((a, b) => a + (b.candidates[0]?.metrics.completion_rate ?? 0), 0) / boards.length : 0, selectionRegretTotal: 0, invalidOverValidCount: 0, meanOverheadSeconds: boards.length ? boards.reduce((a, b) => a + b.overheadSeconds, 0) / boards.length : 0, meanEngineSeconds: boards.length ? boards.reduce((a, b) => a + b.engineSeconds, 0) / boards.length : 0, seedVariance: {}, repair: { needed, fixed, meanCycles: boards.length ? cyclesTotal / boards.length : 0, holds } },
  };
  await writeReport(dir, report);
  return { report, dir };
}
