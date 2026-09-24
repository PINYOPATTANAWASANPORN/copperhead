/**
 * Score a placed board against the floorplan and intent it was placed from.
 *
 * The placement profile scores a board on wirelength, overlaps and congestion:
 * whether it is *manufacturable*. None of that says whether the board is the
 * one that was asked for. These metrics answer that instead, and are ordered
 * the way an engineer would read them, worst class first.
 *
 * Reported per candidate so six floorplans can be compared on the same terms.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { parseSexp, children, child, isList } from '../../src/kicad/sexp.js';
import { importBoard } from '../../src/pcb/ir/kicad/import.js';
import { deriveBlocks } from '../../src/pcb/intent/blocks.js';
import { matingFace } from '../../src/pcb/engines/legalize.js';
import { bbox, bboxOf } from '../../src/pcb/ir/geometry.js';
import type { BBox } from '../../src/pcb/ir/geometry.js';
import type { ComponentInstance, PcbDesign } from '../../src/pcb/ir/types.js';

const NM = 1e6;
const mm = (n: number) => n / NM;
type Edge = 'north' | 'south' | 'east' | 'west';

export interface Review {
  /** Share of parts whose extent lies wholly inside their subsystem's region. */
  containment: number;
  /** Mean distance a stray part's extent lies outside its region, mm. */
  overflowMm: number;
  /** Share of edge connectors whose mating face points at the edge they were given. */
  orientation: number;
  /** Mean distance from an edge connector's extent to the edge it was given, mm. */
  edgeGapMm: number;
  /** Distance from the radio's antenna side to the edge it was given, mm. */
  antennaEdgeMm: number;
  /** Share of the antenna keep-out's on-board area free of other parts. */
  antennaClear: number;
  /** Attachments placed further from their pin than their budget allows. */
  attachMiss: number;
  attachTotal: number;
  /** Parts overlapping another part's extent. */
  overlaps: number;
  notes: string[];
}

const extentOf = (c: ComponentInstance): BBox => {
  const pads = c.pads.length ? bboxOf(c.pads.map((p) => p.copper)) : null;
  const body = c.footprint.body ? bbox(c.footprint.body) : null;
  if (pads && body) return { minX: Math.min(pads.minX, body.minX), maxX: Math.max(pads.maxX, body.maxX), minY: Math.min(pads.minY, body.minY), maxY: Math.max(pads.maxY, body.maxY) };
  return pads ?? body ?? bbox(c.footprint.courtyard!);
};

const overlapArea = (a: BBox, b: BBox) =>
  Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX)) * Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY));

/** How far `e` sticks out of `r`, as the largest single-axis excess. */
function outsideBy(e: BBox, r: BBox): number {
  return Math.max(0, r.minX - e.minX, e.maxX - r.maxX, r.minY - e.minY, e.maxY - r.maxY);
}

interface Region { id: string; x: number; y: number; w: number; h: number }

export function regionsFromIntent(text: string): Region[] {
  const out: Region[] = [];
  for (const line of text.split('\n')) {
    const m = /^#\s{3}(\S+)\s+([\d.]+)\s*x\s*([\d.]+)\s*mm\s*at\s*\(([\d.-]+),\s*([\d.-]+)\)/.exec(line);
    if (m) out.push({ id: m[1]!, w: +m[2]!, h: +m[3]!, x: +m[4]!, y: +m[5]! });
  }
  return out;
}

/**
 * The antenna keep-out, read off the footprint s-expression.
 *
 * `importBoard` carries board-level `zone` blocks only, so a keep-out declared
 * inside a `footprint` never reaches `design.board.keepouts`. Without this the
 * metric has no zone to test, which is how it came to measure the strip between
 * the module and the board edge instead — a different rectangle entirely, and
 * one that read 100% while eighteen parts sat in the real zone.
 */
