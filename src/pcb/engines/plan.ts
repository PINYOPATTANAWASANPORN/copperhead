/**
 * Default staged routing plan (RFC 11 §9.5, implementation spec §6.5):
 * power and ground first at their class widths with pours preserved, the
 * critical nets next, then the bulk by race. Layer-preference constraints
 * become per-layer engine settings (Freerouting `autoroute_settings`).
 * Pure: reads the design, returns a plan; it never runs an engine.
 */
import type { PcbDesign, NetDefinition } from '../ir/types.js';
import type { RoutingStrategy, LayerStrategy } from './contracts.js';

export interface RoutingStage {
  name: string;
  /** Engines to try, in preference order; with `race` every one runs and the best branch wins. */
  engineIds: string[];
  /** null = every net still owed. */
  netIds: string[] | null;
  strategy: RoutingStrategy;
  race: boolean;
}

export interface StagedPlan {
  stages: RoutingStage[];
  /** Why each net landed where it did (for the run record). */
  classification: { power: string[]; critical: string[]; bulk: string[] };
}

export interface LayerPreference {
  layerId: string;
  /** off = the layer is not used for new tracks. */
  mode: 'horizontal' | 'vertical' | 'any' | 'off';
}

export interface PlanOptions {
  engineIds: string[];
  /** The board's clearance rule; with it the bulk stage routes generous first (1.5x, at most 0.5 mm) and re-routes what is owed at the rule. */
  clearanceNm?: number;
  /** Turn the generous-first pass off. */
  noGenerous?: boolean;
  /** Nets the intent (or the user) marked critical, by name. */
  criticalNetNames?: string[];
  layerPreferences?: LayerPreference[];
  /** Nets in scope (null = all). */
  netIds?: string[] | null;
}

const POWER_NAME = /^(A|D|P|S)?GND\w*$|^V(CC|DD|SS|EE|BUS|IN|OUT|BAT|REF|DDA|DDIO|SYS|PP)\w*$|^[+-]?\d+(?:[.V]\d+)?V\d*$|^\d+V\d*$|^VCC$|^VDD$/i;
const POWER_CLASS = /power|pwr|gnd|ground/i;

/** A net is power/ground when its class says so, its name says so, or a copper pour carries it. */
export function isPowerNet(net: NetDefinition, design: PcbDesign): boolean {
  if (POWER_CLASS.test(net.netClass)) return true;
  if (POWER_NAME.test(net.name)) return true;
  return design.routing.zones.some((z) => z.netId === net.id);
}

export function layerStrategy(prefs: LayerPreference[] | undefined): Record<string, LayerStrategy> | undefined {
  if (!prefs?.length) return undefined;
  const out: Record<string, LayerStrategy> = {};
  for (const p of prefs) {
    out[p.layerId] = p.mode === 'off' ? { active: false } : p.mode === 'any' ? { active: true } : { active: true, preferredDirection: p.mode };
  }
  return out;
}

export function defaultStagedPlan(design: PcbDesign, opts: PlanOptions): StagedPlan {
  const inScope = design.nets.filter((n) => n.padIds.length >= 2 && (!opts.netIds || opts.netIds.includes(n.id)));
  const critical = new Set(opts.criticalNetNames ?? []);
  const power: string[] = [];
  const crit: string[] = [];
  const bulk: string[] = [];
  for (const n of inScope) {
    if (isPowerNet(n, design)) power.push(n.id);
    else if (critical.has(n.name)) crit.push(n.id);
    else bulk.push(n.id);
  }
  const layers = layerStrategy(opts.layerPreferences);
  const base: RoutingStrategy = layers ? { layers } : {};
  // margin costs nothing where there is room: every stage but the last routes at 1.5x the rule (at most 0.5 mm);
  // the last stage routes whatever is still owed at the rule itself
  const generous = opts.clearanceNm && !opts.noGenerous ? Math.min(Math.round(opts.clearanceNm * 1.5), Math.max(opts.clearanceNm, 500_000)) : null;
  const roomy: RoutingStrategy = generous && generous > (opts.clearanceNm ?? 0) ? { ...base, clearanceNm: generous } : base;
  const stages: RoutingStage[] = [];
  const first = opts.engineIds.slice(0, 1);
  if (power.length) {
    // width: the widest class among the power nets (physics-compiler or user classes land in netClasses)
    const widths = power.map((id) => design.board.rules.netClasses[design.nets.find((n) => n.id === id)!.netClass]?.trackWidthNm).filter((w): w is number => typeof w === 'number');
    const trackWidthNm = widths.length ? Math.max(...widths) : undefined;
    stages.push({ name: 'power', engineIds: first, netIds: power, strategy: { ...roomy, ...(trackWidthNm ? { trackWidthNm } : {}) }, race: false });
  }
  if (crit.length) stages.push({ name: 'critical', engineIds: first, netIds: crit, strategy: roomy, race: false });
  if (bulk.length || !stages.length) {
    if (roomy !== base) stages.push({ name: 'bulk-generous', engineIds: opts.engineIds, netIds: null, strategy: roomy, race: opts.engineIds.length > 1 });
    stages.push({ name: 'bulk', engineIds: opts.engineIds, netIds: null, strategy: base, race: opts.engineIds.length > 1 });
  }
  return { stages, classification: { power, critical: crit, bulk } };
}
