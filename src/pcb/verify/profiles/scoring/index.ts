/** Scoring profiles (RFC 11 §11.3, ADR 0006). Weights apply to normalized, minimize-all metrics. */
export interface ScoringProfile {
  id: string;
  /** Hard gates on raw metrics: a candidate failing one is ineligible. */
  gates: Record<string, { max?: number; min?: number }>;
  /** Weighted metrics; `higherIsBetter` metrics are negated before normalization. */
  weights: Record<string, number>;
  higherIsBetter: string[];
}

export const DEFAULT_LOW_SPEED_2_LAYER: ScoringProfile = {
  id: 'default-low-speed-2-layer',
  gates: { drc_critical_count: { max: 0 }, shorts: { max: 0 } },
  weights: {
    completion_rate: 0.3,
    pour_largest_share: 0.15,
    bottom_signal_length_nm: 0.15,
    total_wirelength_nm: 0.12,
    via_count: 0.12,
    tight_segment_share: 0.06,
    drc_error_count: 0.05,
    runtime_s: 0.05,
  },
  higherIsBetter: ['completion_rate', 'pour_largest_share'],
};

/**
 * Four and six layers (add-multilayer-layout D4): the return path is the plane layers, so the two-layer
 * bottom-copper terms are dropped and the rest renormalised; a plane-integrity metric is later work.
 */
function withoutReturnPath(id: string): ScoringProfile {
  const kept = Object.entries(DEFAULT_LOW_SPEED_2_LAYER.weights).filter(([k]) => k !== 'pour_largest_share' && k !== 'bottom_signal_length_nm');
  const total = kept.reduce((s, [, w]) => s + w, 0);
  return { id, gates: { ...DEFAULT_LOW_SPEED_2_LAYER.gates }, weights: Object.fromEntries(kept.map(([k, w]) => [k, Math.round((w / total) * 1e4) / 1e4])), higherIsBetter: DEFAULT_LOW_SPEED_2_LAYER.higherIsBetter.filter((k) => k !== 'pour_largest_share') };
}
export const DEFAULT_LOW_SPEED_4_LAYER: ScoringProfile = withoutReturnPath('default-low-speed-4-layer');
export const DEFAULT_LOW_SPEED_6_LAYER: ScoringProfile = withoutReturnPath('default-low-speed-6-layer');

/** The routing scoring profile for a copper count. */
export function defaultRoutingScoringFor(copperLayers: number): string {
  return copperLayers >= 6 ? DEFAULT_LOW_SPEED_6_LAYER.id : copperLayers >= 4 ? DEFAULT_LOW_SPEED_4_LAYER.id : DEFAULT_LOW_SPEED_2_LAYER.id;
}

/** Placement candidates (RFC 11 §11.1): routability first, then wirelength and congestion; overlaps and off-board parts are gates. */
export const DEFAULT_PLACEMENT_2_LAYER: ScoringProfile = {
  id: 'default-placement-2-layer',
  gates: { courtyard_overlap_count: { max: 0 }, outside_board_count: { max: 0 }, intent_hard_violations: { max: 0 } },
  weights: {
    routability_completion: 0.35,
    hpwl_nm: 0.3,
    congestion_overflow: 0.2,
    routability_drc_errors: 0.1,
    runtime_s: 0.05,
  },
  higherIsBetter: ['routability_completion'],
};

const SCORING: Record<string, ScoringProfile> = { [DEFAULT_LOW_SPEED_2_LAYER.id]: DEFAULT_LOW_SPEED_2_LAYER, [DEFAULT_PLACEMENT_2_LAYER.id]: DEFAULT_PLACEMENT_2_LAYER, [DEFAULT_LOW_SPEED_4_LAYER.id]: DEFAULT_LOW_SPEED_4_LAYER, [DEFAULT_LOW_SPEED_6_LAYER.id]: DEFAULT_LOW_SPEED_6_LAYER };

export function loadScoringProfile(id: string): ScoringProfile {
  const p = SCORING[id];
  if (!p) throw new Error(`unknown scoring profile "${id}" (known: ${Object.keys(SCORING).join(', ')})`);
  return p;
}
