/** Scoring profiles (RFC 11 §11.3, ADR 0006). Weights apply to normalized, minimize-all metrics. */
export interface ScoringProfile {
  id: string;
  /** Hard gates on raw metrics: a candidate failing one is ineligible. */
  gates: Record<string, { max?: number; min?: number }>;
  /** Weighted metrics; `higherIsBetter` metrics are negated before normalization. */
  weights: Record<string, number>;
  higherIsBetter: string[];
  /**
   * Ordered tiers (RFC 14 §8.9). A candidate better in an earlier tier wins
   * whatever the later tiers say, which is how a hardware engineer decides: a
   * violated hot loop is not paid for by a shorter net. Each tier is a set of
   * metric keys compared as a sum of normalised values; a difference under
   * `tierTolerance` is a tie and the next tier decides. Profiles without tiers
   * rank exactly as they did before.
   */
  tiers?: string[][];
  /** Relative difference below which a tier is a tie (default 0.02). */
  tierTolerance?: number;
}

/**
 * The engineer's order (RFC 14 §8.9): what the board declares, then the loops,
 * then separation, then whether it can be routed, then length, then neatness.
 * Metrics a candidate does not carry are skipped, so a run without a probe
 * simply decides on the tiers it can measure.
 */
export const ENGINEERING_PLACEMENT_2_LAYER: ScoringProfile = {
  id: 'engineering-placement-2-layer',
  gates: { courtyard_overlap_count: { max: 0 }, outside_board_count: { max: 0 }, unplaced_count: { max: 0 }, drc_placement_critical_count: { max: 0 } },
  weights: { routability_completion: 0.35, hpwl_nm: 0.3, congestion_overflow: 0.2, drc_error_count: 0.1, runtime_s: 0.05 },
  higherIsBetter: ['routability_completion', 'isolation_min_mm', 'critical_completion'],
  tiers: [
    ['intent_hard_violations'],
    ['loop_area_mm2'],
    ['isolation_min_mm'],
    ['critical_completion', 'critical_drc'],
    ['routability_completion', 'routability_drc_critical'],
    ['hpwl_nm'],
    ['congestion_overflow', 'legalized_moves', 'runtime_s'],
  ],
  tierTolerance: 0.02,
};

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

const SCORING: Record<string, ScoringProfile> = { [DEFAULT_LOW_SPEED_2_LAYER.id]: DEFAULT_LOW_SPEED_2_LAYER, [DEFAULT_PLACEMENT_2_LAYER.id]: DEFAULT_PLACEMENT_2_LAYER, [DEFAULT_LOW_SPEED_4_LAYER.id]: DEFAULT_LOW_SPEED_4_LAYER, [DEFAULT_LOW_SPEED_6_LAYER.id]: DEFAULT_LOW_SPEED_6_LAYER, [ENGINEERING_PLACEMENT_2_LAYER.id]: ENGINEERING_PLACEMENT_2_LAYER };

export function loadScoringProfile(id: string): ScoringProfile {
  const p = SCORING[id];
  if (!p) throw new Error(`unknown scoring profile "${id}" (known: ${Object.keys(SCORING).join(', ')})`);
  return p;
}
