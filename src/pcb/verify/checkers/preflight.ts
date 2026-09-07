/**
 * Pre-flight input checks (RFC 11 §10.6, implementation spec §5.3): run once
 * on the snapshot; any error is REFUSE naming the offending refdes or net,
 * before any engine starts.
 */
import type { PcbDesign } from '../../ir/types.js';
import { copperStack, stackProblems } from '../../ir/layers.js';
import type { CheckReport } from '../../../kicad/report.js';
import type { FabricationProfile } from '../profiles/index.js';
import { make, statusOf, type CheckResult, type Diagnostic } from '../diagnostic.js';
import { projectSeverity } from './geometry.js';

export const PREFLIGHT_CHECKER = { id: 'copperhead-preflight', version: '1' };

export interface PreflightInputs {
  /** Symbol pin counts by refdes from the schematic, when one is configured. */
  symbolPins?: Map<string, number>;
  /** A DRC report produced with `--schematic-parity`, when a schematic is configured. */
  parity?: CheckReport;
  /** Refdes.pin pairs the schematic marks as no-connect. */
  noConnects?: Set<string>;
}

/** Imperial pad sizes round to sub-micron shortfalls (0.0354 in = 0.89916 mm); a fab does not see 0.4 µm. */
const ANNULAR_TOLERANCE_NM = 1000;

export function checkPreflight(design: PcbDesign, profile: FabricationProfile, inputs: PreflightInputs = {}): CheckResult {
  const d: Diagnostic[] = [];
  // the copper must be a stack this release can name and route (add-multilayer-layout D1, D3)
  for (const why of stackProblems(design)) d.push(make(PREFLIGHT_CHECKER, 'preflight.stack', { entityIds: [], entityReferences: design.board.layers.filter((l) => l.kind === 'copper').map((l) => l.id), message: why, suggestedActions: ['request-user-action'] }));
  const stackSize = copperStack(design).length;
  if (stackSize >= 2 && profile.layers !== stackSize) d.push(make(PREFLIGHT_CHECKER, 'preflight.profile', { entityIds: [], entityReferences: [profile.id], measured: { value: stackSize, unit: 'count' }, allowed: { value: profile.layers, unit: 'count', relation: '==' }, message: `fabrication profile ${profile.id} is for ${profile.layers} copper layers; the board has ${stackSize}`, suggestedActions: ['request-user-action'] }));
  for (const c of design.components) {
    // logos, plain holes, and fiducials carry no copper: nothing to overlap, so no courtyard is owed
    if (!c.footprint.courtyard && c.pads.some((p) => p.type !== 'np_thru_hole' && p.layers.length)) {
      d.push(make(PREFLIGHT_CHECKER, 'preflight.courtyard', { ...projectSeverity(design, 'missing_courtyard'), entityIds: [c.id], entityReferences: [c.reference], message: `${c.reference} (${c.footprint.libId}) draws no courtyard; overlap cannot be checked`, suggestedActions: ['request-user-action'] }));
    }
    for (const p of c.pads) {
      if (p.type !== 'thru_hole' || !p.drill) continue;
      // a slotted hole is measured against the pad on each axis; a round hole against the pad's short side
      const ring = p.drill.slot ? Math.round(Math.min((p.size.w - p.drill.slot.w) / 2, (p.size.h - p.drill.slot.h) / 2)) : Math.round((Math.min(p.size.w, p.size.h) - p.drill.d) / 2);
      if (ring + ANNULAR_TOLERANCE_NM < profile.minAnnularNm) {
        d.push(make(PREFLIGHT_CHECKER, 'preflight.annular', { entityIds: [p.id], entityReferences: [`${c.reference}.${p.number}`], measured: { value: ring, unit: 'nm' }, allowed: { value: profile.minAnnularNm, unit: 'nm', relation: '>=' }, message: `${c.reference}.${p.number} annular ring is below the ${profile.id} minimum`, suggestedActions: ['request-user-action'] }));
      }
    }
    const pins = inputs.symbolPins?.get(c.reference);
    if (pins !== undefined) {
      const padCount = new Set(c.pads.map((p) => p.number).filter((n) => n)).size;
      if (padCount < pins) {
        d.push(make(PREFLIGHT_CHECKER, 'preflight.pad-count', { entityIds: [c.id], entityReferences: [c.reference], measured: { value: padCount, unit: 'count' }, allowed: { value: pins, unit: 'count', relation: '>=' }, message: `${c.reference}: footprint has ${padCount} pads, symbol has ${pins} pins`, suggestedActions: ['request-user-action'] }));
      }
    }
    if (inputs.noConnects) {
      for (const p of c.pads) {
        if (p.type === 'np_thru_hole' || !p.number) continue;
        if (!p.netId && !inputs.noConnects.has(`${c.reference}.${p.number}`)) {
          d.push(make(PREFLIGHT_CHECKER, 'preflight.unconnected-pin', { entityIds: [p.id], entityReferences: [`${c.reference}.${p.number}`], message: `${c.reference}.${p.number} has no net and no no-connect flag`, suggestedActions: ['request-user-action'] }));
        }
      }
    }
  }
  if (design.lossy.some((l) => l.startsWith('outline'))) {
    d.push(make(PREFLIGHT_CHECKER, 'preflight.outline', { entityIds: [], entityReferences: ['Edge.Cuts'], message: design.lossy.find((l) => l.startsWith('outline'))!, suggestedActions: ['request-user-action'] }));
  }
  for (const v of inputs.parity?.violations ?? []) {
    if (!/parity|schematic/i.test(v.type + v.description)) continue;
    d.push(make(PREFLIGHT_CHECKER, 'preflight.parity', { entityIds: [], entityReferences: v.items.map((i) => i.description), message: v.description, suggestedActions: ['request-user-action'] }));
  }
  return { checker: PREFLIGHT_CHECKER, status: statusOf(d), diagnostics: d, metrics: {}, evidence: [] };
}
