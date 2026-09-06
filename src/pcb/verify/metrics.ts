/**
 * Candidate metrics (RFC 11 §11.1, §11.2; ADR 0001). The PCBWorld-protocol
 * values (`pcbworld.*`) follow the paper's definitions: clean pass, routability
 * over owed connections, DRV count (errors only), wirelength, via count, time.
 * Potential Gain is not computed (it is a function of PCBWorld's reward
 * code). The rest are copperhead's own.
 */
import type { PcbDesign } from '../ir/types.js';
import type { VerifyResult } from './index.js';

export interface RoutingMetricsInput {
  design: PcbDesign;
  verify: VerifyResult;
  /** The design before routing, for the owed-connection baseline. */
  baseline?: PcbDesign;
  runtimeSeconds?: number;
  peakMemoryMb?: number;
}

const len = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(b.x - a.x, b.y - a.y);

/** Owed connections of a design with no copper: Σ (pads − 1) over nets with ≥ 2 pads. */
export function owedBaseline(design: PcbDesign): number {
  return design.nets.reduce((s, n) => s + Math.max(0, n.padIds.length - 1), 0);
}

export function routingMetrics(input: RoutingMetricsInput): Record<string, number> {
  const { design, verify } = input;
  const m = verify.metrics;
  let wirelength = 0;
  for (const s of design.routing.segments) wirelength += len(s.a, s.b);
  for (const a of design.routing.arcs) wirelength += len(a.a, a.mid) + len(a.mid, a.b);
  // bends and acute angles: consecutive segments of one net sharing an endpoint
  let bends = 0;
  let acute = 0;
  const byNet = new Map<string, typeof design.routing.segments>();
  for (const s of design.routing.segments) {
    if (!byNet.has(s.netId)) byNet.set(s.netId, []);
    byNet.get(s.netId)!.push(s);
  }
  for (const segs of byNet.values()) {
    const key = (p: { x: number; y: number }) => `${p.x},${p.y}`;
    const ends = new Map<string, { dx: number; dy: number }[]>();
    for (const s of segs) {
      const d = { dx: s.b.x - s.a.x, dy: s.b.y - s.a.y };
      for (const [p, dir] of [[s.a, d], [s.b, { dx: -d.dx, dy: -d.dy }]] as const) {
        const k = key(p);
        if (!ends.has(k)) ends.set(k, []);
        ends.get(k)!.push(dir);
      }
    }
    for (const dirs of ends.values()) {
      if (dirs.length !== 2) continue;
      const [u, v] = dirs as [{ dx: number; dy: number }, { dx: number; dy: number }];
      const dot = u.dx * v.dx + u.dy * v.dy;
      const cos = dot / (Math.hypot(u.dx, u.dy) * Math.hypot(v.dx, v.dy) || 1);
      // straight-through means opposite directions at the shared point (cos = -1)
      if (cos > -0.999) bends++;
      if (cos > 0.001) acute++; // the two outgoing directions form an angle under 90 degrees
    }
  }
  const owed0 = input.baseline ? owedBaseline(input.baseline) : owedBaseline(design);
  const owed = m.unrouted_count ?? 0;
  const drcCritical = m.drc_critical_count ?? 0;
  const drcErrors = m.drc_error_count ?? 0;
  const out: Record<string, number> = {
    completion_rate: m.completion_rate ?? 0,
    unrouted_count: owed,
    shorts: m.shorts ?? 0,
    drc_error_count: drcErrors,
    drc_critical_count: drcCritical,
    drc_warning_count: m.drc_warning_count ?? 0,
    total_wirelength_nm: Math.round(wirelength),
    via_count: design.routing.vias.length,
    bend_count: bends,
    acute_angle_count: acute,
    layer_transition_count: design.routing.vias.length,
    runtime_s: input.runtimeSeconds ?? 0,
    peak_memory_mb: input.peakMemoryMb ?? 0,
    'pcbworld.clean_pass': owed === 0 && drcErrors === 0 && (m.shorts ?? 0) === 0 ? 1 : 0,
    'pcbworld.routability': owed0 ? Math.max(0, (owed0 - owed) / owed0) : 1,
    'pcbworld.drv': drcErrors,
    'pcbworld.wirelength_mm': Math.round(wirelength / 1e4) / 100,
    'pcbworld.via_count': design.routing.vias.length,
    'pcbworld.time_s': input.runtimeSeconds ?? 0,
  };
  for (const [k, v] of Object.entries(m)) if (k.startsWith('pour_') || k.startsWith('bottom_') || k === 'stitching_vias_per_connector' || k === 'congestion_overflow') out[k] = v;
  return out;
}
