/**
 * Placement orchestration (RFC 11 §8, Phase 3): import, snapshot with the
 * movable set, run the eligible placers, materialize and verify every
 * candidate (ripping up copper the moved parts invalidated), measure, probe
 * routability when asked, rank under the placement profile, and end in one
 * Outcome. LLM-free and network-free.
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
import { placementMetrics } from '../verify/metrics.js';
import { rank, type Ranking } from '../verify/scoring.js';
import { verifyDesign } from '../verify/index.js';
import type { Diagnostic } from '../verify/diagnostic.js';
import { EngineRegistry, DEFAULT_POLICY, type EnginePolicy } from './registry.js';
import { runPlacement, type ExecutionMode, type Invocation } from './runner.js';
import { Budget } from './budget.js';
import { materialize, type MaterializedCandidate } from './candidates.js';
import type { PlacementResult } from './contracts.js';
import { routabilityProbe } from './probe.js';
import { defaultRegistry as defaultRouterRegistry } from './route.js';
import { FixedPlacer, FIXED_PLACER_MANIFEST } from './placers/fixed/adapter.js';
import { ReferencePlacer, REFERENCE_PLACER_MANIFEST } from './placers/reference/adapter.js';
import { PyplacerPlacer, PYPLACER_MANIFEST } from './placers/pyplacer/adapter.js';
import { KicadToolsPlacer, KCT_PHYSICS_MANIFEST, KCT_EVOLUTIONARY_MANIFEST } from './placers/kicad-tools/adapter.js';
import { AnchorsPlacer, ANCHORS_PLACER_MANIFEST } from './placers/anchors/adapter.js';
import { AttachPlacer, ATTACH_PLACER_MANIFEST, type AttachedConstraint } from './placers/attach/adapter.js';
import type { LayoutBlockSpec } from './placers/layout-reuse/adapter.js';
import { applyCandidate } from '../ir/kicad/export.js';
import type { Block } from '../intent/blocks.js';

export interface PlaceOptions {
  repoRoot: string;
  boardPath: string;
  projectPath?: string;
  runDir: string;
  /** Engine ids in preference order; default: every registered placer. */
  placers?: string[];
  mode?: Exclude<ExecutionMode, 'staged'>;
  /** Refdes to move; default: every component not locked in KiCad. */
  movableReferences?: string[];
  seed?: number;
  limits?: Partial<ResourceLimits>;
  profile?: string;
  scoring?: string;
  policy?: EnginePolicy;
  maxParallel?: number;
  registry?: EngineRegistry;
  noKicad?: boolean;
  /** Routability probe per candidate (spec §5.3); false to skip. */
  probe?: { routerId?: string; budgetSeconds?: number; registry?: EngineRegistry } | false;
  /**
   * Functional blocks: turns the run into the staged plan (RFC 11 §8.5): locked
   * parts stay, each block's anchor is placed at its region centroid first and
   * locked, then the wrapped placers place the remainder.
   */
  blocks?: Block[];
  /** Stage 3 inputs: reference blocks to copy around their anchors, and single attachments (`relative.attached`). */
  reuse?: LayoutBlockSpec[];
  attached?: Omit<AttachedConstraint, 'kind'>[];
  log?: (line: string) => void;
}

export interface PlacementPlan {
  stages: { name: string; engineId: string; componentIds: string[] }[];
  blocks: Block[];
}

export interface PlaceRun {
  outcome: Outcome<Diagnostic>;
  runDir: string;
  ranking: Ranking;
  invocations: Invocation<PlacementResult>[];
  candidates: MaterializedCandidate[];
  ineligible: { engineId: string; reasons: string[] }[];
  movableIds: string[];
  plan?: PlacementPlan;
}

