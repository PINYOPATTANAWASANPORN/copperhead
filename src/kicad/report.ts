export interface ViolationItem {
  description: string;
  x?: number;
  y?: number;
}

export interface Violation {
  severity: 'error' | 'warning' | string;
  type: string;
  description: string;
  sheet?: string;
  items: ViolationItem[];
}

export interface CheckReport {
  ok: boolean;
  source: 'erc' | 'drc';
  /** Error-severity findings: the ones that block. */
  violations: Violation[];
  /**
   * Warning-severity findings (e.g. `lib_footprint_mismatch` on any board
   * KiCad did not author itself, silk-over-courtyard lints). Advisory: listed
   * so a human can weigh them, never counted against `ok` — a gate that
   * blocks on a warning teaches an agent to chase the unfixable.
   */
  warnings: Violation[];
  /**
   * DRC's `unconnected_items`: connections the ratsnest still owes. Kept apart
   * from violations and not counted against `ok`: a first-draft layout leaves
   * nets unrouted by design (SPEC: "leave the rest as ratsnest"), and routing
   * is not a rule the draft can break, only work it has not done. The fab
   * release gate and any caller that needs a fully routed board check this
   * list explicitly.
   */
  unrouted: Violation[];
}

interface RawItem {
  description?: string;
  pos?: { x?: number; y?: number };
}

interface RawViolation {
  severity?: string;
  type?: string;
  description?: string;
  items?: RawItem[];
}

function normViolation(v: RawViolation, sheet?: string): Violation {
  return {
    severity: v.severity ?? 'error',
    type: v.type ?? 'unknown',
    description: v.description ?? '',
    ...(sheet !== undefined ? { sheet } : {}),
    items: (v.items ?? []).map((i) => ({
      description: i.description ?? '',
      ...(i.pos?.x !== undefined ? { x: i.pos.x } : {}),
      ...(i.pos?.y !== undefined ? { y: i.pos.y } : {}),
    })),
  };
}

/**
 * Normalize kicad-cli ERC and DRC JSON reports into one shape. ERC nests
 * violations per sheet; DRC has top-level `violations` plus `unconnected_items`
 * and `schematic_parity`. Tolerant of missing fields across KiCad versions.
 */
export function normalizeReport(raw: unknown, source: 'erc' | 'drc'): CheckReport {
  const r = raw as {
    sheets?: { path?: string; violations?: RawViolation[] }[];
    violations?: RawViolation[];
    unconnected_items?: RawViolation[];
    schematic_parity?: RawViolation[];
  };
  const violations: Violation[] = [];
  const warnings: Violation[] = [];
  const unrouted: Violation[] = [];
  const put = (v: Violation) => (v.severity === 'error' ? violations : warnings).push(v);
  for (const sheet of r.sheets ?? []) {
    for (const v of sheet.violations ?? []) put(normViolation(v, sheet.path));
  }
  for (const v of r.violations ?? []) put(normViolation(v));
  for (const v of r.unconnected_items ?? []) unrouted.push(normViolation(v));
  for (const v of r.schematic_parity ?? []) put(normViolation(v));
  return { ok: violations.length === 0, source, violations, warnings, unrouted };
}

export function formatViolations(report: CheckReport): string {
  const extras =
    (report.unrouted.length ? `; ${report.unrouted.length} unrouted connection(s) remain (ratsnest, not a violation)` : '') +
    (report.warnings.length ? `; ${report.warnings.length} warning(s) (advisory, do not block)` : '');
  const lines = report.ok
    ? [`${report.source.toUpperCase()}: clean${extras}`]
    : [`${report.source.toUpperCase()}: ${report.violations.length} violation(s)${extras}`];
  for (const v of report.violations) {
    const where = v.sheet ? ` [sheet ${v.sheet}]` : '';
    lines.push(`  ${v.severity} ${v.type}${where}: ${v.description}`);
    for (const i of v.items) {
      const pos = i.x !== undefined ? ` @ (${i.x}, ${i.y})` : '';
      lines.push(`    - ${i.description}${pos}`);
    }
  }
  for (const v of report.warnings) {
    lines.push(`  (advisory) ${v.type}: ${v.description}`);
  }
  return lines.join('\n');
}
