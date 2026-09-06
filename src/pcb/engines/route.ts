/**
 * Routing orchestration shared by `copperhead pcb route`, the benchmark, and
 * (later) the closed loop: import the board, snapshot it, run the eligible
 * routers under the requested mode, materialize and verify every candidate,
 * score, rank, write the run directory, and return one Outcome.
 * LLM-free and network-free; only local engines run.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { importBoard } from '../ir/kicad/import.js';
import { makeSnapshot, writeRunDir, DEFAULT_LIMITS, type ResourceLimits } from '../ir/snapshot.js';
import type { Outcome, LayoutStatus } from '../ir/status.js';
import { kicadCliVersion } from '../../kicad/cli.js';
import { loadProfile } from '../verify/profiles/index.js';
import { loadScoringProfile } from '../verify/profiles/scoring/index.js';
import { routingMetrics } from '../verify/metrics.js';
import { rank, type Ranking } from '../verify/scoring.js';
import { verifyDesign } from '../verify/index.js';
import type { Diagnostic } from '../verify/diagnostic.js';
import { EngineRegistry, DEFAULT_POLICY, type EnginePolicy } from './registry.js';
import { runRouting, type ExecutionMode, type Invocation } from './runner.js';
import { Budget } from './budget.js';
import { materialize, candidateFromRouting, type MaterializedCandidate } from './candidates.js';
import { defaultStagedPlan, type LayerPreference, type StagedPlan } from './plan.js';
import type { RoutingResult, RoutingStrategy } from './contracts.js';
import { ReferenceRouter, REFERENCE_ROUTER_MANIFEST } from './routers/reference/adapter.js';
import { FreeroutingRouter, FREEROUTING_MANIFEST } from './routers/freerouting/adapter.js';
import { KicadToolsRouter, KICAD_TOOLS_MANIFEST } from './routers/kicad-tools/adapter.js';

export interface RouteOptions {
  repoRoot: string;
  /** Absolute path of the board. */
  boardPath: string;
  projectPath?: string;
  runDir: string;
  /** Engine ids in preference order; default: every registered router. */
  routers?: string[];
  mode?: ExecutionMode;
  netNames?: string[];
  preserveExistingRoutes?: boolean;
  strategy?: RoutingStrategy;
  /** staged mode: nets routed after power and before the bulk, by name. */
  criticalNetNames?: string[];
  /** Layer-preference constraints, mapped onto the engines' layer settings. */
  layerPreferences?: LayerPreference[];
  seed?: number;
  limits?: Partial<ResourceLimits>;
  profile?: string;
  scoring?: string;
  policy?: EnginePolicy;
  maxParallel?: number;
  registry?: EngineRegistry;
  noKicad?: boolean;
  log?: (line: string) => void;
}

export interface RouteRun {
  outcome: Outcome<Diagnostic>;
  runDir: string;
  ranking: Ranking;
  invocations: Invocation<RoutingResult>[];
  candidates: MaterializedCandidate[];
  ineligible: { engineId: string; reasons: string[] }[];
  /** staged mode only. */
  plan?: StagedPlan;
}

/** The built-in routers, registered in preference order. */
export function defaultRegistry(repoRoot: string): EngineRegistry {
  const r = new EngineRegistry();
  r.register(new FreeroutingRouter({ repoRoot }), FREEROUTING_MANIFEST);
  r.register(new KicadToolsRouter({ repoRoot }), KICAD_TOOLS_MANIFEST);
  r.register(new ReferenceRouter(), REFERENCE_ROUTER_MANIFEST);
  return r;
}

