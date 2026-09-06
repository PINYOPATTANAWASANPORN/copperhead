/**
 * Rule stages the B3 evidence asked for (RFC 11 §8.5 stages 1 and 2; task 7.0).
 * Deterministic, place-or-move-only-what-a-constraint-fixes steps, exempt from
 * §3.8 because they search nothing:
 *   - edge: a part with `mechanical.edge` goes against that edge; `mechanical.fixed` goes to its point
 *   - keepout: a part inside a keepout (rule area or mounting-hole ring) moves the least distance out
 *   - separation: two blocks closer than their minimum are pushed apart along the line of their centroids
 *   - edge: a part a wrapped placer left inside the copper-to-edge clearance is moved the least distance back in
 * Every move is returned as a placement plus a note, so the run records what was legalized.
 */
import type { PcbDesign, ComponentInstance, PlacedComponent } from '../ir/types.js';
import type { Polygon } from '../ir/geometry.js';
import { bbox, bboxOf, circle, intersects, distance as polyDistance, translate } from '../ir/geometry.js';
import type { Constraint } from '../../memory/constraints.js';

export interface LegalizeResult {
  placements: PlacedComponent[];
  notes: string[];
}

type Box = { minX: number; minY: number; maxX: number; maxY: number };

function extent(c: ComponentInstance): Polygon | null {
  if (c.footprint.courtyard) return c.footprint.courtyard;
  if (!c.pads.length) return null;
  const b = bboxOf(c.pads.map((p) => p.copper));
  return { outer: [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }], holes: [] };
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? [v] : []);
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Stage 1: parts a mechanical constraint fixes outright. */
export function placeMechanical(design: PcbDesign, registry: Record<string, Constraint>, movable: Set<string>): LegalizeResult {
  const byRef = new Map(design.components.map((c) => [c.reference, c]));
  const ob = bbox(design.board.outline);
  const inset = design.board.rules.copperEdgeClearanceNm + 250_000;
  const out: PlacedComponent[] = [];
  const notes: string[] = [];
  for (const [key, c] of Object.entries(registry)) {
    if (c.class !== 'mechanical') continue;
    const comp = byRef.get(c.scope?.refs?.[0] ?? '');
    if (!comp || !movable.has(comp.id) || comp.attributes.locked) continue;
    const p = c.parameters ?? {};
    if (key.startsWith('layout.mechanical.fixed.')) {
      const x = num(p.x_nm, comp.at.x), y = num(p.y_nm, comp.at.y);
      if (x !== comp.at.x || y !== comp.at.y) {
        out.push({ id: comp.id, at: { x, y }, rotation: p.rotation_mdeg !== undefined ? num(p.rotation_mdeg) : comp.rotation, side: comp.attributes.side });
        notes.push(`${comp.reference} moved to its fixed position`);
      }
    } else if (key.startsWith('layout.mechanical.edge.')) {
      const e = extent(comp);
      if (!e) continue;
      const eb = bbox(e);
      const edge = String(p.edge);
      let dx = 0, dy = 0;
      if (edge === 'west') dx = ob.minX + inset - eb.minX;
      else if (edge === 'east') dx = ob.maxX - inset - eb.maxX;
      else if (edge === 'north') dy = ob.minY + inset - eb.minY;
      else if (edge === 'south') dy = ob.maxY - inset - eb.maxY;
      if (Math.abs(dx) > 10_000 || Math.abs(dy) > 10_000) {
        out.push({ id: comp.id, at: { x: comp.at.x + dx, y: comp.at.y + dy }, rotation: comp.rotation, side: comp.attributes.side });
        notes.push(`${comp.reference} moved ${(Math.hypot(dx, dy) / 1e6).toFixed(1)} mm to the ${edge} edge`);
      }
    }
  }
  return { placements: out, notes };
}

/** The keepout zones a registry describes, as polygons. */
export function keepoutZones(design: PcbDesign, registry: Record<string, Constraint>): { key: string; zone: Polygon }[] {
  const zones: { key: string; zone: Polygon }[] = [];
  for (const [key, c] of Object.entries(registry)) {
    if (c.class !== 'manufacturing' || !key.startsWith('layout.manufacturing.keepout.')) continue;
    const p = c.parameters ?? {};
    const prohibit = strs(p.prohibit);
    if (prohibit.length && !prohibit.some((x) => ['components', 'footprints', 'pads'].includes(x))) continue;
    if (typeof p.polygon === 'string' && p.polygon) {
      try {
        zones.push({ key, zone: { outer: (JSON.parse(p.polygon) as [number, number][]).map(([x, y]) => ({ x, y })), holes: [] } });
      } catch {
        // unreadable polygon: nothing to legalize against
      }
    } else if (String(p.region) === 'mounting_hole_ring') {
      const r = num(p.radius_nm, 2_000_000);
      for (const comp of design.components) for (const pad of comp.pads) if (pad.type === 'np_thru_hole' || /^H\d/.test(comp.reference)) zones.push({ key, zone: circle(pad.at.x, pad.at.y, (pad.drill?.d ?? 0) + 2 * r) });
    }
  }
  return zones;
}

