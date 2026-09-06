/**
 * router-kicad-tools (ADR 0002, ADR 0008): wraps `kct route` (kicad-tools
 * 0.20.0, MIT) out of process. The adapter exports the board, runs kct on
 * the copy, re-imports the output, and returns the copper that is new.
 * `router-kicad-tools-astar` in the RFC is this wrapper with strategy basic.
 */
import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { EngineManifest, RoutingJob, RoutingResult, RouterPlugin, RunContext } from '../../contracts.js';
import { ENGINE_SCHEMA_VERSION } from '../../contracts.js';
import { EngineError } from '../../../ir/status.js';
import { importBoard } from '../../../ir/kicad/import.js';
import { extractFills } from '../../../ir/kicad/zones.js';
import { nmToMm } from '../../../ir/units.js';

export const KICAD_TOOLS_MANIFEST: EngineManifest = {
  id: 'router-kicad-tools',
  kind: 'router',
  version: '0.20.0',
  adapterVersion: '1',
  license: 'MIT',
  inputSchemaVersions: [ENGINE_SCHEMA_VERSION],
  outputSchemaVersions: [ENGINE_SCHEMA_VERSION],
  determinism: 'seeded',
  executionMode: 'process',
  networkRequirement: 'none',
  harnessOnly: false,
  requires: { binaries: ['kct'], python: '>=3.10' },
  capabilities: { maxLayers: 6, differentialPairs: false, lengthMatching: false, pushAndShove: false, partialRouting: true, preserveExistingRoutes: true, arbitraryAngles: true, blindBuriedVias: false, copperZones: true },
  supportedConstraints: ['routing.width', 'routing.clearance', 'routing.via'],
};

export const KCT_STRATEGIES = ['basic', 'negotiated', 'monte-carlo', 'evolutionary'] as const;

/** kct: COPPERHEAD_KCT > bench/var/tools/kt-venv > PATH. */
export function resolveKct(env = process.env, repoRoot = process.cwd()): string {
  if (env.COPPERHEAD_KCT?.trim()) return env.COPPERHEAD_KCT.trim();
  const venv = path.join(repoRoot, 'bench', 'var', 'tools', 'kt-venv', 'bin', 'kct');
  return existsSync(venv) ? venv : 'kct';
}

export class KicadToolsRouter implements RouterPlugin {
  constructor(private readonly opts: { kct?: string; repoRoot?: string } = {}) {}

  async manifest(): Promise<EngineManifest> {
    return KICAD_TOOLS_MANIFEST;
  }

  async route(job: RoutingJob, ctx: RunContext): Promise<RoutingResult> {
    const t0 = Date.now();
    const kct = this.opts.kct ?? resolveKct(process.env, this.opts.repoRoot);
    const design = job.snapshot.design;
    const rules = design.board.rules;
    const strategy = String(job.strategy.strategy ?? 'negotiated');
    if (!(KCT_STRATEGIES as readonly string[]).includes(strategy)) throw new EngineError('schema-mismatch', `unknown kct strategy "${strategy}"`, `use one of ${KCT_STRATEGIES.join(', ')}`);
    const outPath = path.join(ctx.workDir, 'routed.kicad_pcb');
    const args = ['route', ctx.boardPath, '-o', outPath, '--strategy', strategy, '--trace-width', nmToMm(rules.trackWidthNm), '--clearance', nmToMm(rules.clearanceNm), '--via-drill', nmToMm(rules.viaDrillNm), '--via-diameter', nmToMm(rules.viaDiameterNm), '--timeout', String(Math.max(10, job.limits.wallSeconds - 5)), '--skip-drc', '--layers', '2'];
    if (job.scope.preserveExistingRoutes) args.push('--preserve-existing');
    if (job.scope.netIds) {
      const names = design.nets.filter((n) => job.scope.netIds!.includes(n.id)).map((n) => n.name);
      if (names.length) args.push('--nets', names.join(','));
    }
    ctx.log(`${kct} ${args.join(' ')}`);
    const res = await execa(kct, args, { cwd: ctx.workDir, reject: false, timeout: job.limits.wallSeconds * 1000, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', VIRTUAL_ENV: process.env.VIRTUAL_ENV ?? '' }, extendEnv: false, ...(ctx.signal ? { cancelSignal: ctx.signal } : {}) });
    await writeFile(path.join(ctx.workDir, 'kct.log'), `${res.stdout ?? ''}\n${res.stderr ?? ''}`, 'utf8');
    if (res.timedOut) throw new EngineError('timeout', `kct route exceeded ${job.limits.wallSeconds}s`, 'raise the budget or use --strategy basic');
    if (res.failed && /ENOENT/.test(String((res as { code?: string }).code ?? ''))) throw new EngineError('no-binary', `kct not found at "${kct}"`, 'run bench/corpora/tools.sh kicad-tools or pip install kicad-tools==0.20.0');
    if (!existsSync(outPath)) throw new EngineError(res.exitCode === 0 ? 'no-output' : 'process-failed', `kct route ${res.exitCode === 0 ? 'wrote no output' : `exited ${res.exitCode}`}: ${(res.stderr ?? res.stdout ?? '').trim().split('\n').slice(-3).join(' | ').slice(0, 300)}`, 'see kct.log in the run directory');
    const text = await readFile(outPath, 'utf8');
    const routed = importBoard({ boardText: text, boardPath: outPath, now: design.source.importedAt }).design;
    const before = new Set([...design.routing.segments.map((s) => s.id), ...design.routing.vias.map((v) => v.id)]);
    const segments = routed.routing.segments.filter((s) => !before.has(s.id));
    const vias = routed.routing.vias.filter((v) => !before.has(v.id));
    // kct renumbers nets on its own board; map back by name
    const byName = new Map(design.nets.map((n) => [n.name, n.id]));
    const routedName = new Map(routed.nets.map((n) => [n.id, n.name]));
    const remap = (id: string) => byName.get(routedName.get(id) ?? '') ?? '';
    for (const s of segments) s.netId = remap(s.netId);
    for (const v of vias) v.netId = remap(v.netId);
    const routable = design.nets.filter((n) => n.padIds.length >= 2 && (!job.scope.netIds || job.scope.netIds.includes(n.id)));
    const touched = new Set([...segments.map((s) => s.netId), ...vias.map((v) => v.netId)]);
    const unrouted = routable.filter((n) => !touched.has(n.id)).map((n) => n.id);
    const wall = (Date.now() - t0) / 1000;
    return {
      status: unrouted.length ? (segments.length ? 'partial' : 'failed') : 'complete',
      segments,
      arcs: [],
      vias,
      fills: extractFills(text),
      unroutedNetIds: unrouted,
      diagnostics: [],
      runtime: { wallSeconds: wall, engineSeconds: wall },
      provenance: { engineId: KICAD_TOOLS_MANIFEST.id, engineVersion: '0.20.0', adapterVersion: '1', invocation: { binary: kct, args, envKeys: ['PATH', 'HOME', 'VIRTUAL_ENV'] }, seed: job.seed, exitCode: res.exitCode ?? -1, startedAt: new Date(t0).toISOString(), finishedAt: new Date().toISOString() },
    };
  }
}
