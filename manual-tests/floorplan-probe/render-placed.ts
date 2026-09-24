/**
 * Render a placed board with every part filled in its subsystem's colour, over
 * the floorplan boxes that were supposed to hold it.
 *
 * `kicad-cli` renders by layer, so a KiCad export cannot show which subsystem a
 * part belongs to, which is the one thing worth seeing when the question is
 * "did the groups land in their regions". Same palette and plate style as the
 * floorplan figures, so the two can be read side by side.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { importBoard } from '../../src/pcb/ir/kicad/import.js';
import { deriveBlocks } from '../../src/pcb/intent/blocks.js';
import { bbox, bboxOf } from '../../src/pcb/ir/geometry.js';
import type { ComponentInstance, PcbDesign } from '../../src/pcb/ir/types.js';

const NM = 1e6;
const mm = (n: number) => n / NM;

const SERIF = "'Latin Modern Roman', 'CMU Serif', Georgia, serif";
const MONO = "'Latin Modern Mono', 'CMU Typewriter Text', 'DejaVu Sans Mono', monospace";
const INK = '#f2f5fa';
const GROUND = '#11151c', BOARD_FILL = '#171c25', BOARD_EDGE = '#e8c15a', RULE = '#313b4a';
const TINT: [string, string][] = [
  ['#1a4533', '#57db8e'], ['#1a2f4a', '#5795db'], ['#341d4a', '#ad57db'],
  ['#421d2b', '#db5776'], ['#424022', '#dbcc57'], ['#1a4522', '#57db57'],
];
const UNASSIGNED: [string, string] = ['#262a33', '#7c8798'];

interface Region { id: string; x: number; y: number; w: number; h: number }

/** Blend two hex colours, `k` of the way from `a` to `b`. */
function blend(a: string, b: string, k: number): string {
  const hex = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const [ar, ag, ab] = hex(a), [br, bg, bb] = hex(b);
  const m = (x: number, y: number) => Math.round(x + (y - x) * k);
  return `#${[m(ar!, br!), m(ag!, bg!), m(ab!, bb!)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** Regions as the generated intent file records them, from its header comment. */
function regionsFromIntent(text: string): Region[] {
  const out: Region[] = [];
  for (const line of text.split('\n')) {
    const m = /^#\s{3}(\S+)\s+([\d.]+)\s*x\s*([\d.]+)\s*mm\s*at\s*\(([\d.-]+),\s*([\d.-]+)\)/.exec(line);
    if (m) out.push({ id: m[1]!, w: +m[2]!, h: +m[3]!, x: +m[4]!, y: +m[5]! });
  }
  return out;
}

/** Pin positions the intent asked for, so a miss is visible rather than inferred. */
function pinnedFromIntent(text: string): Map<string, { x: number; y: number }> {
  const doc = (parseYaml(text) ?? {}) as Record<string, unknown>;
  const placement = (doc.placement ?? {}) as Record<string, unknown>;
  const out = new Map<string, { x: number; y: number }>();
  for (const f of ((placement.fixed ?? []) as Record<string, unknown>[])) {
    if (Array.isArray(f.at) && f.at.length === 2 && typeof f.component === 'string') out.set(f.component, { x: Number(f.at[0]), y: Number(f.at[1]) });
  }
  return out;
}

const extentOf = (c: ComponentInstance) =>
  c.footprint.body ? bbox(c.footprint.body) : c.footprint.courtyard ? bbox(c.footprint.courtyard) : bboxOf(c.pads.map((p) => p.copper));

export function renderPlaced(
  design: PcbDesign, groupOf: Map<string, number>, ids: string[], regions: Region[],
  pinned: Map<string, { x: number; y: number }>, caption: string, figureNo: number,
): string {
  const ob = bbox(design.board.outline);
  const bx = mm(ob.minX), by = mm(ob.minY), bw = mm(ob.maxX - ob.minX), bh = mm(ob.maxY - ob.minY);
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const text = (x: number, y: number, o: { size: number; fill?: string; font?: string; anchor?: string; style?: string }, t: string) =>
    `<text x="${x.toFixed(2)}" y="${y.toFixed(2)}" text-anchor="${o.anchor ?? 'start'}" font-family="${o.font ?? MONO}" font-size="${o.size}" font-weight="bold" fill="${o.fill ?? INK}"${o.style ? ` font-style="${o.style}"` : ''}>${esc(t)}</text>`;
  const p: string[] = [];

  p.push(`<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="${BOARD_FILL}" stroke="${BOARD_EDGE}" stroke-width="0.3"/>`);

  // the regions the floorplan asked for, behind everything
  // Regions as laid blocks rather than outlines: the question is whether a
  // subsystem's parts sit in its block, and a filled block answers that at a
  // glance where a dashed rectangle does not.
  for (const r of regions) {
    const i = ids.indexOf(r.id);
    const [fill, stroke] = i >= 0 ? TINT[i % TINT.length]! : UNASSIGNED;
    p.push(`<rect x="${(bx + r.x).toFixed(2)}" y="${(by + r.y).toFixed(2)}" width="${r.w}" height="${r.h}" fill="${fill}" stroke="${stroke}" stroke-width="0.22" stroke-dasharray="1.6 1.2"/>`);
  }

  // every part, filled by subsystem
  for (const c of design.components) {
    const gi = groupOf.get(c.id);
    const [base, stroke] = gi === undefined ? UNASSIGNED : TINT[gi % TINT.length]!;
    const fill = blend(base, stroke, 0.42);   // stands out against its own block
    const e = extentOf(c);
    const w = mm(e.maxX - e.minX), h = mm(e.maxY - e.minY);
    p.push(`<rect x="${mm(e.minX).toFixed(2)}" y="${mm(e.minY).toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" fill="${fill}" stroke="#0d0f13" stroke-width="0.16"/>`);
    if (w > 2.4 && h > 1.4) p.push(text(mm(e.minX) + w / 2, mm(e.minY) + h / 2 + 0.45, { size: Math.min(1.5, w / 3.2), fill: INK, anchor: 'middle' }, c.reference));
  }

  // Region labels go on last, over the parts. A block is mostly covered by its
  // own members once it is packed, so a label drawn with the block disappears
  // under them; and the label has to say how big the region is, which is the
  // number being judged. A backing plate keeps it legible over whatever it
  // lands on.
  //
  // They sit along the foot of the block, where packing leaves most room. Two
  // regions that share a bottom edge then put their labels at the same height
  // and collide, so a label that lands on one already drawn walks up its own
  // block until it is clear. Widest first, so the label with least freedom to
  // move picks its place before the others crowd it.
  const drawn: { minX: number; minY: number; maxX: number; maxY: number }[] = [];
  const labels = regions
    .map((r) => {
      const i = ids.indexOf(r.id);
      const [, stroke] = i >= 0 ? TINT[i % TINT.length]! : UNASSIGNED;
      const label = `${r.id}  ${r.w.toFixed(1)} \u00d7 ${r.h.toFixed(1)} mm`;
      const size = Math.min(1.5, Math.max(0.85, (r.w - 1.2) / (label.length * 0.55)));
      return { r, stroke, label, size, tw: label.length * size * 0.55 + 0.9, th: size * 1.35 };
    })
    .filter((l) => l.size >= 0.85)
    .sort((x, y) => y.tw - x.tw || x.r.id.localeCompare(y.r.id));

  for (const { r, stroke, label, size, tw, th } of labels) {
    const lx = bx + r.x + 0.5;
    const foot = by + r.y + r.h - th - 0.4;
    const ceiling = by + r.y + 0.4;                 // never leave its own block
    let ly = foot;
    for (let guard = 0; guard < 8; guard++) {
      const box = { minX: lx, maxX: lx + tw, minY: ly, maxY: ly + th };
      const hit = drawn.find((d) => box.minX < d.maxX && d.minX < box.maxX && box.minY < d.maxY && d.minY < box.maxY);
      if (!hit) break;
      const up = hit.minY - th - 0.25;
      if (up < ceiling) break;                      // no room above; leave it where it is
      ly = up;
    }
    drawn.push({ minX: lx, maxX: lx + tw, minY: ly, maxY: ly + th });
    p.push(`<rect x="${lx.toFixed(2)}" y="${ly.toFixed(2)}" width="${tw.toFixed(2)}" height="${th.toFixed(2)}" fill="#0d0f13" fill-opacity="0.82" stroke="${stroke}" stroke-width="0.12"/>`);
    p.push(text(lx + 0.45, ly + th - size * 0.38, { size, fill: stroke }, label));
  }

  // where the intent pinned an anchor, and how far the part actually is
  for (const [ref, at] of pinned) {
    const c = design.components.find((x) => x.reference === ref);
    if (!c) continue;
    const ax = bx + at.x, ay = by + at.y;
    p.push(`<circle cx="${ax.toFixed(2)}" cy="${ay.toFixed(2)}" r="0.7" fill="none" stroke="#e8c15a" stroke-width="0.22"/>`);
    const d = Math.hypot(mm(c.at.x) - ax, mm(c.at.y) - ay);
    if (d > 0.5) p.push(`<line x1="${ax.toFixed(2)}" y1="${ay.toFixed(2)}" x2="${mm(c.at.x).toFixed(2)}" y2="${mm(c.at.y).toFixed(2)}" stroke="#e8c15a" stroke-width="0.16" stroke-dasharray="0.7 0.7"/>`);
  }

  const line1 = `Figure ${figureNo}. ${caption}`;
  // Parts can land outside the outline, and that is exactly what wants seeing,
  // so the view box follows the content rather than the board.
  const all = design.components.map(extentOf);
  const cx0 = Math.min(bx, ...all.map((e) => mm(e.minX))), cx1 = Math.max(bx + bw, ...all.map((e) => mm(e.maxX)));
  const cy0 = Math.min(by, ...all.map((e) => mm(e.minY))), cy1 = Math.max(by + bh, ...all.map((e) => mm(e.maxY)));
  const midX = (cx0 + cx1) / 2;
  // The caption fits the plate, not the other way round. Letting a long caption
  // set the view box left a tile more than twice the board's width, which is
  // mostly empty ground once several are tiled into a contact sheet.
  const pad = 3.5;
  const avail = (cx1 - cx0) + 2 * pad;
  const S1 = Math.max(1.1, Math.min(2.3, avail / (line1.length * 0.465)));
  const capW = Math.min(line1.length * S1 * 0.465, avail);
  const y1 = cy1 + 5.0;
  const x0 = Math.min(cx0 - pad, midX - capW / 2 - pad), x1 = Math.max(cx1 + pad, midX + capW / 2 + pad);
  const vy0 = cy0 - pad, vy1 = y1 + 3.0;
  p.push(`<line x1="${(midX - capW / 2).toFixed(2)}" y1="${(y1 - 2.9).toFixed(2)}" x2="${(midX + capW / 2).toFixed(2)}" y2="${(y1 - 2.9).toFixed(2)}" stroke="${RULE}" stroke-width="0.14"/>`);
  p.push(text(midX, y1, { size: S1, font: SERIF, anchor: 'middle' }, line1));

  const w = x1 - x0, h = vy1 - vy0;
  p.unshift(`<rect x="${x0.toFixed(2)}" y="${vy0.toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" fill="${GROUND}"/>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0.toFixed(2)} ${vy0.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)}" width="${(w * 16).toFixed(0)}" height="${(h * 16).toFixed(0)}">\n${p.join('\n')}\n</svg>\n`;
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (k: string, d = '') => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1]! : d; };
  const boardPath = path.resolve(arg('board'));
  const intentPath = path.resolve(arg('intent'));
  const out = path.resolve(arg('out'));
  const caption = arg('caption', path.basename(boardPath));
  const figureNo = Number(arg('figure', '1'));

  const { design } = importBoard({ boardText: await readFile(boardPath, 'utf8'), boardPath });
  // A candidate board sits several levels down inside the run directory, so the
  // project's schematic intent is not its neighbour; walk up to find it.
  const siPath = arg('schematic-intent') || (() => {
    let d = path.dirname(boardPath);
    for (let i = 0; i < 8; i++) {
      const c = path.join(d, 'schematic.intent.json');
      if (existsSync(c)) return c;
      d = path.dirname(d);
    }
    return path.join(path.dirname(boardPath), 'schematic.intent.json');
  })();
  const si = JSON.parse(await readFile(siPath, 'utf8'));
  const blocks = deriveBlocks({ design, subsystemsMd: null, schematicIntent: si }).filter((b) => b.id !== 'unassigned');
  const ids = blocks.map((b) => b.id);
  const groupOf = new Map<string, number>();
  blocks.forEach((b, i) => { for (const m of b.members) groupOf.set(m, i); });

  const intentText = await readFile(intentPath, 'utf8');
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, renderPlaced(design, groupOf, ids, regionsFromIntent(intentText), pinnedFromIntent(intentText), caption, figureNo));
  console.log(`wrote ${path.relative(process.cwd(), out)}`);
}

if (process.argv[1]?.endsWith('render-placed.ts')) main().catch((e) => { console.error(e); process.exit(1); });
