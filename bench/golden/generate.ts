/**
 * Golden microboards (RFC 11 §13.2, implementation spec §12.2): ten small
 * boards built from the installed KiCad footprint libraries, each carrying one
 * seeded fault, plus an expected.json naming the diagnostic the harness must
 * raise and what KiCad's own DRC reports for it. Deterministic: the same
 * libraries produce the same bytes. Run with `npx tsx bench/golden/generate.ts`.
 *
 * The generated boards are committed; this script exists so a case can be
 * regenerated after a deliberate change and so the recipe is reviewable.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { instantiateFootprint, footprintSearchDirs } from '../../src/kicad/board.js';
import { parseSexp, children, child, isList, type SexpNode } from '../../src/kicad/sexp.js';
import { uuidv5, knum } from '../../src/kicad/emit.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NS = uuidv5('copperhead-golden');
const id = (p: string) => uuidv5(p, NS);

interface Part { ref: string; fp: string; value: string; x: number; y: number }
interface Seg { net: string; layer: 'F.Cu' | 'B.Cu'; from: [number, number]; to: [number, number]; width?: number }
interface Keepout { rect: [number, number, number, number] }
interface Case {
  name: string;
  fault: string;
  outline: [number, number]; // width, height in mm; origin at (100,100)
  parts: Part[];
  nets: Record<string, string[]>; // net -> ["REF.PAD", ...]
  segments?: Seg[];
  keepouts?: Keepout[];
  intent?: string;
  expected: {
    status: 'PASS' | 'PARTIAL' | 'HOLD' | 'REFUSE';
    diagnostics: { code: string; entityReferences: string[] }[];
    /** errorTypes must all appear; consequential ones may (they follow from the seeded fault); nothing else may. */
    drc: { errorTypes: string[]; consequential?: string[]; unconnected: number };
    metricsWithin?: Record<string, [number, number | null]>;
  };
}

const FP = {
  soic8: 'Package_SO:SOIC-8_3.9x4.9mm_P1.27mm',
  c0603: 'Capacitor_SMD:C_0603_1608Metric',
  r0603: 'Resistor_SMD:R_0603_1608Metric',
  hdr4: 'Connector_PinHeader_2.54mm:PinHeader_1x04_P2.54mm_Vertical',
  hdr2x18: 'Connector_PinHeader_2.54mm:PinHeader_2x18_P2.54mm_Vertical',
  hole: 'MountingHole:MountingHole_3.2mm_M3',
  qfn16: 'Package_DFN_QFN:QFN-16-1EP_3x3mm_P0.5mm_EP1.7x1.7mm',
  xtal: 'Crystal:Crystal_SMD_3225-4Pin_3.2x2.5mm',
  sot223: 'Package_TO_SOT_SMD:SOT-223-3_TabPin2',
};

const atom = (n: SexpNode[] | undefined, i: number) => (typeof n?.[i] === 'string' ? (n![i] as string) : undefined);

/** Pad centres relative to the footprint origin, from the library source. */
function padOffsets(libText: string): Map<string, [number, number]> {
  const root = parseSexp(libText)[0];
  const out = new Map<string, [number, number]>();
  if (!root || !isList(root)) return out;
  for (const pad of children(root, 'pad')) {
    const n = atom(pad, 1);
    const at = child(pad, 'at');
    if (n && at && !out.has(n)) out.set(n, [Number(atom(at, 1)), Number(atom(at, 2))]);
  }
  return out;
}

