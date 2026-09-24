/**
 * Floorplan probe: an experiment, not a shipped stage.
 *
 * Places one area-sized bounding box per subsystem on a hypothetical board
 * outline, before any individual part is placed. Reads a committed placement
 * board for its parts, nets and subsystem partition; writes nothing back.
 *
 * Why it exists: `assignRegions` in src/pcb/intent/blocks.ts gives every block
 * an equal-width vertical slot across the outline, sized by block count rather
 * than by what the block holds. On esp32-amp the `mcu` block (8 parts) and
 * `amplifier` (6 parts) get the same box despite a 60x difference in area.
 *
 * Two box kinds per block, which is the point of the experiment:
 *   - BODY    the members' F.Fab outlines must pack inside it, and it must lie
 *             inside the board outline.
 *   - KEEPOUT a footprint-declared clearance zone that MAY cross the outline.
 *             ESP32-S3-WROOM-1 declares a 48 x 21 mm antenna keep-out next to
 *             its 18 x 25.5 mm body; on a 40 mm-wide board it cannot be
 *             contained, so the block carrying it has to sit on an edge with
 *             the keep-out pointing off-board.
 *
 * Method follows copperhead-llm-placement-engine-spec-v0.2.md §10.4: a slicing
 * floorplan, cost = adjacency x centroid distance + flow-order violations +
 * aspect penalty + edge violations, enumerated exhaustively at n <= 6.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { importBoard } from '../../src/pcb/ir/kicad/import.js';
import { deriveBlocks, wantsBoardEdge, type Block } from '../../src/pcb/intent/blocks.js';
import { partGraph } from '../../src/pcb/intent/subsystems.js';
import { bbox, bboxOf, chainLoops, intersection, rectFromBounds, union } from '../../src/pcb/ir/geometry.js';
import { parseSexp, children, child, isList, type SexpNode } from '../../src/kicad/sexp.js';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { Polygon, Point, BBox } from '../../src/pcb/ir/geometry.js';
import type { PcbDesign, ComponentInstance } from '../../src/pcb/ir/types.js';

const NM = 1e6;
const mm = (n: number) => n / NM;

interface Rect { x: number; y: number; w: number; h: number }
const cx = (r: Rect) => r.x + r.w / 2;
const cy = (r: Rect) => r.y + r.h / 2;
const rectOf = (b: { minX: number; minY: number; maxX: number; maxY: number }): Rect =>
  ({ x: b.minX, y: b.minY, w: b.maxX - b.minX, h: b.maxY - b.minY });

/** What a block demands of the floorplan. */
interface BlockDemand {
  block: Block;
  /** Per-member body box extents, largest first; the region must fit each one. */
  members: { ref: string; w: number; h: number }[];
  /** Sum of member body-box areas. */
  areaNm2: number;
  /** Footprint-declared keep-out rectangles, in board coordinates. */
  keepouts: { ref: string; rect: Rect }[];
  /**
   * The on-board cost of those keep-outs once the part is mounted flush to a
   * board edge with the keep-out pointing outward: a strip `depth` deep and
   * `width` wide against that edge, which nothing may occupy, not even the
   * owning block's own parts.
   */
  band: { ref: string; depth: number; width: number } | null;
  /** True when a keep-out is wider or taller than the board: it must overhang. */
  mustTouchEdge: boolean;
  /** Connectors that want a board edge. */
  edgeRefs: string[];
  /**
   * The edge a member is required to reach, from the intent file's
   * `placement.fixed[].edge` and `placement.rf[].edge`.
   *
   * Knowing only that a block holds *a* connector is not enough. Measured on
   * esp32-amp, every one of six candidates put `power-input` somewhere that
   * never touches the south edge, so J1 could be inside its block or on the
   * edge a plug reaches, but not both. The floorplan has to honour the named
   * edge, or the placer is being asked to satisfy something impossible.
   */
  requiredEdges: { ref: string; edge: Edge }[];
}

/**
 * Per-footprint geometry the IR does not keep: the declared keep-out zones,
 * and the courtyard as its separate pieces.
 *
 * `importBoard` carries neither. `readZone` runs only over board-level `zone`
 * blocks, so a keep-out declared inside a `footprint` block, as
 * ESP32-S3-WROOM-1 declares its antenna clearance, never reaches
 * `design.board.keepouts`, which comes back empty on this board. And
 * `place()` unions the courtyard pieces, falling back to their common bounding
 * box when they are disjoint. Both facts are load-bearing here, so read them
 * off the raw s-expression. Every footprint on this board is at rotation 0.
 */
interface FpGeometry { keepouts: Rect[]; courtyard: Polygon[] }