export async function routeBoard(opts: RouteOptions): Promise<RouteRun> {
  const log = opts.log ?? (() => {});
  const text = await readFile(opts.boardPath, 'utf8');
  const projectPath = opts.projectPath ?? (existsSync(opts.boardPath.replace(/\.kicad_pcb$/, '.kicad_pro')) ? opts.boardPath.replace(/\.kicad_pcb$/, '.kicad_pro') : undefined);
  const projectText = projectPath ? await readFile(projectPath, 'utf8') : undefined;
  let kicadVersion = 'unknown';
  if (!opts.noKicad) {
    try {
      kicadVersion = await kicadCliVersion();
    } catch {
      kicadVersion = 'unknown';
    }
  }
  const { design, warnings } = importBoard({ boardText: text, boardPath: path.relative(opts.repoRoot, opts.boardPath), ...(projectText ? { projectText, projectPath: path.relative(opts.repoRoot, projectPath!) } : {}), kicadVersion, ...(opts.profile ? { fabricationProfile: opts.profile } : {}) });
  for (const w of warnings) log(`import: ${w}`);
  const profile = loadProfile(design.board.fabricationProfile);
  const scoring = loadScoringProfile(opts.scoring ?? 'default-low-speed-2-layer');
  const netIds = opts.netNames ? design.nets.filter((n) => opts.netNames!.includes(n.name)).map((n) => n.id) : null;
  const snapshot = makeSnapshot(design, { kind: 'routing', netIds, region: null, preserveExistingRoutes: opts.preserveExistingRoutes ?? false }, { seed: opts.seed ?? 0, limits: { ...DEFAULT_LIMITS, ...opts.limits } });
  await mkdir(opts.runDir, { recursive: true });
  const run = await writeRunDir(opts.runDir, snapshot, [opts.boardPath, ...(projectPath ? [projectPath] : [])]);
  const registry = opts.registry ?? defaultRegistry(opts.repoRoot);
  const wanted = opts.routers ?? registry.list('router').map((e) => e.manifest.id);
  const engines = wanted.map((id) => registry.get(id)).filter((e): e is NonNullable<typeof e> => !!e);
  const unknown = wanted.filter((id) => !registry.get(id)).map((engineId) => ({ engineId, reasons: [`not registered (known: ${registry.list('router').map((e) => e.manifest.id).join(', ')})`] }));
  // gate before any engine runs: a board that fails pre-flight or placement is refused, not routed (RFC 11 §10.4)
  const pre = verifyDesign({ design, profile });
  if (!pre.gates.preflight.passed || !pre.gates.placement.passed) {
    const failures = [...pre.gates.preflight.failures, ...pre.gates.placement.failures];
    const outcome: Outcome<Diagnostic> = { status: 'REFUSE', summary: `${pre.gates.preflight.passed ? 'placement' : 'pre-flight'} gate failed before routing: ${[...new Set(failures.map((d) => d.code))].join(', ')}`, detail: failures.map((d) => `${d.code}${d.entityReferences.length ? ` [${d.entityReferences.slice(0, 4).join(', ')}]` : ''}: ${d.message}`), diagnostics: pre.diagnostics.filter((d) => d.severity !== 'info') };
    const ranking: Ranking = rank([], scoring);
    await writeFile(path.join(run.root, 'ranking.json'), JSON.stringify(ranking, null, 2), 'utf8');
    await writeFile(path.join(run.root, 'outcome.json'), JSON.stringify({ ...outcome, diagnostics: outcome.diagnostics.map((d) => ({ code: d.code, severity: d.severity, message: d.message, entityReferences: d.entityReferences })) }, null, 2), 'utf8');
    return { outcome, runDir: run.root, ranking, invocations: [], candidates: [], ineligible: unknown };
  }
  const budget = new Budget(snapshot.limits.engineSeconds, snapshot.limits.wallSeconds);
  const mode = opts.mode ?? 'single';
  const layers = opts.layerPreferences?.length ? Object.fromEntries(opts.layerPreferences.map((p) => [p.layerId, p.mode === 'off' ? { active: false } : p.mode === 'any' ? { active: true } : { active: true, preferredDirection: p.mode }])) : undefined;
  const strategy: RoutingStrategy = { ...(layers ? { layers } : {}), ...(opts.strategy ?? {}) };
  const plan = mode === 'staged' ? defaultStagedPlan(design, { engineIds: engines.map((e) => e.manifest.id), netIds, ...(opts.criticalNetNames ? { criticalNetNames: opts.criticalNetNames } : {}), ...(opts.layerPreferences ? { layerPreferences: opts.layerPreferences } : {}) }) : undefined;
  if (plan) {
    await writeFile(path.join(run.root, 'plan.json'), JSON.stringify(plan, null, 2), 'utf8');
    for (const st of plan.stages) log(`stage ${st.name}: ${st.netIds ? `${st.netIds.length} net(s)` : 'every owed net'} via ${st.engineIds.join(st.race ? ' | ' : ', ')}${st.strategy.trackWidthNm ? ` at ${st.strategy.trackWidthNm / 1e6} mm` : ''}`);
  }
  const res = await runRouting({
    run, sourceText: text, design, ...(projectText ? { projectText } : {}), snapshotFileHash: run.fileHash, snapshot, budget, engines, mode, ...(opts.policy ? { policy: opts.policy } : { policy: DEFAULT_POLICY }), ...(opts.maxParallel ? { maxParallel: opts.maxParallel } : {}),
    job: { scope: { netIds, region: null, preserveExistingRoutes: opts.preserveExistingRoutes ?? false }, strategy: { ...strategy, ...(opts.strategy ?? {}) }, hardConstraints: [], objectives: [], seed: opts.seed ?? 0, limits: snapshot.limits },
    ...(plan ? { stages: plan.stages.map((st) => ({ ...st, strategy: { ...strategy, ...st.strategy } })) } : {}),
    log,
  });
  const candidates: MaterializedCandidate[] = [];
  const scored = [];
  for (const inv of res.invocations) {
    if (!inv.result || inv.snapshotViolation) continue;
    if (inv.result.status === 'failed' || inv.result.status === 'unsupported') continue;
    if (inv.stage && !inv.stage.final) continue; // intermediate stages are not candidates; their copper rides in the final branches
    // a staged branch is the union of the carried stages and its own copper
    const carried = inv.stage?.carried;
    const result: RoutingResult = carried ? { ...inv.result, segments: [...carried.segments, ...inv.result.segments], arcs: [...carried.arcs, ...inv.result.arcs], vias: [...carried.vias, ...inv.result.vias] } : inv.result;
    const preserve = (opts.preserveExistingRoutes ?? false) || !!inv.stage;
    const cand = await materialize(inv, candidateFromRouting(result, preserve, design), { sourceText: text, design, ...(projectText ? { projectText } : {}), profile, kicadVersion, ...(opts.noKicad ? { noKicad: true } : {}) });
    candidates.push(cand);
    const wall = res.invocations.filter((x) => x === inv || (x.stage && !x.stage.final)).reduce((a, x) => a + (x.result?.runtime.wallSeconds ?? 0), 0);
    const metrics = routingMetrics({ design: cand.design, verify: cand.verify, baseline: design, runtimeSeconds: wall });
    await writeFile(path.join(inv.workDir, 'metrics.json'), JSON.stringify(metrics, null, 2), 'utf8');
    const gates = cand.verify.gates;
    scored.push({ id: inv.engineId, metrics, gatesPassed: gates.preflight.passed && gates.routing.passed, gateFailures: [...gates.preflight.failures, ...gates.routing.failures].map((d) => d.code) });
  }
  const ranking = rank(scored, scoring);
  await writeFile(path.join(run.root, 'ranking.json'), JSON.stringify(ranking, null, 2), 'utf8');
  const outcome = outcomeOf(res.invocations, candidates, ranking, [...unknown, ...res.ineligible]);
  await writeFile(path.join(run.root, 'outcome.json'), JSON.stringify({ ...outcome, diagnostics: outcome.diagnostics.map((d) => ({ code: d.code, severity: d.severity, message: d.message, entityReferences: d.entityReferences })) }, null, 2), 'utf8');
  return { outcome, runDir: run.root, ranking, invocations: res.invocations, candidates, ineligible: [...unknown, ...res.ineligible], ...(plan ? { plan } : {}) };
}