const HEADER = (name: string) => `(kicad_pcb
	(version 20240108)
	(generator "copperhead-golden")
	(generator_version "0")
	(general
		(thickness 1.6)
		(legacy_teardrops no)
	)
	(paper "A4")
	(title_block
		(title "${name}")
		(comment 1 "copperhead golden microboard; footprints from the KiCad libraries (CC-BY-SA-4.0 with the KiCad library exception)")
	)
	(layers
		(0 "F.Cu" signal)
		(31 "B.Cu" signal)
		(32 "B.Adhes" user "B.Adhesive")
		(33 "F.Adhes" user "F.Adhesive")
		(34 "B.Paste" user)
		(35 "F.Paste" user)
		(36 "B.SilkS" user "B.Silkscreen")
		(37 "F.SilkS" user "F.Silkscreen")
		(38 "B.Mask" user)
		(39 "F.Mask" user)
		(40 "Dwgs.User" user "User.Drawings")
		(41 "Cmts.User" user "User.Comments")
		(42 "Eco1.User" user "User.Eco1")
		(43 "Eco2.User" user "User.Eco2")
		(44 "Edge.Cuts" user)
		(45 "Margin" user)
		(46 "B.CrtYd" user "B.Courtyard")
		(47 "F.CrtYd" user "F.Courtyard")
		(48 "B.Fab" user)
		(49 "F.Fab" user)
	)
	(setup
		(pad_to_mask_clearance 0)
		(allow_soldermask_bridges_in_footprints no)
	)
`;

const PRO = (name: string) =>
  JSON.stringify(
    {
      board: { design_settings: { defaults: {}, rules: { min_copper_edge_clearance: 0.3 } } },
      erc: { rule_severities: {} },
      libraries: { pinned_footprint_libs: [], pinned_symbol_libs: [] },
      meta: { filename: `${name}.kicad_pro`, version: 1 },
      net_settings: {
        classes: [
          { name: 'Default', clearance: 0.2, track_width: 0.25, via_diameter: 0.6, via_drill: 0.3, diff_pair_gap: 0.25, diff_pair_width: 0.2, microvia_diameter: 0.3, microvia_drill: 0.1, wire_width: 6, bus_width: 12, line_style: 0, pcb_color: 'rgba(0, 0, 0, 0.000)', schematic_color: 'rgba(0, 0, 0, 0.000)' },
        ],
        meta: { version: 3 },
      },
      schematic: { legacy_lib_dir: '', legacy_lib_list: [] },
    },
    null,
    2,
  ) + '\n';

