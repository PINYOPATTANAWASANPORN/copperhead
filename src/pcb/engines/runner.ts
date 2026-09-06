/**
 * Engine runner (RFC 11 §9.3, §9.4, §17; implementation spec §6.5): executes
 * a job on eligible engines from one immutable snapshot under single, race,
 * staged, or ensemble mode. Every invocation gets its own directory, a
 * scrubbed environment, a provenance record, a budget charge, and a snapshot
 * integrity check afterwards; an engine that touched its input yields
 * INVALID_OUTPUT rather than a silently corrupted source.
 */
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import type { BoardSnapshot } from '../ir/snapshot.js';
import { verifySnapshotIntact, type RunDir } from '../ir/snapshot.js';
import { EngineError } from '../ir/status.js';
import type { PcbDesign } from '../ir/types.js';
import { applyCandidate } from '../ir/kicad/export.js';
import type { EngineManifest, RoutingJob, RoutingResult, PlacementJob, PlacementResult, RouterPlugin, PlacerPlugin, RunContext, EngineProvenance } from './contracts.js';
import { eligible, type RegisteredEngine, type EnginePolicy, type JobShape, DEFAULT_POLICY } from './registry.js';
import { Budget } from './budget.js';

export type ExecutionMode = 'single' | 'race' | 'staged' | 'ensemble';

export interface Invocation<TResult> {
  engineId: string;
  manifest: EngineManifest;
  /** Directory holding job.json, result.json, provenance.json, logs. */
  workDir: string;
  result: TResult | null;
  error: { kind: string; message: string; fix?: string } | null;
  provenance: EngineProvenance;
  /** Set when the snapshot changed under the engine (INVALID_OUTPUT). */
  snapshotViolation: string | null;
}

export interface RunOptions {
  run: RunDir;
  /** Text of the source board the snapshot was imported from (exported per job for engines that read files). */
  sourceText: string;
  design: PcbDesign;
  projectText?: string;
  snapshotFileHash: string;
  policy?: EnginePolicy;
  budget: Budget;
  maxParallel?: number;
  log?: (line: string) => void;
  onEvent?: (event: Record<string, unknown>) => void;
}

async function event(run: RunDir, onEvent: RunOptions['onEvent'], ev: Record<string, unknown>): Promise<void> {
  const line = { at: new Date().toISOString(), ...ev };
  await appendFile(path.join(run.root, 'events.jsonl'), JSON.stringify(line) + '\n', 'utf8');
  onEvent?.(line);
}

async function prepareWorkDir(opts: RunOptions, engineId: string, ordinal: number, boardText: string): Promise<{ workDir: string; boardPath: string; projectPath?: string }> {
  const workDir = path.join(opts.run.candidatesDir, `${engineId}-${ordinal}`);
  await mkdir(workDir, { recursive: true });
  const boardPath = path.join(workDir, 'board.kicad_pcb');
  await writeFile(boardPath, boardText, 'utf8');
  let projectPath: string | undefined;
  if (opts.projectText) {
    projectPath = path.join(workDir, 'board.kicad_pro');
    await writeFile(projectPath, opts.projectText, 'utf8');
  }
  return { workDir, boardPath, ...(projectPath ? { projectPath } : {}) };
}