export function footprintKeepout(boardText: string, ref: string): { dx: number; dy: number; w: number; h: number } | null {
  const walk = (node: unknown[]): { dx: number; dy: number; w: number; h: number } | null => {
    for (const fp of children(node as never, 'footprint')) {
      let r = '';
      for (const q of children(fp, 'property')) if (String(q[1]).replace(/"/g, '') === 'Reference') r = String(q[2] ?? '');
      if (r !== ref) continue;
      for (const z of children(fp, 'zone')) {
        if (!child(z, 'keepout')) continue;
        const poly = child(z, 'polygon');
        const pts = poly ? child(poly, 'pts') : undefined;
        if (!pts) continue;
        const xs: number[] = [], ys: number[] = [];
        for (const q of pts.slice(1)) if (isList(q) && q[0] === 'xy') { xs.push(Number(q[1])); ys.push(Number(q[2])); }
        if (!xs.length) continue;
        // offsets from the footprint origin, so the zone follows the part
        return { dx: Math.min(...xs) * NM, dy: Math.min(...ys) * NM, w: (Math.max(...xs) - Math.min(...xs)) * NM, h: (Math.max(...ys) - Math.min(...ys)) * NM };
      }
    }
    return null;
  };
  for (const n of parseSexp(boardText)) {
    if (!isList(n)) continue;
    const hit = walk(n as never);
    if (hit) return hit;
  }
  return null;
}

export function review(design: PcbDesign, intentText: string, si: unknown, boardText?: string): Review {
  const doc = (parseYaml(intentText) ?? {}) as Record<string, unknown>;
  const placement = (doc.placement ?? {}) as Record<string, unknown>;
  const ob = bbox(design.board.outline);
  const byRef = new Map(design.components.map((c) => [c.reference, c]));
  const notes: string[] = [];

  // ---- 1. bounding box: is each part in the block it was given? ------------
  const blocks = deriveBlocks({ design, subsystemsMd: null, schematicIntent: si as never }).filter((b) => b.id !== 'unassigned');
  const regions = new Map(regionsFromIntent(intentText).map((r) => [r.id, r]));
  let inside = 0, counted = 0, overflow = 0, strays = 0;
  for (const b of blocks) {
    const r = regions.get(b.id);
    if (!r) continue;
    const box: BBox = { minX: ob.minX + r.x * NM, maxX: ob.minX + (r.x + r.w) * NM, minY: ob.minY + r.y * NM, maxY: ob.minY + (r.y + r.h) * NM };
    for (const id of b.members) {
      const c = design.components.find((x) => x.id === id);
      if (!c) continue;
      counted++;
      const out = outsideBy(extentOf(c), box);
      if (out <= 0) inside++;
      else { strays++; overflow += mm(out); notes.push(`${c.reference} is ${mm(out).toFixed(1)} mm outside ${b.id}`); }
    }
  }

  // ---- 2. connector orientation and edge adherence ------------------------
  let facing = 0, conns = 0, gap = 0;
  for (const f of ((placement.fixed ?? []) as Record<string, unknown>[])) {
    const edge = typeof f.edge === 'string' ? (f.edge as Edge) : null;
    const c = typeof f.component === 'string' ? byRef.get(f.component) : undefined;
    if (!edge || !c) continue;
    conns++;
    const e = extentOf(c);
    const d = edge === 'north' ? e.minY - ob.minY : edge === 'south' ? ob.maxY - e.maxY : edge === 'west' ? e.minX - ob.minX : ob.maxX - e.maxX;
    gap += mm(Math.max(0, d));
    if (String(f.orientation) !== 'outward') { facing++; continue; }
    const face = matingFace(c);
    if (face === null) { facing++; notes.push(`${c.reference}: no in-plane facing, orientation not applicable`); continue; }
    if (face === edge) facing++;
    else notes.push(`${c.reference} faces ${face}, was asked for ${edge}`);
    if (mm(Math.max(0, d)) > 1) notes.push(`${c.reference} sits ${mm(Math.max(0, d)).toFixed(1)} mm from its ${edge} edge`);
  }

  // ---- 3. antenna: at its edge, and nothing under its on-board keep-out ----
  let antennaEdgeMm = NaN, antennaClear = NaN;
  for (const rf of ((placement.rf ?? []) as Record<string, unknown>[])) {
    const c = typeof rf.ref === 'string' ? byRef.get(rf.ref) : undefined;
    const edge = typeof rf.edge === 'string' ? (rf.edge as Edge) : null;
    if (!c || !edge) continue;
    const e = extentOf(c);
    const d = edge === 'north' ? e.minY - ob.minY : edge === 'south' ? ob.maxY - e.maxY : edge === 'west' ? e.minX - ob.minX : ob.maxX - e.maxX;
    antennaEdgeMm = mm(Math.max(0, d));
    // The declared keep-out, following the part, clipped to the board: what
    // hangs off is over air and free. Anything left on board must carry nothing.
    const ko = boardText ? footprintKeepout(boardText, c.reference) : null;
    const zone: BBox | null = ko
      ? { minX: c.at.x + ko.dx, maxX: c.at.x + ko.dx + ko.w, minY: c.at.y + ko.dy, maxY: c.at.y + ko.dy + ko.h }
      : null;
    const band: BBox = zone
      ? { minX: Math.max(zone.minX, ob.minX), maxX: Math.min(zone.maxX, ob.maxX), minY: Math.max(zone.minY, ob.minY), maxY: Math.min(zone.maxY, ob.maxY) }
      : edge === 'north' ? { minX: e.minX, maxX: e.maxX, minY: ob.minY, maxY: e.minY }
      : edge === 'south' ? { minX: e.minX, maxX: e.maxX, minY: e.maxY, maxY: ob.maxY }
      : edge === 'west' ? { minX: ob.minX, maxX: e.minX, minY: e.minY, maxY: e.maxY }
      : { minX: e.maxX, maxX: ob.maxX, minY: e.minY, maxY: e.maxY };
    if (!zone) notes.push(`${c.reference}: no declared keep-out found; measuring the edge strip instead`);
    const area = Math.max(0, band.maxX - band.minX) * Math.max(0, band.maxY - band.minY);
    if (area <= 0) { antennaClear = 1; break; }
    let taken = 0;
    for (const o of design.components) {
      if (o.id === c.id) continue;
      const a = overlapArea(extentOf(o), band);
      if (a > 0) { taken += a; notes.push(`${o.reference} sits in ${c.reference}'s antenna keep-out`); }
    }
    antennaClear = Math.max(0, 1 - taken / area);
    if (antennaEdgeMm > 1) notes.push(`${c.reference} is ${antennaEdgeMm.toFixed(1)} mm from the ${edge} edge; its antenna wants the edge`);
    break;
  }

  // ---- 4. attachments kept within their stated budget ----------------------
  let attachMiss = 0, attachTotal = 0;
  for (const a of ((placement.attachments ?? []) as Record<string, unknown>[])) {
    const part = typeof a.component === 'string' ? byRef.get(a.component) : undefined;
    const t = (a.target ?? {}) as Record<string, unknown>;
    const target = typeof t.component === 'string' ? byRef.get(t.component) : undefined;
    const budget = typeof a.max_distance_mm === 'number' ? a.max_distance_mm : null;
    if (!part || !target || budget === null) continue;
    attachTotal++;
    const pins = Array.isArray(t.pins) ? t.pins.map(String) : [];
    const pad = pins.length ? target.pads.find((q) => pins.includes(q.number)) : undefined;
    const at = pad ? pad.at : target.at;
    const d = mm(Math.hypot(part.at.x - at.x, part.at.y - at.y));
    if (d > budget) { attachMiss++; notes.push(`${part.reference} is ${d.toFixed(1)} mm from ${String(t.component)}${pins.length ? '.' + pins[0] : ''}, budget ${budget}`); }
  }

  // ---- 5. parts on top of one another -------------------------------------
  let overlaps = 0;
  const es = design.components.map((c) => ({ c, e: extentOf(c) }));
  for (let i = 0; i < es.length; i++) for (let j = i + 1; j < es.length; j++) if (overlapArea(es[i]!.e, es[j]!.e) > 0) overlaps++;

  return {
    containment: counted ? inside / counted : 1,
    overflowMm: strays ? overflow / strays : 0,
    orientation: conns ? facing / conns : 1,
    edgeGapMm: conns ? gap / conns : 0,
    antennaEdgeMm, antennaClear,
    attachMiss, attachTotal, overlaps, notes,
  };
}

/** Lexicographic, worst class first: a board in the wrong place is not improved by being tidy. */
export function score(r: Review): number {
  const t = [
    1 - r.containment,                                   // parts outside their block
    Number.isNaN(r.antennaClear) ? 0 : 1 - r.antennaClear,
    1 - r.orientation,
    r.attachTotal ? r.attachMiss / r.attachTotal : 0,
    Math.min(1, r.overlaps / 20),
    Math.min(1, r.edgeGapMm / 10),
  ];
  return t.reduce((acc, v, i) => acc + v * Math.pow(10, -i), 0);
}

async function main() {
  const base = path.resolve(process.argv[2] ?? 'manual-tests/runs/floorplan-place/esp32-amp');
  const letters = (process.argv[3] ?? 'abcdef').split('');
  const rows: { l: string; engine: string; r: Review }[] = [];
  for (const l of letters) {
    const intentPath = path.join(base, 'floorplan', `intent-${l}.yaml`);
    if (!existsSync(intentPath)) continue;
    const runDir = path.join(base, l, '.copperhead', 'runs', 'place');
    const ranking = JSON.parse(await readFile(path.join(runDir, 'ranking.json'), 'utf8')) as { candidates: { id: string; metrics: Record<string, number | null> }[] };
    // review the cleanest candidate, not the ranked one: the ranking optimises
    // wirelength and is not the question being asked here
    const ok = ranking.candidates.filter((c) => c.metrics.courtyard_overlap_count !== null && c.metrics.courtyard_overlap_count !== undefined);
    const best = ok.sort((a, b) => (a.metrics.courtyard_overlap_count! - b.metrics.courtyard_overlap_count!) || ((a.metrics.hpwl_nm ?? 0) - (b.metrics.hpwl_nm ?? 0)))[0];
    if (!best) continue;
    let boardPath = '';
    for (const d of [best.id, `${best.id}-0`, `${best.id}-1`, `${best.id}-2`, `${best.id}-3`, `${best.id}-4`, `${best.id}-5`, `${best.id}-6`]) {
      const c = path.join(runDir, 'candidates', d, 'candidate.kicad_pcb');
      if (existsSync(c)) { boardPath = c; break; }
    }
    if (!boardPath) continue;
    const { design } = importBoard({ boardText: await readFile(boardPath, 'utf8'), boardPath });
    const si = JSON.parse(await readFile(path.join(base, l, 'schematic.intent.json'), 'utf8'));
    rows.push({ l, engine: best.id, r: review(design, await readFile(intentPath, 'utf8'), si) });
  }

  const pct = (v: number) => (Number.isNaN(v) ? '  -  ' : `${(v * 100).toFixed(0).padStart(3)}%`);
  console.log();
  console.log('Intent conformance, per floorplan candidate. Cleanest placement of each.');
  console.log('─'.repeat(94));
  console.log('  cand  engine                    in-block  overflow  antenna  ant.gap  facing  attach   overlaps  score');
  console.log('  ' + '─'.repeat(90));
  for (const { l, engine, r } of rows.sort((a, b) => score(a.r) - score(b.r))) {
    console.log(`  (${l})   ${engine.replace('placer-', '').padEnd(22)} ${pct(r.containment)}  ${r.overflowMm.toFixed(1).padStart(6)}mm  ${pct(r.antennaClear)}  ${(Number.isNaN(r.antennaEdgeMm) ? 0 : r.antennaEdgeMm).toFixed(1).padStart(5)}mm  ${pct(r.orientation)}  ${String(r.attachMiss).padStart(2)}/${String(r.attachTotal).padEnd(2)}  ${String(r.overlaps).padStart(7)}  ${score(r).toFixed(4)}`);
  }
  console.log();
  const worst = rows.sort((a, b) => score(b.r) - score(a.r))[0];
  const best = rows.sort((a, b) => score(a.r) - score(b.r))[0];
  if (best) {
    console.log(`Best: (${best.l}). Its findings:`);
    for (const n of best.r.notes.slice(0, 14)) console.log(`  · ${n}`);
    if (best.r.notes.length > 14) console.log(`  · … and ${best.r.notes.length - 14} more`);
  }
  if (worst && best && worst.l !== best.l) console.log(`\nWorst: (${worst.l}), score ${score(worst.r).toFixed(4)}, ${worst.r.notes.length} findings.`);
}

if (process.argv[1]?.endsWith('review.ts')) main().catch((e) => { console.error(e); process.exit(1); });