async function build(c: Case, dirs: string[], libCache: Map<string, string>): Promise<{ pcb: string; pro: string; expected: unknown; intent?: string }> {
  const netNames = Object.keys(c.nets).sort();
  const code = new Map(netNames.map((n, i) => [n, i + 1]));
  const padNet = new Map<string, { code: number; name: string }>();
  for (const [net, pins] of Object.entries(c.nets)) for (const p of pins) padNet.set(p, { code: code.get(net)!, name: net });

  const chunks: string[] = [];
  const padAbs = new Map<string, [number, number]>();
  for (const part of c.parts) {
    const [lib, fname] = part.fp.split(':') as [string, string];
    let text = libCache.get(part.fp);
    if (!text) {
      for (const d of dirs) {
        try { text = await readFile(path.join(d, `${lib}.pretty`, `${fname}.kicad_mod`), 'utf8'); break; } catch { /* next */ }
      }
      if (!text) throw new Error(`footprint ${part.fp} not installed`);
      libCache.set(part.fp, text);
    }
    const nets = new Map<string, { code: number; name: string }>();
    for (const [pad, off] of padOffsets(text)) {
      padAbs.set(`${part.ref}.${pad}`, [part.x + off[0], part.y + off[1]]);
      const n = padNet.get(`${part.ref}.${pad}`);
      if (n) nets.set(pad, n);
    }
    chunks.push(instantiateFootprint(text, part.fp, part.ref, part.value, { x: part.x, y: part.y }, nets, `golden/${c.name}/${part.ref}`));
  }
  const netTable = ['\t(net 0 "")', ...netNames.map((n) => `\t(net ${code.get(n)} "${n}")`)].join('\n');
  const [w, h] = c.outline;
  const outline = `\t(gr_rect (start 100 100) (end ${knum(100 + w)} ${knum(100 + h)})\n\t\t(stroke (width 0.1) (type default))\n\t\t(layer "Edge.Cuts")\n\t\t(uuid "${id(`${c.name}/outline`)}")\n\t)`;
  const copper: string[] = [];
  for (const [i, s] of (c.segments ?? []).entries()) {
    const from = typeof s.from[0] === 'string' ? padAbs.get(s.from as unknown as string)! : s.from;
    copper.push(
      `\t(segment\n\t\t(start ${knum(from[0])} ${knum(from[1])})\n\t\t(end ${knum(s.to[0])} ${knum(s.to[1])})\n\t\t(width ${knum(s.width ?? 0.25)})\n\t\t(layer "${s.layer}")\n\t\t(net ${code.get(s.net)})\n\t\t(uuid "${id(`${c.name}/seg/${i}`)}")\n\t)`,
    );
  }
  for (const [i, k] of (c.keepouts ?? []).entries()) {
    const [x1, y1, x2, y2] = k.rect;
    copper.push(
      `\t(zone\n\t\t(net 0)\n\t\t(net_name "")\n\t\t(layers "F&B.Cu")\n\t\t(uuid "${id(`${c.name}/keepout/${i}`)}")\n\t\t(name "keepout")\n\t\t(hatch edge 0.5)\n\t\t(connect_pads (clearance 0))\n\t\t(min_thickness 0.25)\n\t\t(filled_areas_thickness no)\n\t\t(keepout (tracks not_allowed) (vias not_allowed) (pads not_allowed) (copperpour not_allowed) (footprints not_allowed))\n\t\t(fill (thermal_gap 0.5) (thermal_bridge_width 0.5))\n\t\t(polygon\n\t\t\t(pts (xy ${knum(x1)} ${knum(y1)}) (xy ${knum(x2)} ${knum(y1)}) (xy ${knum(x2)} ${knum(y2)}) (xy ${knum(x1)} ${knum(y2)}))\n\t\t)\n\t)`,
    );
  }
  const pcb = `${HEADER(c.name)}${netTable}\n${outline}\n${chunks.join('\n')}\n${copper.join('\n')}${copper.length ? '\n' : ''})\n`;
  const expected = { case: c.name, fault: c.fault, generator: 'bench/golden/generate.ts', ...c.expected };
  return { pcb, pro: PRO(c.name), expected, intent: c.intent };
}

/** Absolute pad position helper usable inside case definitions (resolved at build time). */
const P = (ref: string) => ref as unknown as [number, number];