function outcomeOf(invocations: Invocation<RoutingResult>[], candidates: MaterializedCandidate[], ranking: Ranking, ineligible: { engineId: string; reasons: string[] }[]): Outcome<Diagnostic> {
  const detail: string[] = [];
  for (const i of ineligible) detail.push(`${i.engineId}: ineligible (${i.reasons.join('; ')})`);
  for (const inv of invocations) {
    if (inv.snapshotViolation) detail.push(`${inv.engineId}: INVALID_OUTPUT, ${inv.snapshotViolation}`);
    else if (inv.error) detail.push(`${inv.engineId}: ${inv.error.kind}: ${inv.error.message}${inv.error.fix ? ` (fix: ${inv.error.fix})` : ''}`);
  }
  const selected = ranking.selected ? candidates.find((c) => c.engineId === ranking.selected) : undefined;
  if (selected) {
    const owed = selected.verify.metrics.unrouted_count ?? 0;
    const status: LayoutStatus = owed === 0 ? 'PASS' : 'PARTIAL';
    if (owed) detail.unshift(`${owed} connection(s) still owed on the selected candidate`);
    for (const c of ranking.candidates) detail.push(`${c.id}: rank ${c.rank}, ${c.reason}`);
    return { status, summary: `${ranking.selected} selected: ${ranking.reason}`, detail, diagnostics: selected.verify.diagnostics.filter((d) => d.severity !== 'info') };
  }
  if (!invocations.length) return { status: 'UNSUPPORTED', summary: 'no eligible routing engine', detail, diagnostics: [] };
  if (invocations.some((i) => i.snapshotViolation)) return { status: 'INVALID_OUTPUT', summary: 'an engine modified its input snapshot', detail, diagnostics: [] };
  if (invocations.every((i) => i.error?.kind === 'timeout')) return { status: 'TIMEOUT', summary: 'every engine ran out of budget', detail, diagnostics: [] };
  if (invocations.every((i) => i.error)) return { status: 'ENGINE_ERROR', summary: `no engine produced a candidate (${invocations.map((i) => `${i.engineId}: ${i.error!.kind}`).join(', ')})`, detail, diagnostics: [] };
  // candidates exist but none passed the gates
  const worst = candidates[0];
  for (const c of ranking.candidates) detail.push(`${c.id}: ${c.reason}`);
  return { status: 'PARTIAL', summary: 'every candidate failed a hard gate; the placed board is unchanged', detail, diagnostics: worst ? worst.verify.diagnostics.filter((d) => d.severity === 'error') : [] };
}