/** The built-in placers, in preference order: kct physics, pyplacer, kct evolutionary, the fixed control, the harness reference. */
export function defaultPlacerRegistry(repoRoot: string): EngineRegistry {
  const r = new EngineRegistry();
  r.register(new KicadToolsPlacer('force-directed', { repoRoot }), KCT_PHYSICS_MANIFEST);
  r.register(new PyplacerPlacer(), PYPLACER_MANIFEST);
  r.register(new KicadToolsPlacer('evolutionary', { repoRoot }), KCT_EVOLUTIONARY_MANIFEST);
  r.register(new FixedPlacer(), FIXED_PLACER_MANIFEST);
  r.register(new ReferencePlacer(), REFERENCE_PLACER_MANIFEST);
  return r;
}

export async function placeBoard(opts: PlaceOptions): Promise<PlaceRun> {
  const log = opts.log ?? (() => {});
  const projectPath = opts.projectPath ?? (existsSync(opts.boardPath.replace(/\.kicad_pcb$/, '.kicad_pro')) ? opts.boardPath.replace(/\.kicad_pcb$/, '.kicad_pro') : undefined);
  const projectText = projectPath ? await readFile(projectPath, 'utf8') : undefined;
  let text = await readFile(opts.boardPath, 'utf8');
  let kicadVersion = 'unknown';
  if (!opts.noKicad) {
    try {
      kicadVersion = await kicadCliVersion();
    } catch {
      kicadVersion = 'unknown';
    }
  }
  const imported = importBoard({ boardText: text, boardPath: path.relative(opts.repoRoot, opts.boardPath), ...(projectText ? { projectText, projectPath: path.relative(opts.repoRoot, projectPath!) } : {}), kicadVersion, ...(opts.profile ? { fabricationProfile: opts.profile } : {}) });
  for (const w of imported.warnings) log(`import: ${w}`);
  const profile = loadProfile(imported.design.board.fabricationProfile);
  const scoring = loadScoringProfile(opts.scoring ?? 'default-placement-2-layer');
  const wantedRefs = opts.movableReferences ? new Set(opts.movableReferences) : null;
  let design = imported.design;
  let movableIds = design.components.filter((c) => !c.attributes.locked && (!wantedRefs || wantedRefs.has(c.reference))).map((c) => c.id);
  await mkdir(opts.runDir, { recursive: true });
  let plan: PlacementPlan | undefined;
  if (opts.blocks?.length || opts.reuse?.length || opts.attached?.length) {
    // staged plan, stages 1 to 3: locked parts stay; anchors go to their region centroids and are locked for the wrapped placer
    const lockedIds = design.components.filter((c) => c.attributes.locked).map((c) => c.id);
    const anchorsPlacer = new AnchorsPlacer();
    const preSnapshot = makeSnapshot(design, { kind: 'placement', movableComponentIds: movableIds }, { seed: opts.seed ?? 0, limits: { ...DEFAULT_LIMITS, ...opts.limits } });
    const anchors = await anchorsPlacer.place({ runId: 'anchors', snapshot: preSnapshot, movableComponentIds: movableIds, constraints: (opts.blocks ?? []).map((block) => ({ kind: 'functional.group', block })), objectives: [], seed: opts.seed ?? 0, limits: preSnapshot.limits }, { workDir: opts.runDir, boardPath: opts.boardPath, log });
    if (anchors.placements.length) {
      text = applyCandidate(text, design, { placement: anchors.placements }).text;
      design = importBoard({ boardText: text, boardPath: path.relative(opts.repoRoot, opts.boardPath), ...(projectText ? { projectText, projectPath: path.relative(opts.repoRoot, projectPath!) } : {}), kicadVersion, ...(opts.profile ? { fabricationProfile: opts.profile } : {}) }).design;
    }
    const anchorIds = new Set(anchors.placements.map((p) => p.id));
    movableIds = movableIds.filter((id) => !anchorIds.has(id));
    // stage 3: reference blocks around their anchors and single attachments, then locked like the anchors
    let attachedIds = new Set<string>();
    if (opts.reuse?.length || opts.attached?.length) {
      const stageSnapshot = makeSnapshot(design, { kind: 'placement', movableComponentIds: movableIds }, { seed: opts.seed ?? 0, limits: { ...DEFAULT_LIMITS, ...opts.limits } });
      const constraints = [...(opts.reuse ?? []).map((spec) => ({ kind: 'layout.reuse', spec })), ...(opts.attached ?? []).map((a) => ({ kind: 'relative.attached' as const, ...a }))];
      const attach = await new AttachPlacer().place({ runId: 'attach', snapshot: stageSnapshot, movableComponentIds: movableIds, constraints, objectives: [], seed: opts.seed ?? 0, limits: stageSnapshot.limits }, { workDir: opts.runDir, boardPath: opts.boardPath, log });
      if (attach.placements.length) {
        text = applyCandidate(text, design, { placement: attach.placements }).text;
        design = importBoard({ boardText: text, boardPath: path.relative(opts.repoRoot, opts.boardPath), ...(projectText ? { projectText, projectPath: path.relative(opts.repoRoot, projectPath!) } : {}), kicadVersion, ...(opts.profile ? { fabricationProfile: opts.profile } : {}) }).design;
      }
      attachedIds = new Set(attach.placements.map((p) => p.id));
      // the parts they were placed against must not move either, or the bulk placer breaks the relation
      const byRef = new Map(design.components.map((c) => [c.reference, c.id]));
      for (const spec of opts.reuse ?? []) if (byRef.has(spec.anchor) && attach.placements.length) attachedIds.add(byRef.get(spec.anchor)!);
      for (const a of opts.attached ?? []) {
        const target = byRef.get(a.to.split('.')[0]!);
        if (target && attach.placements.some((p) => p.id === byRef.get(a.ref))) attachedIds.add(target);
      }
      movableIds = movableIds.filter((id) => !attachedIds.has(id));
    }
    plan = { stages: [{ name: 'fixed', engineId: 'placer-fixed', componentIds: lockedIds }, { name: 'anchors', engineId: ANCHORS_PLACER_MANIFEST.id, componentIds: [...anchorIds] }, { name: 'attach', engineId: ATTACH_PLACER_MANIFEST.id, componentIds: [...attachedIds] }, { name: 'bulk', engineId: (opts.placers ?? ['*']).join('|'), componentIds: movableIds }], blocks: opts.blocks ?? [] };
    await writeFile(path.join(opts.runDir, 'plan.json'), JSON.stringify(plan, null, 2), 'utf8');
    log(`staged plan: ${anchorIds.size} anchor(s) at their region centroids, ${attachedIds.size} part(s) attached or reused, ${movableIds.length} part(s) left to the placers`);
  }
  const snapshot = makeSnapshot(design, { kind: 'placement', movableComponentIds: movableIds }, { seed: opts.seed ?? 0, limits: { ...DEFAULT_LIMITS, ...opts.limits } });
  const run = await writeRunDir(opts.runDir, snapshot, [opts.boardPath, ...(projectPath ? [projectPath] : [])]);
  const registry = opts.registry ?? defaultPlacerRegistry(opts.repoRoot);
  const wanted = opts.placers ?? registry.list('placer').map((e) => e.manifest.id);
  const engines = wanted.map((id) => registry.get(id)).filter((e): e is NonNullable<typeof e> => !!e);
  const unknown = wanted.filter((id) => !registry.get(id)).map((engineId) => ({ engineId, reasons: [`not registered (known: ${registry.list('placer').map((e) => e.manifest.id).join(', ')})`] }));
  // pre-flight gates before any engine runs; the placement gate is what placement is for, so it does not block here
  const pre = verifyDesign({ design, profile });
  if (!pre.gates.preflight.passed) {
    const failures = pre.gates.preflight.failures;
    const outcome: Outcome<Diagnostic> = { status: 'REFUSE', summary: `pre-flight gate failed before placement: ${[...new Set(failures.map((d) => d.code))].join(', ')}`, detail: failures.map((d) => `${d.code}${d.entityReferences.length ? ` [${d.entityReferences.slice(0, 4).join(', ')}]` : ''}: ${d.message}`), diagnostics: pre.diagnostics.filter((d) => d.severity !== 'info') };
    const ranking = rank([], scoring);
    await writeFile(path.join(run.root, 'ranking.json'), JSON.stringify(ranking, null, 2), 'utf8');
    await writeFile(path.join(run.root, 'outcome.json'), JSON.stringify(slim(outcome), null, 2), 'utf8');
    return { outcome, runDir: run.root, ranking, invocations: [], candidates: [], ineligible: unknown, movableIds, ...(plan ? { plan } : {}) };
  }
  const budget = new Budget(snapshot.limits.engineSeconds, snapshot.limits.wallSeconds);
  const res = await runPlacement({
    run, sourceText: text, design, ...(projectText ? { projectText } : {}), snapshotFileHash: run.fileHash, snapshot, budget, engines, mode: opts.mode ?? 'single', policy: opts.policy ?? DEFAULT_POLICY, ...(opts.maxParallel ? { maxParallel: opts.maxParallel } : {}),
    job: { movableComponentIds: movableIds, constraints: (opts.blocks ?? []).map((block) => ({ kind: 'functional.group', block })), objectives: [], seed: opts.seed ?? 0, limits: snapshot.limits },
    log,
  });
  const hasCopper = design.routing.segments.length + design.routing.arcs.length + design.routing.vias.length > 0;
  const candidates: MaterializedCandidate[] = [];
  const scored = [];
  for (const inv of res.invocations) {
    if (!inv.result || inv.snapshotViolation) continue;
    if (inv.result.status === 'failed' || inv.result.status === 'unsupported') continue;
    const before = new Map(design.components.map((c) => [c.id, c]));
    const moved = inv.result.placements.some((p) => {
      const c = before.get(p.id);
      return !c || c.at.x !== p.at.x || c.at.y !== p.at.y || c.rotation !== p.rotation || c.attributes.side !== p.side;
    });
    // copper routed to the old positions is invalid once a part moves: rip it up, keep the zones
    const candidate = { placement: inv.result.placements, ...(hasCopper && moved ? { routing: { segments: [], arcs: [], vias: [], preserveIds: new Set<string>() } } : {}) };
    const cand = await materialize(inv, candidate, { sourceText: text, design, ...(projectText ? { projectText } : {}), profile, kicadVersion, ...(opts.noKicad ? { noKicad: true } : {}) });
    candidates.push(cand);
    const metrics: Record<string, number> = { ...placementMetrics({ design: cand.design, verify: cand.verify, runtimeSeconds: inv.result.runtime.wallSeconds }), unplaced_count: inv.result.unplacedComponentIds.length, refused_count: cand.refused.length };
    if (opts.probe !== false && cand.verify.gates.placement.passed) {
      try {
        const p = await routabilityProbe({ repoRoot: opts.repoRoot, pcbPath: cand.pcbPath, workDir: inv.workDir, ...(opts.probe?.routerId ? { routerId: opts.probe.routerId } : {}), ...(opts.probe?.budgetSeconds ? { budgetSeconds: opts.probe.budgetSeconds } : {}), registry: opts.probe?.registry ?? defaultRouterRegistry(opts.repoRoot), policy: opts.policy ?? DEFAULT_POLICY, ...(opts.noKicad ? { noKicad: true } : {}), log: (l) => log(`  probe: ${l}`) });
        metrics.routability_completion = p.routability_completion;
        metrics.routability_drc_errors = p.routability_drc_errors;
      } catch (err) {
        log(`probe failed on ${inv.engineId}: ${(err as Error).message}`);
      }
    }
    await writeFile(path.join(inv.workDir, 'metrics.json'), JSON.stringify(metrics, null, 2), 'utf8');
    const gates = cand.verify.gates;
    scored.push({ id: inv.engineId, metrics, gatesPassed: gates.preflight.passed && gates.placement.passed && cand.refused.length === 0 && inv.result.unplacedComponentIds.length === 0, gateFailures: [...gates.preflight.failures, ...gates.placement.failures].map((d) => d.code).concat(cand.refused.length ? ['export.refused'] : [], inv.result.unplacedComponentIds.length ? ['placement.unplaced'] : []) });
  }
  const ranking = rank(scored, scoring);
  await writeFile(path.join(run.root, 'ranking.json'), JSON.stringify(ranking, null, 2), 'utf8');
  const outcome = outcomeOf(res.invocations, candidates, ranking, [...unknown, ...res.ineligible]);
  await writeFile(path.join(run.root, 'outcome.json'), JSON.stringify(slim(outcome), null, 2), 'utf8');
  return { outcome, runDir: run.root, ranking, invocations: res.invocations, candidates, ineligible: [...unknown, ...res.ineligible], movableIds, ...(plan ? { plan } : {}) };
}