const CASES: Case[] = [
  {
    name: 'overlap',
    fault: 'C1 sits on U1: courtyards overlap',
    outline: [30, 24],
    parts: [{ ref: 'U1', fp: FP.soic8, value: 'OPAMP', x: 114, y: 112 }, { ref: 'C1', fp: FP.c0603, value: '100n', x: 119.05, y: 112 }],
    nets: { VCC: ['U1.8', 'C1.1'], GND: ['U1.4', 'C1.2'] },
    expected: { status: 'REFUSE', diagnostics: [{ code: 'geom.courtyard-overlap', entityReferences: ['U1', 'C1'] }], drc: { errorTypes: ['courtyards_overlap'], unconnected: 2 } },
  },
  {
    name: 'outside-board',
    fault: 'R1 placed wholly beyond the right edge of the outline; KiCad DRC reports nothing for it, so only the geometry checker catches it',
    outline: [30, 24],
    parts: [{ ref: 'U1', fp: FP.soic8, value: 'OPAMP', x: 110, y: 112 }, { ref: 'R1', fp: FP.r0603, value: '10k', x: 133, y: 112 }],
    nets: { SIG: ['U1.1', 'R1.1'], GND: ['U1.4', 'R1.2'] },
    expected: { status: 'REFUSE', diagnostics: [{ code: 'geom.outside-board', entityReferences: ['R1'] }], drc: { errorTypes: [], unconnected: 2 } },
  },
  {
    name: 'fixed-connector',
    fault: 'J1 is constrained to the west edge but sits mid-board',
    outline: [36, 26],
    parts: [{ ref: 'U1', fp: FP.soic8, value: 'MCU', x: 126, y: 113 }, { ref: 'J1', fp: FP.hdr4, value: 'CONN', x: 116, y: 109 }],
    nets: { VCC: ['J1.1', 'U1.8'], GND: ['J1.2', 'U1.4'], SIG1: ['J1.3', 'U1.1'], SIG2: ['J1.4', 'U1.2'] },
    intent: 'placement:\n  fixed:\n    - component: J1\n      edge: west\n      orientation: outward\n',
    expected: { status: 'REFUSE', diagnostics: [{ code: 'intent.mechanical.edge', entityReferences: ['J1'] }], drc: { errorTypes: [], unconnected: 4 } },
  },
  {
    name: 'decoupling-far',
    fault: 'C1 decouples U1 pin 8 but sits 20 mm away',
    outline: [40, 26],
    parts: [{ ref: 'U1', fp: FP.soic8, value: 'MCU', x: 110, y: 110 }, { ref: 'C1', fp: FP.c0603, value: '100n', x: 134, y: 122 }],
    nets: { VCC: ['U1.8', 'C1.1'], GND: ['U1.4', 'C1.2'] },
    intent: 'placement:\n  attachments:\n    - component: C1\n      target: { component: U1, pins: ["8", "4"] }\n      max_distance_mm: 2.0\n      priority: critical\n',
    expected: { status: 'REFUSE', diagnostics: [{ code: 'intent.relative.attached', entityReferences: ['C1', 'U1'] }], drc: { errorTypes: [], unconnected: 2 } },
  },
  {
    name: 'keepout',
    fault: 'R2 sits inside the keepout ring around mounting hole H1',
    outline: [30, 24],
    parts: [{ ref: 'H1', fp: FP.hole, value: 'M3', x: 106, y: 106 }, { ref: 'U1', fp: FP.soic8, value: 'MCU', x: 120, y: 114 }, { ref: 'R2', fp: FP.r0603, value: '4k7', x: 110.3, y: 110.8 }],
    nets: { SIG: ['U1.2', 'R2.1'], VCC: ['U1.8', 'R2.2'] },
    keepouts: [{ rect: [102, 102, 112, 112] }],
    expected: { status: 'REFUSE', diagnostics: [{ code: 'intent.manufacturing.keepout', entityReferences: ['R2'] }], drc: { errorTypes: ['items_not_allowed'], unconnected: 2 } },
  },
  {
    name: 'open',
    fault: 'SIG1 track leaves U1.8 and stops 5 mm short of R1.1',
    outline: [36, 24],
    parts: [{ ref: 'U1', fp: FP.soic8, value: 'MCU', x: 110, y: 112 }, { ref: 'R1', fp: FP.r0603, value: '10k', x: 128, y: 110.1 }],
    nets: { SIG1: ['U1.8', 'R1.1'], GND: ['U1.4', 'R1.2'] },
    segments: [{ net: 'SIG1', layer: 'F.Cu', from: P('U1.8'), to: [122, 110.095] }],
    expected: { status: 'PARTIAL', diagnostics: [{ code: 'conn.open', entityReferences: ['SIG1'] }], drc: { errorTypes: [], unconnected: 2 } },
  },
  {
    name: 'short',
    fault: 'a VCC track from U1.8 lands on C1.1, which is GND',
    outline: [30, 24],
    parts: [{ ref: 'U1', fp: FP.soic8, value: 'MCU', x: 110, y: 112 }, { ref: 'C1', fp: FP.c0603, value: '100n', x: 118, y: 110.095 }],
    nets: { VCC: ['U1.8', 'C1.2'], GND: ['U1.4', 'C1.1'] },
    segments: [{ net: 'VCC', layer: 'F.Cu', from: P('U1.8'), to: [117.175, 110.095] }],
    expected: { status: 'PARTIAL', diagnostics: [{ code: 'conn.short', entityReferences: ['VCC', 'GND'] }], drc: { errorTypes: ['shorting_items'], consequential: ['solder_mask_bridge'], unconnected: 2 } },
  },
  {
    name: 'clearance',
    fault: 'SIG1 and SIG2 tracks end 0.05 mm apart, under the 0.2 mm rule',
    outline: [36, 24],
    parts: [{ ref: 'U1', fp: FP.soic8, value: 'MCU', x: 110, y: 112 }, { ref: 'R1', fp: FP.r0603, value: '10k', x: 128, y: 108 }, { ref: 'R2', fp: FP.r0603, value: '10k', x: 128, y: 116 }],
    nets: { SIG1: ['U1.8', 'R1.1'], SIG2: ['U1.7', 'R2.1'], GND: ['U1.4', 'R1.2', 'R2.2'] },
    segments: [
      { net: 'SIG1', layer: 'F.Cu', from: P('U1.8'), to: [118, 110.095] },
      { net: 'SIG1', layer: 'F.Cu', from: [118, 110.095], to: [124, 110.095] },
      { net: 'SIG2', layer: 'F.Cu', from: P('U1.7'), to: [118, 111.365] },
      { net: 'SIG2', layer: 'F.Cu', from: [118, 111.365], to: [124, 110.395] },
    ],
    expected: { status: 'PARTIAL', diagnostics: [{ code: 'drc.clearance', entityReferences: ['SIG1', 'SIG2'] }], drc: { errorTypes: ['clearance'], unconnected: 4 } },
  },
  {
    name: 'completion',
    fault: 'legal placement, nothing routed: every connection is owed',
    outline: [36, 26],
    parts: [
      { ref: 'U1', fp: FP.soic8, value: 'MCU', x: 116, y: 113 },
      { ref: 'C1', fp: FP.c0603, value: '100n', x: 116, y: 106.5 },
      { ref: 'R1', fp: FP.r0603, value: '10k', x: 124, y: 108 },
      { ref: 'R2', fp: FP.r0603, value: '10k', x: 124, y: 118 },
      { ref: 'Y1', fp: FP.xtal, value: '8MHz', x: 107, y: 118 },
      { ref: 'J1', fp: FP.hdr4, value: 'CONN', x: 132, y: 109 },
    ],
    nets: {
      VCC: ['U1.8', 'C1.1', 'R1.1', 'R2.1', 'J1.1'],
      GND: ['U1.4', 'C1.2', 'Y1.2', 'Y1.4', 'J1.2'],
      SIG1: ['U1.1', 'R1.2', 'J1.3'],
      SIG2: ['U1.2', 'R2.2', 'J1.4'],
      XI: ['U1.5', 'Y1.1'],
      XO: ['U1.6', 'Y1.3'],
    },
    expected: { status: 'PARTIAL', diagnostics: [{ code: 'conn.unrouted', entityReferences: ['VCC', 'GND', 'SIG1', 'SIG2', 'XI', 'XO'] }], drc: { errorTypes: [], unconnected: 14 } },
  },
  {
    name: 'congestion',
    fault: 'a 2x18 header on the left fans 16 signals into a QFN on the right through one channel',
    outline: [44, 50],
    parts: [
      { ref: 'J2', fp: FP.hdr2x18, value: 'CONN', x: 104, y: 103 },
      { ref: 'U2', fp: FP.qfn16, value: 'MCU', x: 136, y: 124 },
      { ref: 'C1', fp: FP.c0603, value: '100n', x: 136, y: 118 },
      { ref: 'R1', fp: FP.r0603, value: '10k', x: 136, y: 130 },
    ],
    nets: Object.fromEntries([
      ...Array.from({ length: 16 }, (_, i) => [`S${i + 1}`, [`J2.${i + 1}`, `U2.${i + 1}`]]),
      ['VCC', ['J2.35', 'C1.1', 'R1.1']],
      ['GND', ['J2.36', 'C1.2', 'U2.17']],
      ['PU', ['R1.2', 'J2.34']],
    ]),
    expected: {
      status: 'PARTIAL',
      diagnostics: [{ code: 'quality.congestion', entityReferences: ['J2'] }],
      drc: { errorTypes: [], unconnected: 21 },
      metricsWithin: { congestion_overflow: [1, null] },
    },
  },
];

