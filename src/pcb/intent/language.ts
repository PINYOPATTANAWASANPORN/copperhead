/**
 * The intent language (RFC 11 §7.3, implementation spec §7.3): the YAML a
 * user or the compiler writes, addressed by refdes, turned into registry
 * entries with the layout fields. Unknown keys are reported, not ignored:
 * the caller turns them into HOLD.
 */
import { parse as parseYaml } from 'yaml';
import type { Constraint } from '../../memory/constraints.js';

export interface IntentEntry extends Constraint {
  key: string;
}

export interface ParsedIntent {
  entries: IntentEntry[];
  /** Keys the language does not define; the run holds on them. */
  unknown: string[];
  /** Entries that could not be formed (missing fields), with the reason. */
  errors: string[];
}

const EDGES = ['north', 'south', 'east', 'west'];
const mm = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1e6) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null);
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => str(x)).filter((x): x is string => !!x) : []);

export function parseIntent(text: string, source = 'intent'): ParsedIntent {
  const doc = (parseYaml(text) ?? {}) as Record<string, unknown>;
  const entries: IntentEntry[] = [];
  const unknown: string[] = [];
  const errors: string[] = [];
  const base = (cls: Constraint['class'], severity: Constraint['severity'], refs: string[], parameters: Constraint['parameters'], priority = 50): Omit<Constraint, 'source' | 'affects'> => ({ class: cls, severity, scope: { refs }, parameters: parameters ?? {}, priority, confidence: 1, approvedBy: 'user' });
  const push = (key: string, c: Omit<Constraint, 'source' | 'affects'>) => entries.push({ key, source, affects: ['board'], ...c });
  for (const top of Object.keys(doc)) if (!['placement', 'routing'].includes(top)) unknown.push(top);
  const placement = (doc.placement ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(placement)) if (!['fixed', 'attachments', 'groups', 'separation', 'keepouts'].includes(k)) unknown.push(`placement.${k}`);
  for (const [i, f] of ((placement.fixed as unknown[]) ?? []).entries()) {
    const o = (f ?? {}) as Record<string, unknown>;
    const ref = str(o.component);
    if (!ref) {
      errors.push(`placement.fixed[${i}]: no component`);
      continue;
    }
    for (const k of Object.keys(o)) if (!['component', 'edge', 'orientation', 'at', 'rotation_deg'].includes(k)) unknown.push(`placement.fixed[${i}].${k}`);
    if (o.edge !== undefined) {
      const edge = str(o.edge);
      if (!edge || !EDGES.includes(edge)) {
        errors.push(`placement.fixed[${i}]: edge must be one of ${EDGES.join(', ')}`);
        continue;
      }
      const orientation = str(o.orientation);
      push(`layout.mechanical.edge.${ref}`, base('mechanical', 'hard', [ref], { edge, ...(orientation ? { orientation } : {}) }, 90));
    }
    if (Array.isArray(o.at) && o.at.length === 2) {
      const x = mm(o.at[0]), y = mm(o.at[1]);
      if (x === null || y === null) {
        errors.push(`placement.fixed[${i}]: at must be [x_mm, y_mm]`);
        continue;
      }
      push(`layout.mechanical.fixed.${ref}`, base('mechanical', 'hard', [ref], { x_nm: x, y_nm: y, ...(typeof o.rotation_deg === 'number' ? { rotation_mdeg: Math.round(o.rotation_deg * 1000) } : {}) }, 100));
    }
    if (o.edge === undefined && o.at === undefined) errors.push(`placement.fixed[${i}]: ${ref} needs an edge or an at`);
  }
  for (const [i, a] of ((placement.attachments as unknown[]) ?? []).entries()) {
    const o = (a ?? {}) as Record<string, unknown>;
    const ref = str(o.component);
    const target = (o.target ?? {}) as Record<string, unknown>;
    const to = str(target.component);
    const max = mm(o.max_distance_mm);
    if (!ref || !to || max === null) {
      errors.push(`placement.attachments[${i}]: needs component, target.component, and max_distance_mm`);
      continue;
    }
    for (const k of Object.keys(o)) if (!['component', 'target', 'max_distance_mm', 'priority'].includes(k)) unknown.push(`placement.attachments[${i}].${k}`);
    const priority = str(o.priority) ?? 'normal';
    push(`layout.relative.attached.${ref}`, base('relative', priority === 'critical' ? 'hard' : 'soft', [ref, to], { target: to, pins: list(target.pins), max_distance_nm: max, priority }, priority === 'critical' ? 80 : 40));
  }
  for (const [i, g] of ((placement.groups as unknown[]) ?? []).entries()) {
    const o = (g ?? {}) as Record<string, unknown>;
    const id = str(o.id);
    const members = list(o.components);
    if (!id || !members.length) {
      errors.push(`placement.groups[${i}]: needs id and components`);
      continue;
    }
    for (const k of Object.keys(o)) if (!['id', 'components', 'topology', 'max_spread_mm'].includes(k)) unknown.push(`placement.groups[${i}].${k}`);
    const spread = mm(o.max_spread_mm);
    push(`layout.functional.group.${id}`, base('functional', 'soft', members, { members, ...(str(o.topology) ? { topology: str(o.topology)! } : {}), ...(spread !== null ? { spread_budget_nm: spread } : {}) }));
  }
  for (const [i, s] of ((placement.separation as unknown[]) ?? []).entries()) {
    const o = (s ?? {}) as Record<string, unknown>;
    const groups = list(o.groups);
    const min = mm(o.minimum_mm);
    if (groups.length !== 2 || min === null) {
      errors.push(`placement.separation[${i}]: needs two groups and minimum_mm`);
      continue;
    }
    push(`layout.functional.separation.${groups[0]}-${groups[1]}`, base('functional', 'hard', [], { groups, min_nm: min }, 60));
  }
  for (const [i, k] of ((placement.keepouts as unknown[]) ?? []).entries()) {
    const o = (k ?? {}) as Record<string, unknown>;
    const region = str(o.region);
    if (!region) {
      errors.push(`placement.keepouts[${i}]: needs region`);
      continue;
    }
    const radius = mm(o.radius_mm);
    push(`layout.manufacturing.keepout.${region}`, base('manufacturing', 'hard', [], { region, prohibit: list(o.prohibit).length ? list(o.prohibit) : ['components', 'copper'], ...(radius !== null ? { radius_nm: radius } : {}) }, 90));
  }
  const routing = (doc.routing ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(routing)) if (!['priorities', 'layers', 'widths', 'currents'].includes(k)) unknown.push(`routing.${k}`);
  for (const [i, w] of ((routing.widths as unknown[]) ?? []).entries()) {
    const o = (w ?? {}) as Record<string, unknown>;
    const net = str(o.net);
    const min = mm(o.min_width_mm);
    if (!net || min === null) {
      errors.push(`routing.widths[${i}]: needs net and min_width_mm`);
      continue;
    }
    push(`layout.routing.width.${net}`, base('routing', 'hard', [], { min_width_nm: min, net }, 70));
    entries[entries.length - 1]!.scope = { nets: [net] };
  }
  for (const [i, c] of ((routing.currents as unknown[]) ?? []).entries()) {
    const o = (c ?? {}) as Record<string, unknown>;
    const net = str(o.net);
    const amps = typeof o.amps === 'number' ? o.amps : null;
    if (!net || amps === null) {
      errors.push(`routing.currents[${i}]: needs net and amps`);
      continue;
    }
    // the physics compiler turns this into a width; kept as a requirement so the report can cite it
    push(`layout.electrical-layout.current.${net}`, base('electrical-layout', 'hard', [], { amps, net, ...(typeof o.rise_c === 'number' ? { rise_c: o.rise_c } : {}) }, 70));
    entries[entries.length - 1]!.scope = { nets: [net] };
  }
  if (Array.isArray(routing.priorities)) {
    const order = (routing.priorities as unknown[]).map((tier) => list(tier));
    push('layout.routing.priority', base('routing', 'soft', order.flat().filter((n) => n !== 'remaining'), { order: JSON.stringify(order) }));
  }
  return { entries, unknown: [...new Set(unknown)], errors };
}

export function intentToRegistry(parsed: ParsedIntent): Record<string, Constraint> {
  const out: Record<string, Constraint> = {};
  for (const { key, ...c } of parsed.entries) out[key] = c;
  return out;
}