/** Least translation (axis-aligned, on bounding boxes) that takes `box` out of `zone`. */
function pushOut(box: Box, zone: Box, gap: number): { dx: number; dy: number } {
  const cands = [
    { dx: zone.minX - gap - box.maxX, dy: 0 },
    { dx: zone.maxX + gap - box.minX, dy: 0 },
    { dx: 0, dy: zone.minY - gap - box.maxY },
    { dx: 0, dy: zone.maxY + gap - box.minY },
  ];
  return cands.reduce((a, b) => (Math.hypot(b.dx, b.dy) < Math.hypot(a.dx, a.dy) ? b : a));
}

/** Stage 2 rule: move movable parts out of keepouts, then back inside the outline if the push overshot. */
export function legalizeKeepouts(design: PcbDesign, registry: Record<string, Constraint>, movable: Set<string>, placements: PlacedComponent[]): LegalizeResult {
  const zones = keepoutZones(design, registry);
  const notes: string[] = [];
  if (!zones.length) return { placements, notes };
  const byId = new Map(placements.map((p) => [p.id, p]));
  const ob = bbox(design.board.outline);
  const inset = design.board.rules.copperEdgeClearanceNm + 250_000;
  for (const comp of design.components) {
    if (!movable.has(comp.id) || comp.attributes.locked) continue;
    if (comp.pads.every((pad) => pad.type === 'np_thru_hole') || /^H\d/.test(comp.reference)) continue;
    const e0 = extent(comp);
    if (!e0) continue;
    const placed = byId.get(comp.id);
    let e = placed ? translate(e0, placed.at.x - comp.at.x, placed.at.y - comp.at.y) : e0;
    let at = placed ? { ...placed.at } : { ...comp.at };
    for (let pass = 0; pass < 4; pass++) {
      const hit = zones.find((z) => intersects(e, z.zone));
      if (!hit) break;
      const zb = bbox(hit.zone);
      // KiCad judges 'footprints not allowed' on the footprint's full bounding box (reference text included): leave a millimetre
      const { dx, dy } = pushOut(bbox(e), zb, 1_000_000);
      at = { x: at.x + dx, y: at.y + dy };
      e = translate(e, dx, dy);
      notes.push(`${comp.reference} moved ${(Math.hypot(dx, dy) / 1e6).toFixed(1)} mm out of keepout ${hit.key.slice('layout.manufacturing.keepout.'.length)}`);
    }
    // keep it on the board
    const eb = bbox(e);
    const fx = eb.minX < ob.minX + inset ? ob.minX + inset - eb.minX : eb.maxX > ob.maxX - inset ? ob.maxX - inset - eb.maxX : 0;
    const fy = eb.minY < ob.minY + inset ? ob.minY + inset - eb.minY : eb.maxY > ob.maxY - inset ? ob.maxY - inset - eb.maxY : 0;
    if (fx || fy) at = { x: at.x + fx, y: at.y + fy };
    if (at.x !== (placed?.at.x ?? comp.at.x) || at.y !== (placed?.at.y ?? comp.at.y)) byId.set(comp.id, { id: comp.id, at, rotation: placed?.rotation ?? comp.rotation, side: placed?.side ?? comp.attributes.side });
  }
  return { placements: [...byId.values()], notes };
}