// RFC 11 §13.3 categories beyond the first ten (Phase 4): decoupling around a QFN, LDO capacitor
// attachment, crystal load capacitors, analog/digital separation, power-width. Each is one seeded
// intent fault the intent checker must raise; KiCad DRC sees none of them.
CASES.push(
  {
    name: 'decoupling-qfn',
    fault: 'C1 decouples the QFN pin 16 but sits 12 mm away; C2 is placed right',
    outline: [36, 26],
    parts: [{ ref: 'U1', fp: FP.qfn16, value: 'RF', x: 112, y: 112 }, { ref: 'C1', fp: FP.c0603, value: '100n', x: 126, y: 120 }, { ref: 'C2', fp: FP.c0603, value: '100n', x: 112.75, y: 115.5 }],
    nets: { VDD: ['U1.16', 'C1.1'], VDDA: ['U1.8', 'C2.1'], GND: ['U1.17', 'C1.2', 'C2.2'] },
    intent: 'placement:\n  attachments:\n    - component: C1\n      target: { component: U1, pins: ["16"] }\n      max_distance_mm: 1.5\n      priority: critical\n    - component: C2\n      target: { component: U1, pins: ["8"] }\n      max_distance_mm: 2.5\n      priority: critical\n',
    expected: { status: 'REFUSE', diagnostics: [{ code: 'intent.relative.attached', entityReferences: ['C1', 'U1'] }], drc: { errorTypes: [], unconnected: 4 } },
  },
  {
    name: 'ldo-caps',
    fault: 'the LDO output capacitor C2 sits 15 mm from the regulator; the input capacitor C1 is attached',
    outline: [40, 26],
    parts: [{ ref: 'U1', fp: FP.sot223, value: 'AMS1117-3.3', x: 112, y: 112 }, { ref: 'C1', fp: FP.c0603, value: '10u', x: 105.9, y: 114.3 }, { ref: 'C2', fp: FP.c0603, value: '10u', x: 130, y: 118 }],
    nets: { VIN: ['U1.3', 'C1.1'], VOUT: ['U1.2', 'U1.4', 'C2.1'], GND: ['U1.1', 'C1.2', 'C2.2'] },
    intent: 'placement:\n  attachments:\n    - component: C1\n      target: { component: U1, pins: ["3"] }\n      max_distance_mm: 3\n      priority: critical\n    - component: C2\n      target: { component: U1, pins: ["2"] }\n      max_distance_mm: 3\n      priority: critical\n',
    expected: { status: 'REFUSE', diagnostics: [{ code: 'intent.relative.attached', entityReferences: ['C2', 'U1'] }], drc: { errorTypes: [], unconnected: 5 } },
  },
  {
    name: 'crystal',
    fault: 'the crystal block (Y1, C1, C2) has a 4 mm spread budget; C2 sits 11 mm from the MCU',
    outline: [36, 26],
    parts: [{ ref: 'U1', fp: FP.soic8, value: 'MCU', x: 110, y: 112 }, { ref: 'Y1', fp: FP.xtal, value: '16M', x: 116, y: 112 }, { ref: 'C1', fp: FP.c0603, value: '22p', x: 116, y: 108 }, { ref: 'C2', fp: FP.c0603, value: '22p', x: 121, y: 118 }],
    nets: { XI: ['U1.1', 'Y1.1', 'C1.1'], XO: ['U1.2', 'Y1.3', 'C2.1'], GND: ['U1.4', 'Y1.2', 'Y1.4', 'C1.2', 'C2.2'] },
    intent: 'placement:\n  groups:\n    - id: clock\n      components: [U1, Y1, C1, C2]\n      max_spread_mm: 8\n',
    expected: { status: 'PARTIAL', diagnostics: [{ code: 'intent.functional.group.spread', entityReferences: ['C2'] }], drc: { errorTypes: [], unconnected: 8 } },
  },
  {
    name: 'separation',
    fault: 'the analog front end (U1, R1) and the digital block (U2, R2) must stay 10 mm apart; they are 3 mm apart',
    outline: [40, 26],
    parts: [{ ref: 'U1', fp: FP.soic8, value: 'OPAMP', x: 110, y: 112 }, { ref: 'R1', fp: FP.r0603, value: '10k', x: 110, y: 118 }, { ref: 'U2', fp: FP.soic8, value: 'MCU', x: 118.5, y: 112 }, { ref: 'R2', fp: FP.r0603, value: '10k', x: 118.5, y: 118 }],
    nets: { AIN: ['U1.1', 'R1.1'], SIG: ['U1.6', 'U2.3'], GND: ['U1.4', 'U2.4', 'R1.2', 'R2.2'], IO: ['U2.5', 'R2.1'] },
    intent: 'placement:\n  groups:\n    - id: analog\n      components: [U1, R1]\n    - id: digital\n      components: [U2, R2]\n  separation:\n    - groups: [analog, digital]\n      minimum_mm: 10\n',
    expected: { status: 'REFUSE', diagnostics: [{ code: 'intent.functional.separation', entityReferences: ['U1', 'U2'] }], drc: { errorTypes: [], unconnected: 6 } },
  },
  {
    name: 'power-width',
    fault: 'VIN carries 2 A and is routed at 0.25 mm; the intent asks for 0.8 mm',
    outline: [36, 26],
    parts: [{ ref: 'J1', fp: FP.hdr4, value: 'PWR', x: 104, y: 108 }, { ref: 'U1', fp: FP.sot223, value: 'LDO', x: 122, y: 112 }],
    nets: { VIN: ['J1.1', 'U1.3'], GND: ['J1.2', 'U1.1'] },
    segments: [{ net: 'VIN', layer: 'F.Cu', from: [104, 108], to: [116, 108], width: 0.25 }, { net: 'VIN', layer: 'F.Cu', from: [116, 108], to: [116, 112], width: 0.25 }],
    intent: 'routing:\n  widths:\n    - net: VIN\n      min_width_mm: 0.8\n  currents:\n    - net: VIN\n      amps: 2\n',
    expected: { status: 'PARTIAL', diagnostics: [{ code: 'intent.routing.width', entityReferences: ['VIN'] }], drc: { errorTypes: [], unconnected: 2 } },
  },
);

async function main(): Promise<void> {
  const dirs = await footprintSearchDirs();
  if (!dirs.length) throw new Error('no KiCad footprint libraries installed (set KICAD_FOOTPRINT_DIR)');
  const libCache = new Map<string, string>();
  for (const c of CASES) {
    const dir = path.join(HERE, c.name);
    await mkdir(dir, { recursive: true });
    const out = await build(c, dirs, libCache);
    await writeFile(path.join(dir, 'board.kicad_pcb'), out.pcb, 'utf8');
    await writeFile(path.join(dir, 'board.kicad_pro'), out.pro, 'utf8');
    await writeFile(path.join(dir, 'expected.json'), JSON.stringify(out.expected, null, 2) + '\n', 'utf8');
    if (out.intent) await writeFile(path.join(dir, 'intent.yaml'), out.intent, 'utf8');
    console.log(`wrote ${c.name}`);
  }
}

await main();
