/**
 * Functional blocks (RFC 11 §7.7, implementation spec §7.2a), the
 * deterministic part: the design's subsystem partition (docs/SUBSYSTEMS.md
 * headings, the schematic intent's `group` per part) becomes one block per
 * subsystem with an anchor, members, a signal-flow region, and a spread
 * budget. No model call; the compiler (Phase 4) may only add roles or propose
 * a split/merge on top of this.
 */
import type { PcbDesign, ComponentInstance } from '../ir/types.js';
import type { Polygon } from '../ir/geometry.js';
import { area, bbox, bboxOf } from '../ir/geometry.js';
import type { Constraint } from '../../memory/constraints.js';

export interface Block {
  /** Slug of the subsystem heading; `unassigned` for parts no subsystem claims. */
  id: string;
  title: string;
  /** Component id of the anchor (the block's main IC, else its largest part). */
  anchor: string | null;
  /** Component ids, anchor included. */
  members: string[];
  /** Signal-flow slot on the board; null when no connector constrains the order. */
  region: Polygon | null;
  spreadBudgetNm: number;
  /** Why this block has no region or anchor, for the intent report. */
  notes: string[];
}

export interface DeriveInput {
  design: PcbDesign;
  /** docs/SUBSYSTEMS.md text; `## Heading` per subsystem. */
  subsystemsMd?: string | null;
  /** schematic.intent.json: parts carry `group` naming a heading. */
  schematicIntent?: { parts: { ref: string; group?: string }[]; hints?: { groupOrder?: string[] } } | null;
}

export function slugify(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'block';
}

export function subsystemHeadings(md: string | null | undefined): string[] {
  if (!md) return [];
  return [...md.matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => m[1]!.trim());
}

const CONNECTOR_REF = /^(J|P|CON|X|USB|SW)\d/i;

export function isConnector(c: ComponentInstance): boolean {
  return c.semanticRoles.includes('connector') || CONNECTOR_REF.test(c.reference) || /Connector|USB|Jack|Header|Socket/i.test(c.footprint.libId);
}

function extentPoly(c: ComponentInstance): Polygon | null {
  if (c.footprint.courtyard) return c.footprint.courtyard;
  if (!c.pads.length) return null;
  const b = bboxOf(c.pads.map((p) => p.copper));
  return { outer: [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }], holes: [] };
}

function extentArea(c: ComponentInstance): number {
  const p = extentPoly(c);
  return p ? Math.abs(area(p)) : 0;
}

/** An edge connector sits within 3 mm of the outline's bounding box. */
function isEdgeConnector(c: ComponentInstance, design: PcbDesign): boolean {
  if (!isConnector(c)) return false;
  const b = bbox(design.board.outline);
  const e = extentPoly(c);
  if (!e) return false;
  const eb = bbox(e);
  const tol = 3_000_000;
  return eb.minX - b.minX < tol || b.maxX - eb.maxX < tol || eb.minY - b.minY < tol || b.maxY - eb.maxY < tol;
}

export function deriveBlocks(input: DeriveInput): Block[] {
  const { design } = input;
  const headings = subsystemHeadings(input.subsystemsMd);
  const order = input.schematicIntent?.hints?.groupOrder?.length ? input.schematicIntent.hints.groupOrder : headings;
  const byRef = new Map(design.components.map((c) => [c.reference, c]));
  const groupOf = new Map<string, string>(); // component id -> heading
  const headingByKey = new Map(headings.map((h) => [h.toLowerCase(), h]));
  for (const part of input.schematicIntent?.parts ?? []) {
    const c = byRef.get(part.ref);
    if (!c || !part.group) continue;
    const h = headingByKey.get(part.group.trim().toLowerCase()) ?? part.group.trim();
    groupOf.set(c.id, h);
  }
  // nets per component and the pad->component map, for anchor selection and connector weighting
  const compOfPad = new Map<string, string>();
  for (const c of design.components) for (const p of c.pads) compOfPad.set(p.id, c.id);
  const netsOf = new Map<string, Set<string>>();
  for (const n of design.nets) {
    if (n.padIds.length < 2) continue;
    for (const pid of n.padIds) {
      const cid = compOfPad.get(pid);
      if (!cid) continue;
      if (!netsOf.has(cid)) netsOf.set(cid, new Set());
      netsOf.get(cid)!.add(n.id);
    }
  }
  const sharedNets = (a: string, b: string): number => {
    const na = netsOf.get(a), nb = netsOf.get(b);
    if (!na || !nb) return 0;
    let k = 0;
    for (const n of na) if (nb.has(n)) k++;
    return k;
  };
  const titles = [...order];
  for (const h of groupOf.values()) if (!titles.includes(h)) titles.push(h);
  const blocks: Block[] = [];
  const claimed = new Set<string>();
  for (const title of titles) {
    const members = design.components.filter((c) => groupOf.get(c.id) === title).map((c) => c.id);
    if (!members.length) continue;
    for (const m of members) claimed.add(m);
    blocks.push(makeBlock(slugify(title), title, members, design, sharedNets));
  }
  const unassigned = design.components.filter((c) => !claimed.has(c.id)).map((c) => c.id);
  if (unassigned.length) {
    const b = makeBlock('unassigned', 'unassigned', unassigned, design, sharedNets);
    b.notes.push(`${unassigned.length} part(s) name no subsystem: ${unassigned.map((id) => design.components.find((c) => c.id === id)!.reference).join(', ')}`);
    blocks.push(b);
  }
  assignRegions(blocks, design, sharedNets);
  return blocks;
}