function footprintGeometry(boardText: string): Map<string, FpGeometry> {
  const out = new Map<string, FpGeometry>();
  const walk = (node: SexpNode[]): void => {
    for (const fp of children(node, 'footprint')) {
      let ref = '';
      for (const p of children(fp, 'property')) if (String(p[1]).replace(/"/g, '') === 'Reference') ref = String(p[2] ?? '');
      if (!ref) for (const t of children(fp, 'fp_text')) if (t[1] === 'reference') ref = String(t[2] ?? '');
      const at = child(fp, 'at');
      const ax = Math.round(Number(at?.[1] ?? 0) * NM), ay = Math.round(Number(at?.[2] ?? 0) * NM);
      const pt = (x: number, y: number): Point => ({ x: ax + Math.round(x * NM), y: ay + Math.round(y * NM) });

      const keepouts: Rect[] = [];
      for (const z of children(fp, 'zone')) {
        if (!child(z, 'keepout')) continue;
        const poly = child(z, 'polygon');
        const pts = poly ? child(poly, 'pts') : undefined;
        if (!pts) continue;
        const xs: number[] = [], ys: number[] = [];
        for (const q of pts.slice(1)) { if (isList(q) && q[0] === 'xy') { xs.push(Number(q[1])); ys.push(Number(q[2])); } }
        if (!xs.length) continue;
        const lo = pt(Math.min(...xs), Math.min(...ys)), hi = pt(Math.max(...xs), Math.max(...ys));
        keepouts.push({ x: lo.x, y: lo.y, w: hi.x - lo.x, h: hi.y - lo.y });
      }

      const segs: { a: Point; b: Point }[] = [];
      for (const g of fp) {
        if (!isList(g) || g[0] !== 'fp_line') continue;
        if (!/CrtYd/.test(String(child(g, 'layer')?.[1] ?? ''))) continue;
        const s0 = child(g, 'start'), s1 = child(g, 'end');
        if (s0 && s1) segs.push({ a: pt(Number(s0[1]), Number(s0[2])), b: pt(Number(s1[1]), Number(s1[2])) });
      }
      const courtyard = segs.length
        ? chainLoops(segs, 1000).loops.filter((l) => l.length >= 3).map((outer) => ({ outer, holes: [] as Point[][] }))
        : [];

      if (keepouts.length || courtyard.length) out.set(ref, { keepouts, courtyard });
      walk(fp);
    }
  };
  for (const n of parseSexp(boardText)) if (isList(n)) walk(n);
  return out;
}

/**
 * Polygon minus an axis-aligned rectangle, as the union of its intersections
 * with the four rectangles around the hole. The geometry kernel offers
 * `union` and `intersection` but no difference, and this is all the difference
 * that is needed here.
 */
function subtractRect(poly: Polygon, k: Rect, bound: BBox): Polygon[] {
  const around: Polygon[] = [
    rectFromBounds(bound.minX, bound.minY, k.x, bound.maxY),
    rectFromBounds(k.x + k.w, bound.minY, bound.maxX, bound.maxY),
    rectFromBounds(k.x, bound.minY, k.x + k.w, k.y),
    rectFromBounds(k.x, k.y + k.h, k.x + k.w, bound.maxY),
  ].filter((r) => { const b = bbox(r); return b.maxX > b.minX && b.maxY > b.minY; });
  return union(around.flatMap((r) => intersection(poly, r)));
}

/**
 * What a part actually consumes on the board.
 *
 * The courtyard is the right measure, being what packing has to keep clear,
 * but `importBoard` collapses disjoint courtyard pieces into their common
 * bounding box (import.ts:420), which for ESP32-S3-WROOM-1 fuses the module's
 * 19.5 x 20.2 mm ring with the 48 x 21 mm antenna clearance into one 48 x 41.2
 * mm rectangle: 4.3x the area the module occupies, and wider than a 40 mm
 * board. The Fab body is no substitute either: it undercounts every passive,
 * because a 0402's Fab outline is the ceramic, not the pads and clearance.
 *
 * And the two are not even disjoint pieces to separate: the WROOM draws one
 * connected courtyard whose antenna box shares endpoints with the body ring.
 * So subtract the declared keep-out from the courtyard polygon and take what
 * is left, unioned with the Fab body (the module PCB runs 5 mm past its
 * courtyard ring, and that copper is real).
 */
function occupancyBox(c: ComponentInstance, g: FpGeometry): Rect {
  let polys: Polygon[] = g.courtyard.length ? g.courtyard : c.footprint.courtyard ? [c.footprint.courtyard] : [];
  if (polys.length && g.keepouts.length) {
    const bound = bboxOf(polys);
    const pad = 1 * NM;
    const big = { minX: bound.minX - pad, minY: bound.minY - pad, maxX: bound.maxX + pad, maxY: bound.maxY + pad };
    for (const k of g.keepouts) polys = polys.flatMap((p) => subtractRect(p, k, big));
  }
  const boxes: Rect[] = polys.map((p) => rectOf(bbox(p)));
  if (c.footprint.body) boxes.push(rectOf(bbox(c.footprint.body)));
  if (!boxes.length) boxes.push(rectOf(bboxOf(c.pads.map((p) => p.copper))));
  return rectOf({
    minX: Math.min(...boxes.map((b) => b.x)), minY: Math.min(...boxes.map((b) => b.y)),
    maxX: Math.max(...boxes.map((b) => b.x + b.w)), maxY: Math.max(...boxes.map((b) => b.y + b.h)),
  });
}

function demands(design: PcbDesign, blocks: Block[], geom: Map<string, FpGeometry>, board: Rect, required: Map<string, Edge>): BlockDemand[] {
  const byId = new Map(design.components.map((c) => [c.id, c]));
  return blocks.filter((b) => b.id !== 'unassigned').map((b) => {
    const comps = b.members.map((id) => byId.get(id)!).filter(Boolean);
    const members = comps.map((c) => {
      const g = geom.get(c.reference) ?? { keepouts: [], courtyard: [] };
      const r = occupancyBox(c, g);
      return { ref: c.reference, w: r.w, h: r.h };
    }).sort((p, q) => q.w * q.h - p.w * p.h);
    const ko = comps.flatMap((c) => (geom.get(c.reference)?.keepouts ?? []).map((rect) => ({ ref: c.reference, rect })));
    const bands = comps.flatMap((c) => {
      const g = geom.get(c.reference);
      if (!g?.keepouts.length) return [];
      const o = occupancyBox(c, g);
      return g.keepouts.map((k) => ({ ref: c.reference, ...onBoardBand(o, k) }));
    }).sort((p, q) => q.depth * q.width - p.depth * p.width);
    return {
      block: b,
      members,
      // Brick 3b: a keep-out is area the block does not get to use, so it is
      // part of the block's demand. Without this the floorplanner sized `mcu`
      // from U1's occupancy alone and proposed regions that could not hold the
      // block once 48 x 21 mm was reserved — candidates (c) and (e) stranded
      // parts for exactly this reason.
      areaNm2: members.reduce((a, m) => a + m.w * m.h, 0) + bands.reduce((a, b) => a + b.depth * b.width, 0),
      keepouts: ko,
      band: bands[0] ?? null,
      mustTouchEdge: ko.some((k) => k.rect.w > board.w || k.rect.h > board.h),
      edgeRefs: comps.filter(wantsBoardEdge).map((c) => c.reference),
      requiredEdges: comps.flatMap((c) => { const e = required.get(c.reference); return e ? [{ ref: c.reference, edge: e }] : []; }),
    };
  });
}

/**
 * What a keep-out still costs after the part is mounted flush to a board edge.
 *
 * A designer puts the WROOM at the board edge with its antenna pointing off
 * the board, so most of the 48 x 21 mm clearance zone is over air and free.
 * What is *not* free is the slice of the zone that overlaps the module's own
 * footprint extent. The module PCB runs 6 mm past its courtyard ring, and no
 * copper may sit under that. Mount it flush and that slice stays on the board.
 *
 * So: project the keep-out onto the part's occupancy box along the outward
 * axis and keep the overlap. `depth` runs inward from the edge, `width` along
 * it.
 */
function onBoardBand(o: Rect, k: Rect): { depth: number; width: number } {
  const dx = (k.x + k.w / 2) - (o.x + o.w / 2), dy = (k.y + k.h / 2) - (o.y + o.h / 2);
  if (Math.abs(dy) >= Math.abs(dx)) {
    const depth = dy < 0 ? Math.max(0, (k.y + k.h) - o.y) : Math.max(0, (o.y + o.h) - k.y);
    return { depth: Math.min(depth, k.h), width: k.w };
  }
  const depth = dx < 0 ? Math.max(0, (k.x + k.w) - o.x) : Math.max(0, (o.x + o.w) - k.x);
  return { depth: Math.min(depth, k.w), width: k.h };
}

/** The strip a block's band occupies, laid against the edge its region reaches. */
function bandRect(r: Rect, band: { depth: number; width: number }, board: Rect, tol: number): Rect | null {
  const t = touchedEdges(r, board, tol);
  if (!t.length) return null;
  const e = t[0]!;
  if (e === 'north' || e === 'south') {
    const w = Math.min(band.width, r.w);
    return { x: cx(r) - w / 2, y: e === 'north' ? r.y : r.y + r.h - band.depth, w, h: band.depth };
  }
  const h = Math.min(band.width, r.h);
  return { x: e === 'west' ? r.x : r.x + r.w - band.depth, y: cy(r) - h / 2, w: band.depth, h };
}

/** The region left once the band is taken off the edge it lies against. */
function usable(r: Rect, band: { depth: number; width: number } | null, board: Rect, tol: number): Rect {
  if (!band) return r;
  const t = touchedEdges(r, board, tol);
  if (!t.length) return r;
  const e = t[0]!;
  if (e === 'north') return { ...r, y: r.y + band.depth, h: r.h - band.depth };
  if (e === 'south') return { ...r, h: r.h - band.depth };
  if (e === 'west') return { ...r, x: r.x + band.depth, w: r.w - band.depth };
  return { ...r, w: r.w - band.depth };
}

const overlap = (a: Rect, b: Rect): number =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/** Block-to-block net adjacency, aggregated from the part graph (ground and rails already dropped). */
function blockAdjacency(design: PcbDesign, ds: BlockDemand[]): number[][] {
  const g = partGraph(design);
  const blockOf = new Map<string, number>();
  ds.forEach((d, i) => { for (const m of d.block.members) blockOf.set(m, i); });
  const w = ds.map(() => ds.map(() => 0));
  g.ids.forEach((idA, i) => {
    const a = blockOf.get(idA);
    if (a === undefined) return;
    for (const [j, weight] of g.adj[i]!) {
      const b = blockOf.get(g.ids[j]!);
      if (b === undefined || b === a) continue;
      w[a]![b]! += weight / 2; // each edge is seen from both ends
    }
  });
  return w;
}

// ---------------------------------------------------------------- slicing tree

type Tree = number | { cut: 'H' | 'V'; l: Tree; r: Tree };

/** Every binary tree shape over n ordered leaves, with both cut orientations. */
function trees(leaves: number[]): Tree[] {
  if (leaves.length === 1) return [leaves[0]!];
  const out: Tree[] = [];
  for (let k = 1; k < leaves.length; k++)
    for (const l of trees(leaves.slice(0, k)))
      for (const r of trees(leaves.slice(k)))
        for (const cut of ['H', 'V'] as const) out.push({ cut, l, r });
  return out;
}

const leavesOf = (t: Tree): number[] => (typeof t === 'number' ? [t] : [...leavesOf(t.l), ...leavesOf(t.r)]);

/** Cut each rectangle in proportion to the demand below it, so utilisation is uniform. */
function slice(t: Tree, r: Rect, area: number[], out: Rect[]): void {
  if (typeof t === 'number') { out[t] = r; return; }
  const al = leavesOf(t.l).reduce((a, i) => a + area[i]!, 0);
  const ar = leavesOf(t.r).reduce((a, i) => a + area[i]!, 0);
  const f = al / (al + ar);
  if (t.cut === 'V') {
    const wl = Math.round(r.w * f);
    slice(t.l, { ...r, w: wl }, area, out);
    slice(t.r, { ...r, x: r.x + wl, w: r.w - wl }, area, out);
  } else {
    const hl = Math.round(r.h * f);
    slice(t.l, { ...r, h: hl }, area, out);
    slice(t.r, { ...r, y: r.y + hl, h: r.h - hl }, area, out);
  }
}

// ---------------------------------------------------------------------- cost

const EDGES = ['north', 'south', 'west', 'east'] as const;
type Edge = (typeof EDGES)[number];

function touchedEdges(r: Rect, board: Rect, tol: number): Edge[] {
  const e: Edge[] = [];
  if (r.y - board.y <= tol) e.push('north');
  if (board.y + board.h - (r.y + r.h) <= tol) e.push('south');
  if (r.x - board.x <= tol) e.push('west');
  if (board.x + board.w - (r.x + r.w) <= tol) e.push('east');
  return e;
}

interface Weights { adjacency: number; flow: number; aspect: number; edge: number; keepout: number }
const DEFAULT_WEIGHTS: Weights = { adjacency: 1, flow: 0.6, aspect: 0.4, edge: 1.5, keepout: 2 };

interface Scored {
  regions: Rect[];
  cost: number;
  terms: { adjacency: number; flow: number; aspect: number; edge: number; keepout: number };
  fits: boolean;
  /** Why it was rejected, when it was. */
  reject: string | null;
}

/** A member fits a region in one of the two 90-degree orientations. */
const fitsIn = (m: { w: number; h: number }, r: Rect) => (m.w <= r.w && m.h <= r.h) || (m.h <= r.w && m.w <= r.h);

function score(
  regions: Rect[], ds: BlockDemand[], adj: number[][], board: Rect, flowAxis: 'x' | 'y', flowOrder: number[], w: Weights,
): Scored {
  const tol = 0.05 * NM;
  const diag = Math.hypot(board.w, board.h);

  const fail = (why: string): Scored =>
    ({ regions, cost: Infinity, terms: { adjacency: 0, flow: 0, aspect: 0, edge: 0, keepout: 0 }, fits: false, reject: why });

  // hard: a member that owes a named edge must be in a region that reaches it.
  // A connector inside its block but off the edge is not a board anyone can
  // plug into, and a connector on the edge but outside its block fails the
  // region gate, so a floorplan that allows neither is simply infeasible.
  for (let i = 0; i < regions.length; i++) {
    const t = touchedEdges(regions[i]!, board, tol);
    for (const { ref, edge } of ds[i]!.requiredEdges)
      if (!t.includes(edge)) return fail(`${ds[i]!.block.id}: ${ref} needs the ${edge} edge, its region reaches ${t.length ? t.join('/') : 'none'}`);
  }

  // hard: a block whose keep-out cannot be contained has to reach a board edge,
  // because that is the only way the keep-out gets to hang off
  for (let i = 0; i < regions.length; i++)
    if (ds[i]!.mustTouchEdge && !touchedEdges(regions[i]!, board, tol).length)
      return fail(`${ds[i]!.block.id}: carries an off-board keep-out but its region reaches no edge`);

  // hard: every member must fit the region left after its OWN block's keep-out
  // band, and the block's parts must fit in that area
  const use = regions.map((r, i) => usable(r, ds[i]!.band, board, tol));
  for (let i = 0; i < regions.length; i++) {
    const bad = ds[i]!.members.find((m) => !fitsIn(m, use[i]!));
    if (bad) return fail(`${ds[i]!.block.id}: ${bad.ref} (${mm(bad.w).toFixed(1)}x${mm(bad.h).toFixed(1)} mm) does not fit its ${mm(use[i]!.w).toFixed(1)}x${mm(use[i]!.h).toFixed(1)} mm usable region`);
    if (ds[i]!.areaNm2 > use[i]!.w * use[i]!.h)
      return fail(`${ds[i]!.block.id}: ${(ds[i]!.areaNm2 / 1e12).toFixed(0)} mm2 of parts into a ${(use[i]!.w * use[i]!.h / 1e12).toFixed(0)} mm2 usable region`);
  }

  let adjacency = 0;
  for (let i = 0; i < regions.length; i++) for (let j = i + 1; j < regions.length; j++) {
    const weight = (adj[i]![j]! + adj[j]![i]!) / 2;
    if (weight > 0) adjacency += weight * Math.hypot(cx(regions[i]!) - cx(regions[j]!), cy(regions[i]!) - cy(regions[j]!)) / diag;
  }

  // flow: consecutive blocks in declared order should advance along the flow axis
  let flow = 0;
  const proj = (r: Rect) => (flowAxis === 'x' ? cx(r) : cy(r));
  const span = flowAxis === 'x' ? board.w : board.h;
  for (let k = 0; k + 1 < flowOrder.length; k++) {
    const a = proj(regions[flowOrder[k]!]!), b = proj(regions[flowOrder[k + 1]!]!);
    if (b < a) flow += (a - b) / span;
  }

  // aspect: a region shaped like a sliver is unusable even at the right area
  let aspect = 0;
  for (const r of regions) {
    const ar = Math.max(r.w, r.h) / Math.max(1, Math.min(r.w, r.h));
    if (ar > 3) aspect += (ar - 3) / 3;
  }

  // edge: a block with an off-board keep-out, or with a connector, must reach an edge
  let edge = 0;
  for (let i = 0; i < regions.length; i++) {
    const t = touchedEdges(regions[i]!, board, tol);
    if (ds[i]!.mustTouchEdge && !t.length) edge += 2;
    if (ds[i]!.edgeRefs.length && !t.length) edge += 1;
  }

  // keep-out: the band is already charged to its own block through `usable`;
  // what remains to penalise is it spilling sideways into a neighbour
  let keepout = 0;
  for (let i = 0; i < regions.length; i++) {
    if (!ds[i]!.band) continue;
    const band = bandRect(regions[i]!, ds[i]!.band!, board, tol);
    if (!band) continue;
    for (let j = 0; j < regions.length; j++) {
      if (j === i) continue;
      const o = overlap(band, regions[j]!);
      if (o > 0) keepout += o / (regions[j]!.w * regions[j]!.h);
    }
  }

  const terms = { adjacency, flow, aspect, edge, keepout };
  return {
    regions, fits: true, reject: null,
    terms,
    cost: w.adjacency * adjacency + w.flow * flow + w.aspect * aspect + w.edge * edge + w.keepout * keepout,
  };
}

// --------------------------------------------------------------------- render

/**
 * Figures are set the way a preprint is: Latin Modern (the Computer Modern
 * revival TeX ships, so the plates match a LaTeX document), a numbered caption
 * centred beneath the figure rather than a title above it, and hairline rules.
 * Dark ground throughout, with tints chosen to stay separable in greyscale.
 */
// Single quotes inside: these land in a double-quoted XML attribute, and a
// double quote there ends the attribute and breaks the document.
const SERIF = "'Latin Modern Roman', 'CMU Serif', Georgia, serif";
const MONO = "'Latin Modern Mono', 'CMU Typewriter Text', 'DejaVu Sans Mono', monospace";
const INK = '#f2f5fa';
const INK_MID = '#b9c3d2';
const INK_LIGHT = '#8b95a5';
const GROUND = '#11151c';
const BOARD_FILL = '#171c25';
const BOARD_EDGE = '#e8c15a';
const RULE = '#313b4a';
const KO_FILL = '#3a2028';
const KO_EDGE = '#c46464';
const KO_TEXT = '#e09a9a';
const OFF_FILL = 'none';
const OFF_EDGE = '#7a3b3b';
const OFF_TEXT = '#9a5f5f';

/**
 * Plate tints: fill, then a lighter keyline.
 *
 * Generated as hsl(h, 60%, 50%) mixed 26% against the ground for the fill and
 * hsl(h, 65%, 60%) for the keyline, at h = (i * 67 + 145) mod 360. The stride
 * of 67 degrees keeps adjacent blocks apart on the wheel; the values are
 * written out rather than computed so a plate cannot drift between runs.
 */
const TINT: [string, string][] = [
  ['#1a4533', '#57db8e'], ['#1a2f4a', '#5795db'], ['#341d4a', '#ad57db'],
  ['#421d2b', '#db5776'], ['#424022', '#dbcc57'], ['#1a4522', '#57db57'],
];

function svg(cand: Scored, ds: BlockDemand[], board: Rect, caption: string, figureNo: number): string {
  const tol = 0.05 * NM;
  const p: string[] = [];

  // ImageMagick's built-in renderer honours neither clip paths nor runs of
  // spaces, so clip in code and separate fields with a visible glyph.
  // Latin Modern runs narrower than the DejaVu these ratios were first tuned
  // for; over-estimating the advance truncates labels that would have fitted.
  const fit = (t: string, size: number, widthMm: number, font = MONO) => {
    const n = Math.floor((widthMm - 1.5) / (size * (font === SERIF ? 0.465 : 0.53)));
    return n < 1 ? '' : t.length <= n ? t : t.slice(0, Math.max(0, n - 1)) + '…';
  };
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const text = (x: number, y: number, o: { size: number; fill?: string; font?: string; anchor?: string; style?: string }, t: string) =>
    `<text x="${x.toFixed(2)}" y="${y.toFixed(2)}" text-anchor="${o.anchor ?? 'start'}"` +
    ` font-family="${o.font ?? MONO}" font-size="${o.size}" font-weight="bold" fill="${o.fill ?? INK}"` +
    `${o.style ? ` font-style="${o.style}"` : ''}>${esc(t)}</text>`;

  // Off-board keep-out overhangs, collected before anything is drawn: both the
  // view box and the caption beneath the board have to clear them, on whichever
  // edge they land.
  const offs: { rect: Rect; ref: string }[] = [];
  cand.regions.forEach((r, i) => {
    const bd = ds[i]!.band;
    if (!bd) return;
    const t = touchedEdges(r, board, tol);
    if (!t.length) return;
    const e = t[0]!, depth = 7 * NM, w = Math.min(bd.width, e === 'north' || e === 'south' ? r.w : r.h);
    const rect: Rect = e === 'north' ? { x: cx(r) - w / 2, y: board.y - depth, w, h: depth }
      : e === 'south' ? { x: cx(r) - w / 2, y: board.y + board.h, w, h: depth }
      : e === 'west' ? { x: board.x - depth, y: cy(r) - w / 2, w: depth, h: w }
      : { x: board.x + board.w, y: cy(r) - w / 2, w: depth, h: w };
    offs.push({ rect, ref: bd.ref });
  });

  for (const { rect: off, ref } of offs) {
    p.push(`<rect x="${mm(off.x)}" y="${mm(off.y)}" width="${mm(off.w)}" height="${mm(off.h)}" fill="${OFF_FILL}" stroke="${OFF_EDGE}" stroke-width="0.18" stroke-dasharray="1.1 0.9"/>`);
    p.push(text(mm(off.x + off.w / 2), mm(off.y + off.h) - 1.4, { size: 1.4, fill: OFF_TEXT, anchor: 'middle' },
      fit(`${ref} antenna clearance, off board`, 1.15, mm(off.w))));
  }

  p.push(`<rect x="${mm(board.x)}" y="${mm(board.y)}" width="${mm(board.w)}" height="${mm(board.h)}" fill="${BOARD_FILL}" stroke="${BOARD_EDGE}" stroke-width="0.32"/>`);

  cand.regions.forEach((r, i) => {
    const [fill, stroke] = TINT[i % TINT.length]!;
    p.push(`<rect x="${mm(r.x)}" y="${mm(r.y)}" width="${mm(r.w)}" height="${mm(r.h)}" fill="${fill}" stroke="${stroke}" stroke-width="0.2"/>`);
  });

  // keep-out band on top of its own block: area the block does not get
  cand.regions.forEach((r, i) => {
    const bd = ds[i]!.band;
    if (!bd) return;
    const band = bandRect(r, bd, board, tol);
    if (!band) return;
    p.push(`<rect x="${mm(band.x)}" y="${mm(band.y)}" width="${mm(band.w)}" height="${mm(band.h)}" fill="${KO_FILL}" stroke="${KO_EDGE}" stroke-width="0.2" stroke-dasharray="1.1 0.9"/>`);
    p.push(text(mm(band.x + band.w / 2), mm(band.y + band.h) - 1.5, { size: 1.4, fill: KO_TEXT, anchor: 'middle' },
      fit(`${bd.ref} no copper, ${mm(band.w).toFixed(0)} × ${mm(band.h).toFixed(0)} mm`, 1.15, mm(band.w))));
  });

  // block labels, truncated to their region and dropping the lines that do not fit
  cand.regions.forEach((r, i) => {
    const d = ds[i]!;
    const use = usable(r, d.band, board, tol);
    const band = d.band ? bandRect(r, d.band, board, tol) : null;
    const top = band && band.y === r.y ? mm(band.y + band.h) : mm(r.y);
    const lines: [number, string, string, string][] = [
      [2.3, INK, SERIF, d.block.id],
      [1.5, INK_MID, MONO, `${mm(r.w).toFixed(1)} × ${mm(r.h).toFixed(1)} mm`],
      [1.5, INK_MID, MONO, `${(d.areaNm2 / 1e12).toFixed(0)}/${(use.w * use.h / 1e12).toFixed(0)} mm²  u ${(d.areaNm2 / Math.max(1, use.w * use.h)).toFixed(2)}`],
      [1.35, INK_LIGHT, MONO, d.members.map((m) => m.ref).join(' ')],
    ];
    let y = top + 2.5;
    for (const [size, fill, font, t] of lines) {
      if (y > mm(r.y + r.h) - 0.6) break;
      p.push(text(mm(r.x) + 0.9, y, { size, fill, font }, fit(t, size, mm(r.w), font)));
      y += size + 0.5;
    }
  });

  // caption: centred under the figure, clear of any overhang
  const t = cand.terms;
  const head = `Figure ${figureNo}.`;
  const line1 = `${head} ${caption}`;
  const line2 = `Cost ${cand.cost.toFixed(3)} = adjacency ${t.adjacency.toFixed(2)} + flow ${t.flow.toFixed(2)} + aspect ${t.aspect.toFixed(2)} + edge ${t.edge.toFixed(2)} + keep-out ${t.keepout.toFixed(2)}.`;
  const items = [board, ...offs.map((o) => o.rect)];
  const minX = Math.min(...items.map((r) => r.x)), maxX = Math.max(...items.map((r) => r.x + r.w));
  const minY = Math.min(...items.map((r) => r.y)), maxY = Math.max(...items.map((r) => r.y + r.h));
  const midX = mm(board.x + board.w / 2);
  const S1 = 2.3, S2 = 1.8;
  const capW = Math.max(line1.length * S1, line2.length * S2) * 0.51;
  const y1 = mm(maxY) + 4.6, y2 = y1 + 2.7;

  const pad = 3.5;
  const x0 = Math.min(mm(minX) - pad, midX - capW / 2 - pad);
  const x1 = Math.max(mm(maxX) + pad, midX + capW / 2 + pad);
  const vy0 = mm(minY) - pad, vy1 = y2 + 4.4;

  p.push(`<line x1="${midX - capW / 2}" y1="${(y1 - 2.9).toFixed(2)}" x2="${midX + capW / 2}" y2="${(y1 - 2.9).toFixed(2)}" stroke="${RULE}" stroke-width="0.12"/>`);
  p.push(text(midX, y1, { size: S1, font: SERIF, anchor: 'middle' }, line1));
  p.push(text(midX, y2, { size: S2, font: SERIF, fill: INK_MID, anchor: 'middle', style: 'italic' }, line2));

  const w = x1 - x0, h = vy1 - vy0;
  p.unshift(`<rect x="${x0.toFixed(2)}" y="${vy0.toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" fill="${GROUND}"/>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0.toFixed(2)} ${vy0.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)}" width="${(w * 15).toFixed(0)}" height="${(h * 15).toFixed(0)}">
${p.join('\n')}
</svg>
`;
}

/**
 * Contact sheet: every ranked candidate as a small panel on one plate, so the
 * shapes can be compared at a glance instead of by paging through figures.
 * Panels are drawn at board scale in a grid, lettered (a), (b), (c)…
 */
function collage(cands: Scored[], ds: BlockDemand[], board: Rect, caption: string, figureNo: number, stats: { title: string; facts: string[] }): string {
  const tol = 0.05 * NM;
  const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
  const bw = mm(board.w), bh = mm(board.h);
  const cols = Math.min(3, Math.max(1, cands.length));
  const rows = Math.ceil(cands.length / cols);
  const gapX = 4, gapY = 5;           // mm between panels; the y gap holds the sub-label
  const LABEL_H = 8.6;                // letter and cost, beneath each panel
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const text = (x: number, y: number, o: { size: number; fill?: string; font?: string; anchor?: string; style?: string }, t: string) =>
    `<text x="${x.toFixed(2)}" y="${y.toFixed(2)}" text-anchor="${o.anchor ?? 'start'}"` +
    ` font-family="${o.font ?? MONO}" font-size="${o.size}" font-weight="bold" fill="${o.fill ?? INK}"` +
    `${o.style ? ` font-style="${o.style}"` : ''}>${esc(t)}</text>`;

  // The off-board antenna clearance is not drawn here: on a contact sheet it
  // costs a margin above every row and tells the reader nothing the keep-out
  // band does not already say. It stays in the per-candidate figures, where
  // there is room to label it.
  const cellW = bw + gapX;
  const cellH = bh + LABEL_H + gapY;

  const p: string[] = [];
  cands.forEach((cand, n) => {
    const col = n % cols, row = Math.floor(n / cols);
    const ox = col * cellW, oy = row * cellH;
    const g: string[] = [];
    g.push(`<rect x="0" y="0" width="${bw}" height="${bh}" fill="${BOARD_FILL}" stroke="${BOARD_EDGE}" stroke-width="0.3"/>`);
    cand.regions.forEach((r, i) => {
      const [fill, stroke] = TINT[i % TINT.length]!;
      g.push(`<rect x="${(mm(r.x) - mm(board.x)).toFixed(2)}" y="${(mm(r.y) - mm(board.y)).toFixed(2)}" width="${mm(r.w)}" height="${mm(r.h)}" fill="${fill}" stroke="${stroke}" stroke-width="0.18"/>`);
    });
    cand.regions.forEach((r, i) => {
      const bd = ds[i]!.band;
      if (!bd) return;
      const band = bandRect(r, bd, board, tol);
      if (!band) return;
      g.push(`<rect x="${(mm(band.x) - mm(board.x)).toFixed(2)}" y="${(mm(band.y) - mm(board.y)).toFixed(2)}" width="${mm(band.w)}" height="${mm(band.h)}" fill="${KO_FILL}" stroke="${KO_EDGE}" stroke-width="0.18" stroke-dasharray="0.9 0.7"/>`);
    });
    // per region: its name and its dimensions, each dropped when it will not fit
    cand.regions.forEach((r, i) => {
      const rw = mm(r.w), rh = mm(r.h);
      // clear the block's own keep-out band where it lies along the region top
      const bd = ds[i]!.band;
      const band = bd ? bandRect(r, bd, board, tol) : null;
      const top = mm(r.y) - mm(board.y) + (band && band.y === r.y ? mm(band.h) : 0);
      const bottom = mm(r.y + r.h) - mm(board.y);
      const clip = (t: string, size: number) => {
        const n2 = Math.floor((rw - 1.2) / (size * 0.55));
        return n2 < 3 ? null : t.length <= n2 ? t : t.slice(0, Math.max(0, n2 - 1)) + '…';
      };
      const x = mm(r.x) - mm(board.x) + 0.7;
      const id = clip(ds[i]!.block.id, 2.0);
      if (id && top + 2.7 < bottom) g.push(text(x, top + 2.7, { size: 2.0, fill: INK }, id));
      const dim = clip(`${rw.toFixed(1)} × ${rh.toFixed(1)} mm`, 1.65);
      if (dim && top + 5.2 < bottom) g.push(text(x, top + 5.2, { size: 1.65, fill: INK_MID }, dim));
    });
    g.push(text(bw / 2, bh + 4.3, { size: 2.5, font: SERIF, anchor: 'middle' }, `(${LETTERS[n] ?? String(n + 1)})`));
    g.push(text(bw / 2, bh + 8.0, { size: 2.0, font: MONO, fill: INK_MID, anchor: 'middle' }, `cost ${cand.cost.toFixed(3)}`));
    p.push(`<g transform="translate(${ox.toFixed(2)} ${oy.toFixed(2)})">\n${g.join('\n')}\n</g>`);
  });

  const gridW = cols * cellW - gapX;
  const gridH = rows * cellH - gapY;

  // ---- header: what board this is and what the run measured ---------------
  const TS = 3.7, FS = 2.1;
  const factsLine = stats.facts.join('   |   ');
  const statsW = Math.max(stats.title.length * TS * 0.51, factsLine.length * FS * 0.55);
  const headerH = 11.6;
  p.push(text(gridW / 2, -headerH + 4.0, { size: TS, font: SERIF, fill: INK, anchor: 'middle' }, stats.title));
  p.push(text(gridW / 2, -headerH + 8.6, { size: FS, font: MONO, fill: INK_MID, anchor: 'middle' }, factsLine));

  // ---- legend, cost function, caption ------------------------------------
  // The panels alone do not say which tint is which subsystem, nor what the
  // ranking actually minimises. Both belong on the plate: a reader should not
  // have to hold the console table beside it.
  const LS = 2.3;                       // legend type size
  const swatch = 3.0, sgap = 1.0, iend = 2.6;   // tight enough that six items share one row
  const itemW = (label: string) => swatch + sgap + label.length * LS * 0.55 + iend;

  type Item = { label: string; fill: string; stroke: string; dash?: boolean };
  const items: Item[] = [
    ...ds.map((d, i) => ({ label: d.block.id, fill: TINT[i % TINT.length]![0], stroke: TINT[i % TINT.length]![1] })),
    { label: 'keep-out (no copper)', fill: KO_FILL, stroke: KO_EDGE, dash: true },
  ];

  // greedy wrap across the plate width
  const legendRows: Item[][] = [[]];
  let rowW = 0;
  for (const it of items) {
    const w0 = itemW(it.label);
    if (rowW + w0 > gridW && legendRows[legendRows.length - 1]!.length) { legendRows.push([]); rowW = 0; }
    legendRows[legendRows.length - 1]!.push(it);
    rowW += w0;
  }

  const w = DEFAULT_WEIGHTS;
  const num = (v: number) => (v === 1 ? '' : `${v} \u00b7 `);
  // Explicit multiplication dots: juxtaposition is the convention in typeset
  // maths, but '0.6 flow' reads as a label rather than a product to anyone
  // not already expecting a cost function.
  const costLine = `cost  =  ${num(w.adjacency)}\u03a3 w\u2090\u1d47 \u00b7 d(a,b)/D  +  ${num(w.flow)}flow  +  ${num(w.aspect)}aspect  +  ${num(w.edge)}edge  +  ${num(w.keepout)}keep-out`;

  const head = `Figure ${figureNo}.`;
  const line1 = `${head} ${caption}`;
  const S1 = 2.9;

  let y = gridH + 6.4;   // clears the last row's cost labels, which end at gridH
  const legendTop = y;
  for (const row of legendRows) {
    let x = (gridW - row.reduce((a, it) => a + itemW(it.label), 0)) / 2;
    for (const it of row) {
      p.push(`<rect x="${x.toFixed(2)}" y="${(y - LS + 0.15).toFixed(2)}" width="${swatch}" height="${(LS * 1.05).toFixed(2)}" fill="${it.fill}" stroke="${it.stroke}" stroke-width="0.22"${it.dash ? ' stroke-dasharray="0.8 0.6"' : ''}/>`);
      p.push(text(x + swatch + sgap, y, { size: LS, font: MONO, fill: INK_MID }, it.label));
      x += itemW(it.label);
    }
    y += LS + 1.0;
  }

  y += 1.0;
  p.push(text(gridW / 2, y, { size: 2.5, font: SERIF, fill: INK, anchor: 'middle' }, costLine));

  const capW = Math.max(line1.length * S1 * 0.51, statsW, gridW);
  const midX = gridW / 2;
  const y1 = y + 6.0;
  const pad = 3.5;
  const x0 = Math.min(-pad, midX - capW / 2 - pad), x1 = Math.max(gridW + pad, midX + capW / 2 + pad);
  const y0 = -pad - headerH, y2 = y1 + 5.2;
  p.push(`<line x1="${(midX - capW / 2).toFixed(2)}" y1="${(legendTop - LS - 2.0).toFixed(2)}" x2="${(midX + capW / 2).toFixed(2)}" y2="${(legendTop - LS - 2.0).toFixed(2)}" stroke="${RULE}" stroke-width="0.14"/>`);
  p.push(`<line x1="${(midX - capW / 2).toFixed(2)}" y1="${(y1 - 2.9).toFixed(2)}" x2="${(midX + capW / 2).toFixed(2)}" y2="${(y1 - 2.9).toFixed(2)}" stroke="${RULE}" stroke-width="0.14"/>`);
  p.push(text(midX, y1, { size: S1, font: SERIF, anchor: 'middle' }, line1));

  const vw = x1 - x0, vh = y2 - y0;
  p.unshift(`<rect x="${x0.toFixed(2)}" y="${y0.toFixed(2)}" width="${vw.toFixed(2)}" height="${vh.toFixed(2)}" fill="${GROUND}"/>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0.toFixed(2)} ${y0.toFixed(2)} ${vw.toFixed(2)} ${vh.toFixed(2)}" width="${(vw * 13).toFixed(0)}" height="${(vh * 13).toFixed(0)}">
${p.join('\n')}
</svg>
`;
}

/**
 * One intent file per candidate floorplan.
 *
 * Each carries the base file's requirements untouched (connector edges, the
 * antenna, attachments, chains, loops, routing) and adds one group per
 * subsystem with the rectangle the floorplan gave it. `placement.groups[].region`
 * makes that rectangle a hard constraint the legalizer enforces and the
 * placement gate judges.
 */
function intentForCandidate(
  cand: Scored, ds: BlockDemand[], design: PcbDesign, base: Record<string, unknown>, letter: string, board: Rect,
): string {
  const doc = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
  // A region is stated in absolute board millimetres, while the floorplan works
  // in a rectangle at the origin. This board's outline starts at (100, 100), so
  // a local coordinate emitted as-is would describe a region off the board.
  const ob = bbox(design.board.outline);
  const ox = mm(ob.minX), oy = mm(ob.minY);
  const placement = (doc.placement ??= {}) as Record<string, unknown>;
  const groups = (placement.groups ??= []) as Record<string, unknown>[];
  const refOf = (id: string) => design.components.find((c) => c.id === id)?.reference ?? id;
  ds.forEach((d, i) => {
    const r = cand.regions[i]!;
    const members = d.block.members.map(refOf);
    // The region itself, now that the language can carry one. This replaces
    // pinning the block's anchor with `fixed[].at` and bounding the rest with
    // `max_spread_mm`: that was a disc standing in for a rectangle, and it left
    // the anchor immovable, so the packer could not improve on the floorplan
    // even where it should have.
    groups.push({
      id: d.block.id,
      components: members,
      region: [Number((ox + mm(r.x)).toFixed(2)), Number((oy + mm(r.y)).toFixed(2)), Number(mm(r.w).toFixed(2)), Number(mm(r.h).toFixed(2))],
    });
  });
  const head = [
    `# Generated from floorplan candidate (${letter}) for a ${mm(board.w)} x ${mm(board.h)} mm outline.`,
    '# Do not hand-edit: regenerate with manual-tests/floorplan-probe/run.sh --emit-intent.',
    '#',
    `# Board origin (${ox}, ${oy}) mm; \`at\` below is absolute, regions are local to the outline.`,
    '#',
    '# Regions, per block, as the floorplan placed them:',
    ...ds.map((d, i) => {
      const r = cand.regions[i]!;
      return `#   ${d.block.id.padEnd(15)} ${mm(r.w).toFixed(1).padStart(5)} x ${mm(r.h).toFixed(1).padStart(5)} mm at (${mm(r.x).toFixed(1)}, ${mm(r.y).toFixed(1)})`;
    }),
    `# Cost ${cand.cost.toFixed(3)} = adjacency ${cand.terms.adjacency.toFixed(2)} + flow ${cand.terms.flow.toFixed(2)} + aspect ${cand.terms.aspect.toFixed(2)} + edge ${cand.terms.edge.toFixed(2)} + keep-out ${cand.terms.keepout.toFixed(2)}.`,
    '',
  ].join('\n');
  return head + stringifyYaml(doc);
}

// ----------------------------------------------------------------------- main

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  const out: T[][] = [];
  xs.forEach((x, i) => { for (const rest of permutations([...xs.slice(0, i), ...xs.slice(i + 1)])) out.push([x, ...rest]); });
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (k: string, d: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1]! : d; };
  const boardDir = path.resolve(arg('board', 'manual-tests/placement-boards/esp32-amp'));
  const [bw, bh] = arg('size', '40x50').split('x').map(Number) as [number, number];
  const outDir = path.resolve(arg('out', 'manual-tests/runs/floorplan/esp32-amp'));
  const topK = Number(arg('top', '6'));
  const flowAxis = (arg('flow-axis', bh >= bw ? 'y' : 'x')) as 'x' | 'y';
  const emitIntent = argv.includes('--emit-intent');
  const basePath = arg('base-intent', path.join(boardDir, 'layout-intent.yaml'));

  const boardPath = path.join(boardDir, path.basename(boardDir) + '.kicad_pcb');
  const boardText = await readFile(boardPath, 'utf8');
  const { design } = importBoard({ boardText, boardPath });
  const siPath = path.join(boardDir, 'schematic.intent.json');
  const si = JSON.parse(await readFile(siPath, 'utf8'));
  // attachments feed block membership (brick 3c) as well as the intent file
  const baseDoc = existsSync(basePath) ? ((parseYaml(await readFile(basePath, 'utf8')) ?? {}) as Record<string, unknown>) : {};
  const basePl = (baseDoc.placement ?? {}) as Record<string, unknown>;
  const attachHints = ((basePl.attachments ?? []) as Record<string, unknown>[]).flatMap((a) => {
    const t = (a.target ?? {}) as Record<string, unknown>;
    if (typeof a.component !== 'string' || typeof t.component !== 'string' || typeof a.max_distance_mm !== 'number') return [];
    const pins = Array.isArray(t.pins) ? t.pins.map(String) : [];
    return [{ ref: a.component, to: `${t.component}${pins.length ? '.' + pins[0] : ''}`, maxDistanceNm: Math.round(a.max_distance_mm * NM) }];
  });
  const blocks = deriveBlocks({ design, subsystemsMd: null, schematicIntent: si, attachments: attachHints });

  const board: Rect = { x: 0, y: 0, w: Math.round(bw * NM), h: Math.round(bh * NM) };
  const geom = footprintGeometry(boardText);
  // the edges the intent file names, so the floorplan can honour them
  const required = new Map<string, Edge>();
  if (existsSync(basePath)) {
    const base = (parseYaml(await readFile(basePath, 'utf8')) ?? {}) as Record<string, unknown>;
    const pl = (base.placement ?? {}) as Record<string, unknown>;
    for (const f of ((pl.fixed ?? []) as Record<string, unknown>[]))
      if (typeof f.component === 'string' && typeof f.edge === 'string') required.set(f.component, f.edge as Edge);
    for (const r of ((pl.rf ?? []) as Record<string, unknown>[]))
      if (typeof r.ref === 'string' && typeof r.edge === 'string') required.set(r.ref, r.edge as Edge);
  }
  const ds = demands(design, blocks, geom, board, required);
  const adj = blockAdjacency(design, ds);

  // declared signal flow, as block indices
  const order: string[] = si.hints?.groupOrder ?? [];
  const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const flowOrder = order.map((t) => ds.findIndex((d) => d.block.id === slug(t))).filter((i) => i >= 0);

  const demandArea = ds.reduce((a, d) => a + d.areaNm2, 0);
  const u = demandArea / (board.w * board.h);
  const sub = path.basename(boardDir);

  // Report in the register of a short paper: a header, then numbered tables
  // with captions above them, then the figures.
  const rule = (n = 78) => '─'.repeat(n);
  const table = (head: string[], rows: string[][], align: ('l' | 'r')[]) => {
    const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
    const fmt = (cells: string[]) => cells.map((c, i) => align[i] === 'r' ? c.padStart(w[i]!) : c.padEnd(w[i]!)).join('  ').trimEnd();
    return [fmt(head), w.map((n) => '─'.repeat(n)).join('  '), ...rows.map(fmt)].map((l) => '  ' + l);
  };

  console.log();
  console.log(`Subsystem floorplanning of ${sub} on a ${bw} × ${bh} mm outline`);
  console.log(rule());
  console.log(`Five subsystems from schematic.intent.json; regions by exhaustive slicing floorplan`);
  console.log(`(spec v0.2 §10.4). Signal flow runs along ${flowAxis}: ${flowOrder.map((i) => ds[i]!.block.id).join(' → ')}.`);
  console.log();

  const budget = u > 0.95 ? 'reuse.floorplan.infeasible (u > 0.95)'
    : u > 0.62 ? 'reuse.floorplan.block-dense (u > 0.62)'
    : `within budget; ${(0.48 / u).toFixed(2)}× headroom on the 0.48 target`;
  console.log(`Table 1. Area demand by subsystem. Occupancy is the courtyard less any declared`);
  console.log(`keep-out, unioned with the fabrication body. Total ${(demandArea / 1e12).toFixed(0)} mm² of ${(bw * bh).toFixed(0)} mm²,`);
  console.log(`utilisation u = ${u.toFixed(3)}; ${budget}.`);
  console.log();
  console.log(table(
    ['subsystem', 'parts', 'area/mm²', 'largest part/mm', 'edge', 'keep-out'],
    ds.map((d) => [
      d.block.id,
      String(d.members.length),
      (d.areaNm2 / 1e12).toFixed(1),
      `${mm(d.members[0]!.w).toFixed(1)} × ${mm(d.members[0]!.h).toFixed(1)}`,
      d.edgeRefs.join(' ') || '.',
      d.band ? `${d.band.ref} ${mm(d.band.depth).toFixed(0)} mm deep${d.mustTouchEdge ? ', must overhang' : ''}` : '.',
    ]),
    ['l', 'r', 'r', 'r', 'l', 'l'],
  ).join('\n'));

  // exhaustive slicing floorplan
  const areas = ds.map((d) => d.areaNm2);
  const idx = ds.map((_, i) => i);
  const seen = new Map<string, Scored>();
  const rejects: string[] = [];
  let evaluated = 0;
  for (const perm of permutations(idx)) for (const t of trees(perm)) {
    const regions: Rect[] = new Array(ds.length);
    slice(t, board, areas, regions);
    evaluated++;
    // many distinct slicing trees cut the board identically; keep one per layout
    const key = regions.map((r) => `${Math.round(mm(r.x) * 10)},${Math.round(mm(r.y) * 10)},${Math.round(mm(r.w) * 10)},${Math.round(mm(r.h) * 10)}`).join('|');
    if (seen.has(key)) continue;
    const sc = score(regions, ds, adj, board, flowAxis, flowOrder, DEFAULT_WEIGHTS);
    if (sc.fits) seen.set(key, sc); else if (rejects.length < 40000) rejects.push(sc.reject!);
  }
  const scored = [...seen.values()].sort((a, b) => a.cost - b.cost);

  console.log();
  console.log(`${evaluated} slicing floorplans enumerated (${ds.length}! permutations × Catalan(${ds.length - 1}) tree`);
  console.log(`shapes × 2^${ds.length - 1} cut orientations); ${scored.length} distinct feasible layouts, ${rejects.length} rejected.`);

  if (!scored.length) {
    const counts = new Map<string, number>();
    for (const r of rejects) { const k = r.split(':')[0]!; counts.set(k, (counts.get(k) ?? 0) + 1); }
    console.log();
    console.log('Table 2. Rejections by subsystem.');
    console.log();
    console.log(table(['subsystem', 'rejected'], [...counts].sort((x, y) => y[1] - x[1]).map(([k, n]) => [k, String(n)]), ['l', 'r']).join('\n'));
    console.log();
    console.log(`  e.g. ${rejects[0]}`);
    return;
  }

  await mkdir(outDir, { recursive: true });
  const shown = scored.slice(0, topK);
  const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

  console.log();
  console.log(`Table 2. The ${shown.length} lowest-cost floorplans, with the cost decomposed. Panel letters`);
  console.log(`match Figure 1; each is also drawn alone as Figures 2–${shown.length + 1}.`);
  console.log();
  console.log(table(
    ['panel', 'cost', 'adjacency', 'flow', 'aspect', 'edge', 'keep-out', ...ds.map((d) => d.block.id.slice(0, 6))],
    shown.map((c, n) => [
      `(${LETTERS[n] ?? n + 1})`,
      c.cost.toFixed(3), c.terms.adjacency.toFixed(2), c.terms.flow.toFixed(2),
      c.terms.aspect.toFixed(2), c.terms.edge.toFixed(2), c.terms.keepout.toFixed(2),
      ...ds.map((_, i) => `${mm(c.regions[i]!.w).toFixed(0)}×${mm(c.regions[i]!.h).toFixed(0)}@${mm(c.regions[i]!.x).toFixed(0)},${mm(c.regions[i]!.y).toFixed(0)}`),
    ]),
    ['l', 'r', 'r', 'r', 'r', 'r', 'r', ...ds.map(() => 'r' as const)],
  ).join('\n'));

  const parts = ds.reduce((a, d) => a + d.members.length, 0);
  const group = (n: number) => n.toLocaleString('en-US').replace(/,/g, '\u2009');
  await writeFile(path.join(outDir, 'collage.svg'),
    collage(shown, ds, board, `Candidate floorplans for ${sub}, ${bw} × ${bh} mm, ranked by cost.`, 1, {
      title: `Subsystem floorplanning: ${sub}, ${bw} × ${bh} mm`,
      facts: [
        `${parts} parts, ${ds.length} subsystems`,
        `${(demandArea / 1e12).toFixed(0)}/${(bw * bh).toFixed(0)} mm²`,
        `u = ${u.toFixed(3)}`,
        `${group(scored.length)} of ${group(evaluated)} feasible`,
        `best ${scored[0]!.cost.toFixed(3)}`,
      ],
    }));
  await Promise.all(shown.map((c, n) => writeFile(
    path.join(outDir, `floorplan-${String(n + 1).padStart(2, '0')}.svg`),
    svg(c, ds, board, `Floorplan (${LETTERS[n] ?? n + 1}) for ${sub}, ${bw} × ${bh} mm.`, n + 2))));

  if (emitIntent) {
    const base = existsSync(basePath) ? (parseYaml(await readFile(basePath, 'utf8')) ?? {}) : {};
    if (!existsSync(basePath)) console.log(`\n(no base intent at ${path.relative(process.cwd(), basePath)}; emitting regions only)`);
    const names: string[] = [];
    for (const [n, c] of shown.entries()) {
      const letter = LETTERS[n] ?? String(n + 1);
      const name = `intent-${letter}.yaml`;
      await writeFile(path.join(outDir, name), intentForCandidate(c, ds, design, base as Record<string, unknown>, letter, board));
      names.push(name);
    }
    console.log();
    console.log(`Intent written: ${names.join(', ')}`);
  }

  console.log();
  console.log(`Figures written to ${path.relative(process.cwd(), outDir)}/`);
  console.log(`  collage.svg          Figure 1, all ${shown.length} candidates on one plate`);
  console.log(`  floorplan-01..${String(shown.length).padStart(2, '0')}.svg  Figures 2–${shown.length + 1}, one per candidate`);
}

main().catch((e) => { console.error(e); process.exit(1); });