function slim(o: Outcome<Diagnostic>): unknown {
  return { ...o, diagnostics: o.diagnostics.map((d) => ({ code: d.code, severity: d.severity, message: d.message, entityReferences: d.entityReferences })) };
}

function outcomeOf(invocations: Invocation<PlacementResult>[], candidates: MaterializedCandidate[], ranking: Ranking, ineligible: { engineId: string; reasons: string[] }[]): Outcome<Diagnostic> {
  const detail: string[] = [];
  for (const i of ineligible) detail.push(`${i.engineId}: ineligible (${i.reasons.join('; ')})`);
  for (const inv of invocations) {
    if (inv.snapshotViolation) detail.push(`${inv.engineId}: INVALID_OUTPUT, ${inv.snapshotViolation}`);
    else if (inv.error) detail.push(`${inv.engineId}: ${inv.error.kind}: ${inv.error.message}${inv.error.fix ? ` (fix: ${inv.error.fix})` : ''}`);
    else if (inv.result && (inv.result.status === 'failed' || inv.result.status === 'unsupported')) detail.push(`${inv.engineId}: ${inv.result.status}${inv.result.diagnostics[0] ? `: ${inv.result.diagnostics[0].message}` : ' (no placement, no explanation from the engine)'}`);
  }
  const selected = ranking.selected ? candidates.find((c) => c.engineId === ranking.selected) : undefined;
  if (selected) {
    const inv = invocations.find((i) => i.engineId === ranking.selected);
    const unplaced = inv?.result?.unplacedComponentIds.length ?? 0;
    const status: LayoutStatus = unplaced === 0 ? 'PASS' : 'PARTIAL';
    if (unplaced) detail.unshift(`${unplaced} component(s) left unplaced by the selected candidate`);
    for (const c of ranking.candidates) detail.push(`${c.id}: rank ${c.rank}, ${c.reason}`);
    return { status, summary: `${ranking.selected} selected: ${ranking.reason}`, detail, diagnostics: selected.verify.diagnostics.filter((d) => d.severity !== 'info') };
  }
  if (!invocations.length) return { status: 'UNSUPPORTED', summary: 'no eligible placement engine', detail, diagnostics: [] };
  if (invocations.some((i) => i.snapshotViolation)) return { status: 'INVALID_OUTPUT', summary: 'an engine modified its input snapshot', detail, diagnostics: [] };
  if (invocations.every((i) => i.error?.kind === 'timeout')) return { status: 'TIMEOUT', summary: 'every engine ran out of budget', detail, diagnostics: [] };
  if (invocations.every((i) => i.error && (i.error.kind === 'no-binary' || i.error.kind === 'no-runtime' || i.error.kind === 'runtime-too-old'))) {
    return { status: 'UNSUPPORTED', summary: `no placement engine is installed (${invocations.map((i) => `${i.engineId}: ${i.error!.kind}`).join(', ')})`, detail, diagnostics: [] };
  }
  if (invocations.every((i) => i.error)) return { status: 'ENGINE_ERROR', summary: `no engine produced a candidate (${invocations.map((i) => `${i.engineId}: ${i.error!.kind}`).join(', ')})`, detail, diagnostics: [] };
  const worst = candidates[0];
  for (const c of ranking.candidates) detail.push(`${c.id}: ${c.reason}`);
  return { status: 'PARTIAL', summary: 'every candidate failed a hard gate; the board is unchanged', detail, diagnostics: worst ? worst.verify.diagnostics.filter((d) => d.severity === 'error') : [] };
}