function makeBlock(id: string, title: string, members: string[], design: PcbDesign, sharedNets: (a: string, b: string) => number): Block {
  const comps = members.map((id) => design.components.find((c) => c.id === id)!);
  // anchor: the IC (>= 8 pads, not a connector) with the most member connections, else the largest part
  const ics = comps.filter((c) => c.pads.length >= 8 && !isConnector(c));
  const score = (c: ComponentInstance) => members.reduce((a, m) => (m === c.id ? a : a + sharedNets(c.id, m)), 0);
  let anchor: ComponentInstance | undefined;
  const notes: string[] = [];
  if (ics.length) anchor = [...ics].sort((a, b) => score(b) - score(a) || extentArea(b) - extentArea(a) || a.reference.localeCompare(b.reference))[0];
  else {
    anchor = [...comps].sort((a, b) => extentArea(b) - extentArea(a) || a.reference.localeCompare(b.reference))[0];
    if (anchor) notes.push(`no IC in the block; ${anchor.reference} (largest part) anchors it`);
  }
  const spread = Math.round(1.5 * Math.sqrt(comps.reduce((a, c) => a + extentArea(c), 0)));
  return { id, title, anchor: anchor?.id ?? null, members, region: null, spreadBudgetNm: spread, notes };
}

/**
 * Signal flow: blocks touching edge connectors take slots left to right in the
 * order of the mean x of the connectors they touch; blocks touching none sit
 * between them in subsystem order. Regions are equal-width vertical slots
 * across the outline. With no edge connector at all, every region is null.
 */
function assignRegions(blocks: Block[], design: PcbDesign, sharedNets: (a: string, b: string) => number): void {
  const edge = design.components.filter((c) => isEdgeConnector(c, design));
  if (!edge.length || blocks.length < 2) {
    for (const b of blocks) if (!edge.length) b.notes.push('no edge connector on the board; no signal-flow region assigned');
    return;
  }
  const weightX = new Map<string, number | null>();
  for (const b of blocks) {
    let w = 0, wx = 0;
    for (const m of b.members) for (const e of edge) {
      if (b.members.includes(e.id)) continue;
      const k = sharedNets(m, e.id);
      if (k) {
        w += k;
        wx += k * e.at.x;
      }
    }
    // a block that contains an edge connector is anchored where that connector is
    for (const e of edge) if (b.members.includes(e.id)) {
      w += 1;
      wx += e.at.x;
    }
    weightX.set(b.id, w ? wx / w : null);
  }
  const xs = [...weightX.values()].filter((v): v is number => v !== null);
  const mid = xs.length ? xs.reduce((a, v) => a + v, 0) / xs.length : 0;
  const ordered = [...blocks].map((b, i) => ({ b, i, x: weightX.get(b.id) ?? mid })).sort((p, q) => p.x - q.x || p.i - q.i);
  const ob = bbox(design.board.outline);
  const margin = design.board.rules.copperEdgeClearanceNm + 1_000_000;
  const x0 = ob.minX + margin, x1 = ob.maxX - margin, y0 = ob.minY + margin, y1 = ob.maxY - margin;
  const slot = (x1 - x0) / ordered.length;
  ordered.forEach(({ b }, i) => {
    if (b.id === 'unassigned') return;
    const sx0 = Math.round(x0 + i * slot), sx1 = Math.round(x0 + (i + 1) * slot);
    b.region = { outer: [{ x: sx0, y: y0 }, { x: sx1, y: y0 }, { x: sx1, y: y1 }, { x: sx0, y: y1 }], holes: [] };
  });
}

/** Registry entries: one `layout.functional.group.<slug>` per block (spec §7.1); region as a JSON string. */
export function blocksToConstraints(blocks: Block[], design: PcbDesign, source = 'blocks'): Record<string, Constraint> {
  const ref = (id: string) => design.components.find((c) => c.id === id)?.reference ?? id;
  const out: Record<string, Constraint> = {};
  for (const b of blocks) {
    if (b.id === 'unassigned') continue;
    out[`layout.functional.group.${b.id}`] = {
      source,
      affects: ['board'],
      class: 'functional',
      severity: 'soft',
      scope: { refs: b.members.map(ref) },
      parameters: { anchor: b.anchor ? ref(b.anchor) : '', members: b.members.map(ref), region: b.region ? JSON.stringify(b.region.outer.map((p) => [p.x, p.y])) : '', spread_budget_nm: b.spreadBudgetNm },
      priority: 50,
      confidence: 1,
      approvedBy: source,
    };
  }
  return out;
}