async function invoke<TJob extends { runId: string; seed: number; limits: { wallSeconds: number; engineSeconds: number } }, TResult extends { status: string; runtime: { wallSeconds: number; engineSeconds?: number }; provenance: EngineProvenance }>(
  opts: RunOptions,
  engine: RegisteredEngine,
  ordinal: number,
  job: TJob,
  boardText: string,
  call: (plugin: RouterPlugin & PlacerPlugin, job: TJob, ctx: RunContext) => Promise<TResult>,
): Promise<Invocation<TResult>> {
  const { workDir, boardPath, projectPath } = await prepareWorkDir(opts, engine.manifest.id, ordinal, boardText);
  await writeFile(path.join(workDir, 'job.json'), JSON.stringify({ ...job, snapshot: { hash: (job as unknown as { snapshot: BoardSnapshot }).snapshot.hash } }), 'utf8');
  const stdout: string[] = [];
  const ctx: RunContext = {
    workDir,
    boardPath,
    ...(projectPath ? { projectPath } : {}),
    log: (line) => {
      stdout.push(line);
      opts.log?.(`[${engine.manifest.id}] ${line}`);
    },
    progress: (fraction, note) => void event(opts.run, opts.onEvent, { event: 'progress', engineId: engine.manifest.id, fraction, note }),
  };
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  await event(opts.run, opts.onEvent, { event: 'engine-start', engineId: engine.manifest.id, version: engine.manifest.version, ordinal });
  let result: TResult | null = null;
  let error: Invocation<TResult>['error'] = null;
  try {
    result = await call(engine.plugin as RouterPlugin & PlacerPlugin, job, ctx);
  } catch (e) {
    error = e instanceof EngineError ? { kind: e.kind, message: e.message, fix: e.fix } : { kind: 'process-failed', message: (e as Error).message };
  }
  const wall = (Date.now() - t0) / 1000;
  const finishedAt = new Date().toISOString();
  const provenance: EngineProvenance = result?.provenance ?? { engineId: engine.manifest.id, engineVersion: engine.manifest.version, adapterVersion: engine.manifest.adapterVersion, seed: job.seed, startedAt, finishedAt };
  provenance.startedAt = startedAt;
  provenance.finishedAt = finishedAt;
  opts.budget.charge(engine.manifest.id, result?.runtime.engineSeconds ?? wall, wall, error ? `failed: ${error.kind}` : undefined);
  const intact = await verifySnapshotIntact(opts.run, { fileHash: opts.snapshotFileHash, designHash: opts.design.source.contentHash });
  const snapshotViolation = intact.ok ? null : intact.reason;
  await writeFile(path.join(workDir, 'stdout.log'), stdout.join('\n'), 'utf8');
  await writeFile(path.join(workDir, 'provenance.json'), JSON.stringify(provenance, null, 2), 'utf8');
  if (result) await writeFile(path.join(workDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
  if (error) await writeFile(path.join(workDir, 'error.json'), JSON.stringify(error, null, 2), 'utf8');
  await event(opts.run, opts.onEvent, { event: 'engine-end', engineId: engine.manifest.id, ordinal, wallSeconds: wall, status: error ? `error:${error.kind}` : result?.status, snapshotViolation });
  return { engineId: engine.manifest.id, manifest: engine.manifest, workDir, result, error, provenance, snapshotViolation };
}

async function parallel<T>(items: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out: T[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await items[i]!();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

export interface RoutingRun {
  mode: ExecutionMode;
  invocations: Invocation<RoutingResult>[];
  ineligible: { engineId: string; reasons: string[] }[];
}

export interface RoutingRunOptions extends RunOptions {
  snapshot: BoardSnapshot;
  engines: RegisteredEngine[];
  mode: ExecutionMode;
  job: Omit<RoutingJob, 'runId' | 'snapshot'>;
  /** staged: ordered steps; each routes its net scope with its engine, preserving the copper so far. */
  stages?: { engineId: string; netIds: string[] | null; strategy?: RoutingJob['strategy'] }[];
  shape?: Partial<JobShape>;
}

export async function runRouting(opts: RoutingRunOptions): Promise<RoutingRun> {
  const policy = opts.policy ?? DEFAULT_POLICY;
  const copperLayers = opts.design.board.layers.filter((l) => l.kind === 'copper').length;
  const shape: JobShape = { kind: 'router', hardConstraintKinds: [], copperLayers, ...opts.shape };
  const ineligible: RoutingRun['ineligible'] = [];
  const usable = opts.engines.filter((e) => {
    const el = eligible(e, shape, policy);
    if (!el.ok) ineligible.push({ engineId: e.manifest.id, reasons: el.reasons });
    return el.ok;
  });
  const mk = (i: number, extra: Partial<RoutingJob> = {}): RoutingJob => ({ runId: `${path.basename(opts.run.root)}-${i}`, snapshot: opts.snapshot, ...opts.job, ...extra });
  const invocations: Invocation<RoutingResult>[] = [];
  if (opts.mode === 'staged') {
    let design = opts.design;
    let text = opts.sourceText;
    let preserved = new Set<string>();
    for (const [i, step] of (opts.stages ?? []).entries()) {
      const engine = usable.find((e) => e.manifest.id === step.engineId);
      if (!engine) {
        ineligible.push({ engineId: step.engineId, reasons: ['not eligible for this stage'] });
        continue;
      }
      const job = mk(i, { scope: { netIds: step.netIds, region: null, preserveExistingRoutes: true }, ...(step.strategy ? { strategy: step.strategy } : {}) });
      const inv = await invoke(opts, engine, i, job, text, (p, j, c) => p.route(j, c));
      invocations.push(inv);
      if (inv.result && inv.result.status !== 'failed' && inv.result.status !== 'unsupported') {
        const routing = { segments: [...design.routing.segments, ...inv.result.segments], arcs: [...design.routing.arcs, ...inv.result.arcs], vias: [...design.routing.vias, ...inv.result.vias] };
        for (const s of routing.segments) if (s.id) preserved.add(s.id);
        for (const v of routing.vias) if (v.id) preserved.add(v.id);
        text = applyCandidate(text, design, { routing: { ...routing, preserveIds: preserved } }).text;
        const { importBoard } = await import('../ir/kicad/import.js');
        design = importBoard({ boardText: text, boardPath: design.source.files.board, ...(opts.projectText ? { projectText: opts.projectText } : {}), now: design.source.importedAt }).design;
        preserved = new Set([...design.routing.segments.map((s) => s.id), ...design.routing.vias.map((v) => v.id)]);
      }
    }
    return { mode: opts.mode, invocations, ineligible };
  }
  const chosen = opts.mode === 'single' ? usable.slice(0, 1) : usable;
  const tasks = chosen.map((engine, i) => async () => {
    if (!opts.budget.affords({ engineSeconds: 1, wallSeconds: 1 })) {
      return { engineId: engine.manifest.id, manifest: engine.manifest, workDir: '', result: null, error: { kind: 'timeout', message: 'budget exhausted before start' }, provenance: { engineId: engine.manifest.id, engineVersion: engine.manifest.version, adapterVersion: engine.manifest.adapterVersion, seed: opts.job.seed, startedAt: '', finishedAt: '' }, snapshotViolation: null } satisfies Invocation<RoutingResult>;
    }
    return invoke(opts, engine, i, mk(i), opts.sourceText, (p, j, c) => p.route(j, c));
  });
  invocations.push(...(await parallel(tasks, opts.mode === 'race' || opts.mode === 'ensemble' ? (opts.maxParallel ?? 2) : 1)));
  return { mode: opts.mode, invocations, ineligible };
}

export interface PlacementRunOptions extends RunOptions {
  snapshot: BoardSnapshot;
  engines: RegisteredEngine[];
  mode: Exclude<ExecutionMode, 'staged'>;
  job: Omit<PlacementJob, 'runId' | 'snapshot'>;
  shape?: Partial<JobShape>;
}

export async function runPlacement(opts: PlacementRunOptions): Promise<{ mode: ExecutionMode; invocations: Invocation<PlacementResult>[]; ineligible: RoutingRun['ineligible'] }> {
  const policy = opts.policy ?? DEFAULT_POLICY;
  const copperLayers = opts.design.board.layers.filter((l) => l.kind === 'copper').length;
  const shape: JobShape = { kind: 'placer', hardConstraintKinds: [], copperLayers, ...opts.shape };
  const ineligible: RoutingRun['ineligible'] = [];
  const usable = opts.engines.filter((e) => {
    const el = eligible(e, shape, policy);
    if (!el.ok) ineligible.push({ engineId: e.manifest.id, reasons: el.reasons });
    return el.ok;
  });
  const chosen = opts.mode === 'single' ? usable.slice(0, 1) : usable;
  const tasks = chosen.map((engine, i) => () => invoke(opts, engine, i, { runId: `${path.basename(opts.run.root)}-${i}`, snapshot: opts.snapshot, ...opts.job }, opts.sourceText, (p, j, c) => p.place(j, c)));
  const invocations = await parallel(tasks, opts.mode === 'single' ? 1 : (opts.maxParallel ?? 2));
  return { mode: opts.mode, invocations, ineligible };
}