/** Stage 2 rule: two blocks under a separation constraint are pushed apart along the line of their centroids. */
export function legalizeSeparation(design: PcbDesign, registry: Record<string, Constraint>, movable: Set<string>, placements: PlacedComponent[]): LegalizeResult {
  const byRef = new Map(design.components.map((c) => [c.reference, c]));
  const byId = new Map(placements.map((p) => [p.id, p]));
  const notes: string[] = [];
  const ob = bbox(design.board.outline);
  const inset = design.board.rules.copperEdgeClearanceNm + 250_000;
  const placedExtent = (c: ComponentInstance): Polygon | null => {
    const e = extent(c);
    const p = byId.get(c.id);
    return e && p ? translate(e, p.at.x - c.at.x, p.at.y - c.at.y) : e;
  };
  for (const [key, c] of Object.entries(registry)) {
    if (c.class !== 'functional' || !key.startsWith('layout.functional.separation.')) continue;
    const [ga, gb] = strs(c.parameters?.groups);
    const members = (g: string | undefined) => strs(registry[`layout.functional.group.${g ?? ''}`]?.parameters?.members).map((r) => byRef.get(r)).filter((x): x is ComponentInstance => !!x);
    const a = members(ga), b = members(gb);
    const min = num(c.parameters?.min_nm, 0);
    if (!a.length || !b.length || !min) continue;
    let best = Number.POSITIVE_INFINITY;
    for (const x of a) for (const y of b) {
      const ex = placedExtent(x), ey = placedExtent(y);
      if (ex && ey) best = Math.min(best, polyDistance(ex, ey));
    }
    if (best >= min) continue;
    // move the block with fewer movable parts (ties: b) away by the shortfall plus a margin, along the centroid line
    const movA = a.filter((x) => movable.has(x.id) && !x.attributes.locked), movB = b.filter((x) => movable.has(x.id) && !x.attributes.locked);
    const mover = movB.length && movB.length <= (movA.length || Infinity) ? movB : movA;
    const stayer = mover === movB ? a : b;
    if (!mover.length) {
      notes.push(`${ga}/${gb}: ${(best / 1e6).toFixed(1)} mm apart against ${(min / 1e6).toFixed(1)} mm, and neither block is movable`);
      continue;
    }
    const cen = (cs: ComponentInstance[]) => ({ x: cs.reduce((s, x) => s + (byId.get(x.id)?.at.x ?? x.at.x), 0) / cs.length, y: cs.reduce((s, x) => s + (byId.get(x.id)?.at.y ?? x.at.y), 0) / cs.length });
    const cm = cen(mover), cs = cen(stayer);
    let ux = cm.x - cs.x, uy = cm.y - cs.y;
    const len = Math.hypot(ux, uy) || 1;
    ux /= len;
    uy /= len;
    if (!Math.hypot(ux, uy)) ux = 1;
    const shift = min - best + 500_000;
    // clamp the shift so the mover stays inside the outline
    const boxes = mover.map(placedExtent).filter((p): p is Polygon => !!p);
    const mb = bboxOf(boxes);
    const maxX = ux > 0 ? (ob.maxX - inset - mb.maxX) / ux : ux < 0 ? (ob.minX + inset - mb.minX) / ux : Infinity;
    const maxY = uy > 0 ? (ob.maxY - inset - mb.maxY) / uy : uy < 0 ? (ob.minY + inset - mb.minY) / uy : Infinity;
    const s = Math.max(0, Math.min(shift, maxX, maxY));
    if (s <= 0) {
      notes.push(`${ga}/${gb}: no room to separate the blocks inside the outline`);
      continue;
    }
    for (const x of mover) {
      const p = byId.get(x.id);
      const at = p ? p.at : x.at;
      byId.set(x.id, { id: x.id, at: { x: Math.round(at.x + ux * s), y: Math.round(at.y + uy * s) }, rotation: p?.rotation ?? x.rotation, side: p?.side ?? x.attributes.side });
    }
    notes.push(`block ${mover === movB ? gb : ga} moved ${(s / 1e6).toFixed(1)} mm away from ${mover === movB ? ga : gb} (${(best / 1e6).toFixed(1)} mm apart against ${(min / 1e6).toFixed(1)} mm)${s < shift ? ', limited by the outline' : ''}`);
  }
  return { placements: [...byId.values()], notes };
}

/** Stage 2 rule: a movable part whose extent lies inside the copper-to-edge clearance is moved the least distance back inside the outline. Wrapped placers do not all know the rule (B4: pyplacer parked parts 0.2 mm from the edge and the board was refused). A part pushed in may then overlap a neighbour; the placement gate judges that. */
export function legalizeEdge(design: PcbDesign, movable: Set<string>, placements: PlacedComponent[]): LegalizeResult {
  const byId = new Map(placements.map((p) => [p.id, p]));
  const notes: string[] = [];
  const ob = bbox(design.board.outline);
  const inset = design.board.rules.copperEdgeClearanceNm + 250_000;
  for (const comp of design.components) {
    if (!movable.has(comp.id) || comp.attributes.locked) continue;
    const e0 = extent(comp);
    if (!e0) continue;
    const placed = byId.get(comp.id);
    const at = placed ? { ...placed.at } : { ...comp.at };
    const eb = bbox(placed ? translate(e0, placed.at.x - comp.at.x, placed.at.y - comp.at.y) : e0);
    const fx = eb.minX < ob.minX + inset ? ob.minX + inset - eb.minX : eb.maxX > ob.maxX - inset ? ob.maxX - inset - eb.maxX : 0;
    const fy = eb.minY < ob.minY + inset ? ob.minY + inset - eb.minY : eb.maxY > ob.maxY - inset ? ob.maxY - inset - eb.maxY : 0;
    // the file's micrometre rounding must not read as a new shortfall on the next pass; the 250 µm margin covers it
    if (Math.abs(fx) <= 10_000 && Math.abs(fy) <= 10_000) continue;
    byId.set(comp.id, { id: comp.id, at: { x: Math.round(at.x + fx), y: Math.round(at.y + fy) }, rotation: placed?.rotation ?? comp.rotation, side: placed?.side ?? comp.attributes.side });
    notes.push(`${comp.reference} moved ${(Math.hypot(fx, fy) / 1e6).toFixed(2)} mm in from the board edge`);
  }
  return { placements: [...byId.values()], notes };
}
