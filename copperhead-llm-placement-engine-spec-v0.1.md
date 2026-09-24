# Copperhead LLM-Guided PCB Placement Engine

**Document ID:** CH-PLACE-0001  
**Version:** 0.1  
**Status:** Draft for implementation  
**Target:** Copperhead PCB layout pipeline  
**Initial scope:** Two-layer, low-speed PCBs with up to 50 electrical components  

## 1. Summary

Copperhead Placement Engine generates legal, ranked PCB component placements from Copperhead's `PCB IR`, an optional existing KiCad board and optional reference boards.

The engine is hybrid:

- The LLM interprets engineering intent, identifies functional blocks, derives typed constraints, matches reference components and selects placement strategies.
- Deterministic tools calculate coordinates, transform reference placements, pack footprints, detect collisions, legalize candidates and invoke verification.
- Copperhead commits a placement only after hard constraints pass. Invalid candidates cannot win through a better soft score.

The first product goal is not arbitrary autonomous placement. It is reliable placement reuse and assisted placement for small boards, producing either ranked, inspectable KiCad outputs or a structured failure.

## 2. Goals

1. Reuse an existing board or board revision as a placement prior.
2. Preserve fixed mechanical components and high-confidence engineering relationships.
3. Place new or unmatched components near their owning functional blocks.
4. Generate multiple deterministic candidates from a bounded strategy set.
5. Evaluate placement through legality, intent compliance and downstream routability.
6. Explain every copied, inferred, moved or rejected placement decision.
7. Produce reproducible results for the same inputs, engine versions and seed.
8. Keep Copperhead's versioned `PCB IR` as the canonical engine input and KiCad as an output and verification target.

## 3. Non-goals for v1

- General placement for arbitrary multilayer, RF, high-speed or dense boards.
- Direct coordinate generation by an LLM.
- Automatic enclosure or mechanical design inference without explicit geometry.
- Full thermal, SI, PI or EMC simulation.
- Learned placement policies or reinforcement learning.
- One universal scalar score that hides validity failures.
- Automatic modification of the source reference board.

## 4. Design principles

### 4.1 Models express intent, tools own geometry

The LLM may propose regions, constraints, matches and strategies. It must not write final `x`, `y`, rotation or layer values directly into the committed board.

### 4.2 Reference placement is a prior

Reference coordinates and relationships are soft by default. Mechanical anchors and explicitly locked user placements may be hard constraints.

### 4.3 Hard gates precede ranking

A candidate that violates board boundaries, overlaps, locked placements, keep-outs or mandatory clearance is invalid regardless of its wirelength score.

### 4.4 Placement is evaluated with routing

HPWL is a cheap filter, not the source of truth. The top placement candidates must be evaluated using the same fixed routing probe and verification environment.

### 4.5 Every mutation is transactional

The placement lifecycle is:

```text
snapshot -> propose -> normalize -> validate -> legalize -> verify -> rank -> commit/reject
```

The input snapshot remains immutable. Each candidate has an isolated working copy and complete provenance.

## 5. System architecture

```text
Copperhead PCB IR
    |
    +-- Constraint compiler <---------- LLM intent analysis
    |
    +-- PhysicalBoardIR
            |
            +-- Reference importer
            +-- Component matcher <---- LLM ambiguous matching
            +-- Strategy planner <----- LLM strategy selection
            +-- Candidate generators
            +-- Geometry normalizer
            +-- Legalizer
            +-- Fast placement scorer
            +-- Fixed-router probe
            +-- KiCad DRC verifier
            +-- Ranker and commit gate
```

### 5.1 Copperhead `PCB IR`

Versioned engine input containing electrical connectivity, stable component identity, footprint geometry, board geometry, functional-block annotations, user constraints and existing placement state.

### 5.2 `PhysicalBoardIR`

A deterministic, disposable projection optimized for placement and routing engines. It must be reconstructable from a versioned Copperhead PCB IR snapshot and must never become a second source of truth.

### 5.3 Copperhead orchestrator

Runs versioned tools, constrains LLM outputs to schemas, stores artifacts, compares candidates and enforces the commit policy.

## 6. Core data model

### 6.1 Board geometry

```typescript
interface BoardGeometry {
  outline: Polygon;
  cutouts: Polygon[];
  allowedSides: Array<"F.Cu" | "B.Cu">;
  placementGridMm: number;
  edgeClearanceMm: number;
  regions: PlacementRegion[];
  keepouts: Keepout[];
}
```

### 6.2 Physical component

```typescript
interface PhysicalComponent {
  componentId: string;          // Stable Copperhead identity
  reference: string;            // KiCad reference, not stable identity
  mpn?: string;
  value?: string;
  footprintId: string;
  courtyard: Polygon;
  pads: Pad[];
  sideOptions: Array<"F.Cu" | "B.Cu">;
  functionalBlockId?: string;
  placementRole?: PlacementRole;
  thermalClass?: "cold" | "warm" | "hot";
  placement?: PlacementState;
}

interface PlacementState {
  xMm: number;
  yMm: number;
  rotationDeg: 0 | 90 | 180 | 270;
  side: "F.Cu" | "B.Cu";
  locked: boolean;
}
```

### 6.3 Placement roles

Initial controlled vocabulary:

```text
mechanical_anchor
external_connector
antenna
primary_ic
power_converter
class_d_amplifier
bluetooth_module
decoupling
bootstrap
feedback
gain_setting
crystal
protection
input_filter
output_filter
thermal_support
generic_passive
test_point
indicator
control
```

Unknown roles are permitted but must fall back to `generic_passive` for deterministic placement.

### 6.4 Typed placement constraint

```typescript
interface PlacementConstraint {
  constraintId: string;
  type:
    | "fixed"
    | "inside_region"
    | "outside_region"
    | "near"
    | "far"
    | "relative_offset"
    | "orientation"
    | "edge_facing"
    | "same_side"
    | "separate_blocks"
    | "ordered_signal_chain"
    | "symmetry"
    | "reference_prior";
  subjects: string[];
  parameters: Record<string, unknown>;
  hardness: "hard" | "soft";
  weight?: number;
  confidence: number;           // 0.0 to 1.0
  source: "user" | "datasheet" | "reference" | "rule" | "llm";
  evidence?: EvidenceRef[];
}
```

## 7. Placement request

```typescript
interface PlacementRequest {
  pcbIrSnapshotId: string;
  targetBoardId: string;
  mode: "fresh" | "reuse_revision" | "reuse_reference" | "complete_existing";
  referenceBoardIds?: string[];
  userConstraints?: PlacementConstraint[];
  lockedComponentIds?: string[];
  seed: number;
  candidateBudget: number;
  timeBudgetSeconds: number;
  verificationProfile: string;
}
```

### 7.1 Placement modes

| Mode | Description |
| --- | --- |
| `fresh` | No placement prior. Use rules, blocks and packing. |
| `reuse_revision` | Previous revision of the same board. Prefer stable UUID matches. |
| `reuse_reference` | Related board. Use semantic and topology matching. |
| `complete_existing` | Preserve user placements and fill remaining components. |

## 8. LLM responsibilities

The LLM operates only through schema-validated tools.

### 8.1 Functional decomposition

Input:

- component graph
- named nets
- component metadata
- datasheet-derived facts
- board brief
- user constraints

Output:

- functional blocks
- signal-chain ordering
- component placement roles
- critical relationships
- uncertain classifications

### 8.2 Constraint derivation

Examples:

- Decoupling capacitor must remain close to the associated supply pins.
- Bluetooth antenna region must not contain copper or tall components.
- Amplifier output inductors should sit between the amplifier and speaker connectors.
- Power protection should sit between power entry and the downstream rail.
- Differential or complementary output components should remain symmetric where appropriate.

The LLM must attach confidence and evidence. Unsupported constraints must be marked as low confidence and soft.

### 8.3 Reference matching

The LLM is used only after deterministic matching leaves ambiguous candidates. It returns ranked match proposals with reasons, never a silently selected match.

### 8.4 Strategy selection

The LLM chooses from registered strategies:

```text
REFERENCE_STRICT
REFERENCE_BALANCED
REFERENCE_LOOSE
BLOCK_PACK
CONNECTIVITY_GREEDY
LAYOUT_REUSE_EXACT
COMPLETE_AROUND_LOCKS
```

It cannot invent an unregistered execution strategy.

### 8.5 Failure interpretation

After deterministic verification, the LLM may classify failures and recommend another registered strategy or constraint relaxation. It may not suppress failed checks.

## 9. Reference placement pipeline

### 9.1 Import

The importer reads reference KiCad boards into `ReferencePlacementIR`:

```typescript
interface ReferencePlacementIR {
  sourceBoardHash: string;
  boardGeometry: BoardGeometry;
  components: ReferenceComponent[];
  relativeRelations: ReferenceRelation[];
  functionalMotifs: ReferenceMotif[];
  parserVersion: string;
}
```

For each component, record:

- stable UUID when available
- reference designator
- MPN, value and footprint
- absolute and normalized position
- rotation and side
- pad-to-net connectivity
- local neighbour signature
- distance from board edges
- functional block

### 9.2 Component matching

Matching proceeds in strict confidence tiers:

| Tier | Method | Default confidence |
| --- | --- | ---: |
| 1 | Same stable component UUID | 1.00 |
| 2 | Same MPN, footprint and pin topology | 0.98 |
| 3 | Same reference, value and footprint in a known revision | 0.95 |
| 4 | Same MPN with compatible footprint | 0.90 |
| 5 | Same role, footprint family and neighbour signature | 0.75 |
| 6 | LLM semantic proposal | At most 0.70 |

Rules:

1. Matching must be one-to-one unless an explicit array or replicated-channel relation exists.
2. Reference designators alone are insufficient outside `reuse_revision` mode.
3. Any tie above a configurable ambiguity threshold remains unmatched.
4. Low-confidence matches are soft priors and may be released during legalization.
5. Every match stores its features and confidence calculation.

### 9.3 Board alignment

Use common mechanical anchors first:

- mounting holes
- connectors
- switches
- displays
- antennas
- enclosure alignment features

Test only registered transforms in v1:

- translation
- rotations of 0, 90, 180 and 270 degrees
- optional reflection
- uniform scaling when explicitly enabled

Select the transform that minimizes weighted anchor error while keeping all hard anchors legal.

Arbitrary non-uniform distortion is forbidden.

### 9.4 Transfer policy

For each match, generate a `reference_prior` constraint instead of immediately committing coordinates:

```json
{
  "type": "reference_prior",
  "subjects": ["target:C7"],
  "parameters": {
    "sourceComponent": "reference:C1",
    "preferredPositionMm": [23.4, 17.2],
    "preferredRotationDeg": 90,
    "preferredSide": "F.Cu",
    "relativeTo": "target:U2",
    "preferredOffsetMm": [1.8, 0.0]
  },
  "hardness": "soft",
  "weight": 8,
  "confidence": 0.94,
  "source": "reference"
}
```

Priority order:

1. User locks
2. Mechanical anchors
3. Datasheet hard constraints
4. Exact revision matches
5. High-confidence reference relationships
6. Generated engineering rules
7. Low-confidence semantic matches

### 9.5 Changed design handling

| Target state | Action |
| --- | --- |
| Matched component | Initialize from transformed reference prior. |
| New component | Place near its owning matched component or block. |
| Removed component | Release occupied space. |
| Changed footprint | Preserve centre and orientation, then legalize. |
| Replaced IC | Reuse block anchor, regenerate the local support motif. |
| Split or merged block | Preserve block centroid, then repack internally. |
| Conflict | Release the lowest-confidence soft prior first. |

## 10. Functional motif placement

A motif is a reusable local arrangement attached to an owning component.

```typescript
interface PlacementMotif {
  motifId: string;
  ownerRole: PlacementRole;
  members: MotifMember[];
  relations: PlacementConstraint[];
  applicability: MotifPredicate[];
  provenance: EvidenceRef[];
  version: string;
}
```

Initial motifs:

- IC decoupling ring
- crystal network
- switching regulator power loop
- USB protection chain
- Bluetooth module and antenna keep-out
- Class-D amplifier bootstrap and decoupling network
- Class-D output filter toward speaker connectors
- Connector protection and filtering

Motifs provide preferred offsets and orientations. The legalizer owns final coordinates.

## 11. Candidate generation

For every request, generate a bounded candidate matrix. Example default for reference reuse:

| Candidate group | Count | Reference weight |
| --- | ---: | ---: |
| Strict reuse | 2 | 10 |
| Balanced reuse | 4 | 5 |
| Loose reuse | 2 | 2 |
| Fresh baseline | 2 | 0 |

Candidate generation must be deterministic from:

```text
input snapshot hash
reference board hash
constraint set hash
engine version
strategy version
seed
```

### 11.1 Deterministic placement operators

- copy transformed position
- place fixed component
- place motif relative to owner
- nearest-legal grid placement
- move component
- rotate component
- swap compatible components
- translate block
- rotate block
- expand or contract block spacing
- mirror symmetric pair
- release soft reference prior

## 12. Geometry and legalization

### 12.1 Geometry source

Use actual KiCad courtyard polygons where available. Fall back in order to:

1. Fabrication outline
2. Pad and body envelope with configured margin
3. Explicit conservative bounding box

Every fallback must emit a diagnostic.

### 12.2 Hard legality checks

- component inside permitted board region
- no component or courtyard overlap
- no placement keep-out intersection
- valid board side
- locked placement preserved exactly
- edge clearance satisfied
- mounting and enclosure clearance satisfied
- mandatory antenna keep-out satisfied
- compatible rotation

### 12.3 Legalization algorithm

V1 legalizer:

1. Place hard-locked components.
2. Place mechanical anchors.
3. Place matched functional-block owners by descending confidence.
4. Place motif members around owners.
5. Place remaining components by role and footprint area.
6. Search nearest legal grid positions with allowed rotations.
7. If blocked, release the lowest-confidence soft constraint.
8. If still blocked, expand the affected block or try the next candidate strategy.
9. Return structured failure when the search budget is exhausted.

The legalizer must never move a hard-locked component.

## 13. Scoring

### 13.1 Validity cascade

Report metrics in this order:

1. Parse success
2. Constraint compilation success
3. Geometric legality
4. Hard intent compliance
5. KiCad DRC critical-error count
6. Fixed-router completion
7. Soft placement quality

A failure at an earlier stage cannot be hidden by a later score.

### 13.2 Fast score

For legal candidates:

```text
J_fast =
    w_critical_hpwl * critical_net_hpwl
  + w_signal_hpwl   * signal_net_hpwl
  + w_congestion    * estimated_congestion
  + w_reference     * confidence_weighted_reference_deviation
  + w_intent        * soft_constraint_penalty
  + w_spread        * unnecessary_board_spread
```

Power and ground nets must be excluded from functional ownership inference and either excluded or heavily down-weighted in HPWL.

### 13.3 Routing-probe score

Run the same router, limits and rules for every top candidate. Record:

- routed-net percentage
- critical nets routed
- unrouted connection count
- DRC violations by severity
- total routed length
- via count
- congestion hot spots
- runtime

The router probe must not mutate the placement under evaluation.

### 13.4 Reference deviation

```text
reference_deviation = sum over matched components:
  match_confidence * (
      position_weight * normalized_position_delta
    + rotation_weight * rotation_delta
    + side_weight * side_changed
  )
```

Relative offsets inside functional blocks should normally receive more weight than global absolute positions.

## 14. Verification and commit policy

A placement may be committed only if:

1. All hard constraints pass.
2. No illegal geometry remains.
3. No critical KiCad DRC violation is introduced.
4. The candidate is not dominated by another candidate on both routability and intent compliance.
5. All engine and artifact versions are recorded.

Default behavior is to return the top three candidates for review. Automatic commit may be enabled only for `reuse_revision` when all changed components have high-confidence matches and the verification profile passes.

## 15. Tool contracts

### 15.1 `extract_placement_reference`

```typescript
extract_placement_reference(input: {
  boardArtifactId: string;
}): {
  referencePlacementId: string;
  boardHash: string;
  componentCount: number;
  diagnostics: Diagnostic[];
}
```

### 15.2 `match_reference_components`

```typescript
match_reference_components(input: {
  pcbIrSnapshotId: string;
  referencePlacementId: string;
  mode: "reuse_revision" | "reuse_reference";
}): {
  matches: ComponentMatch[];
  ambiguous: AmbiguousMatch[];
  unmatchedTargetIds: string[];
  unmatchedReferenceIds: string[];
}
```

### 15.3 `compile_placement_constraints`

```typescript
compile_placement_constraints(input: {
  pcbIrSnapshotId: string;
  matches?: ComponentMatch[];
  userConstraints?: PlacementConstraint[];
}): {
  constraintSetId: string;
  hardCount: number;
  softCount: number;
  diagnostics: Diagnostic[];
}
```

### 15.4 `generate_placement_candidates`

```typescript
generate_placement_candidates(input: {
  physicalBoardIrId: string;
  constraintSetId: string;
  strategies: PlacementStrategyRequest[];
  seed: number;
  candidateBudget: number;
}): {
  candidateIds: string[];
  generationDiagnostics: Diagnostic[];
}
```

### 15.5 `verify_placement_candidate`

```typescript
verify_placement_candidate(input: {
  candidateId: string;
  verificationProfile: string;
}): PlacementVerificationReport
```

### 15.6 `commit_placement`

```typescript
commit_placement(input: {
  candidateId: string;
  expectedSnapshotId: string;
  approvalToken?: string;
}): {
  newSnapshotId: string;
  boardArtifactId: string;
  provenanceArtifactId: string;
}
```

Commit must fail on snapshot drift.

## 16. LLM output schemas

### 16.1 Functional-block analysis

```json
{
  "blocks": [
    {
      "blockId": "audio_power_stage",
      "purpose": "Stereo class-D amplification",
      "componentIds": ["U_AMP", "C_BOOT_L", "C_BOOT_R"],
      "placementPriority": 90,
      "preferredRegion": "near_speaker_edge",
      "confidence": 0.96,
      "evidence": ["schematic:/audio_amp"]
    }
  ],
  "uncertainties": []
}
```

### 16.2 Ambiguous match resolution

```json
{
  "proposals": [
    {
      "targetComponentId": "C_AUDIO_L",
      "referenceComponentId": "C15",
      "confidence": 0.66,
      "reasons": [
        "same input-coupling role",
        "compatible footprint",
        "same amplifier-channel topology"
      ]
    }
  ]
}
```

The orchestrator caps semantic-match confidence and may reject the proposal.

## 17. Diagnostics and failure model

| Code | Meaning |
| --- | --- |
| `PL001_REFERENCE_PARSE_FAILED` | Reference board could not be parsed. |
| `PL002_OUTLINE_INVALID` | Target or reference outline is missing or invalid. |
| `PL003_NO_ALIGNMENT_ANCHORS` | No reliable common anchors were found. |
| `PL004_MATCH_AMBIGUOUS` | Multiple reference matches remain unresolved. |
| `PL005_CONSTRAINT_CONFLICT` | Two or more hard constraints conflict. |
| `PL006_COMPONENT_UNPLACEABLE` | No legal position found within budget. |
| `PL007_COURTYARD_FALLBACK` | Exact courtyard missing; fallback geometry used. |
| `PL008_HARD_CONSTRAINT_FAILED` | Candidate violates a hard constraint. |
| `PL009_ROUTER_PROBE_FAILED` | Router did not execute successfully. |
| `PL010_KICAD_DRC_FAILED` | DRC execution failed or returned critical errors. |
| `PL011_SNAPSHOT_DRIFT` | Design changed before commit. |
| `PL012_LLM_SCHEMA_INVALID` | Model response failed schema validation. |
| `PL013_BUDGET_EXHAUSTED` | Candidate or time budget was exhausted. |

Every failure includes:

```typescript
interface Diagnostic {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  componentIds?: string[];
  constraintIds?: string[];
  artifactIds?: string[];
  recoverable: boolean;
  suggestedStrategies?: string[];
}
```

## 18. Provenance and reproducibility

Every candidate must store:

- PCB IR snapshot hash
- reference board hashes
- match set and confidence features
- compiled constraint set
- LLM model identifier and structured response hash
- prompt template version
- engine and tool versions
- seed
- ordered placement operations
- released constraints and reasons
- legality report
- routing and DRC reports
- final score vector

LLM text is not sufficient provenance. The validated structured output is authoritative.

## 19. User experience

### 19.1 Primary command

```bash
copperhead place \
  --board target.kicad_pcb \
  --reference reference.kicad_pcb \
  --mode reuse-reference \
  --candidates 10
```

### 19.2 Expected response

```text
Reference parsed: 111 components
Matched: 94 high confidence, 8 medium confidence
Unmatched target components: 9
Removed reference components: 12
Generated: 10 candidates
Legal: 7
Router-complete: 3

Best candidate: placement-07
  hard constraints: pass
  critical DRC: 0
  routed nets: 100%
  vias: 18
  reference relationships preserved: 91%
```

The UI should allow users to inspect:

- copied placements
- newly placed components
- released reference priors
- constraint violations
- candidate comparison
- reasons for every material move

## 20. Security and reliability

- Treat board text, comments and filenames as untrusted input.
- The LLM never receives credentials or unrestricted filesystem access.
- Reject paths outside the run workspace.
- Use schema validation for every model response.
- Limit candidate count, runtime, router runtime and artifact size.
- Run KiCad and routing tools in isolated processes or containers.
- Never execute scripts embedded in reference projects.
- Hash all imported artifacts before processing.
- Keep reference and target mutations isolated.

## 21. CopperBench evaluation

### 21.1 Dataset groups

1. Same-board revision pairs
2. Related-board pairs using the same main IC
3. Main-IC replacement pairs
4. Board-outline change pairs
5. Added and removed peripheral pairs
6. Existing partial-placement completion
7. Fresh-placement baselines

### 21.2 Metrics

Report raw metrics and validity cascades:

- parse completion
- component match precision and recall
- hard-constraint pass rate
- legal placement rate
- critical DRC count
- router completion rate
- critical-net completion rate
- wirelength
- vias
- runtime
- seed variance
- accepted reference relationships
- incorrectly preserved relationships
- human preference between candidates

### 21.3 Required baselines

- unchanged reference scaling
- trivial nearest-legal packing
- connectivity-greedy placement
- pyplacer where compatible
- layout reuse without LLM-derived constraints
- full hybrid engine

## 22. Implementation plan

### Phase 0: Contract freeze

- Freeze `PhysicalBoardIR` placement subset.
- Freeze Constraint IR v1.
- Define diagnostics and score vector.
- Define KiCad parser and writer round-trip requirements.

### Phase 1: Exact revision reuse

- Parse real KiCad courtyards and positions.
- Match stable UUIDs and references.
- Preserve locks and mechanical anchors.
- Copy unchanged placements.
- Place new components using nearest-legal packing.
- Produce before-and-after artifacts.

### Phase 2: Related-board reuse

- Add MPN, footprint and topology signatures.
- Add rigid board alignment.
- Add confidence-weighted reference priors.
- Add ambiguous-match LLM tool.
- Add strict, balanced and loose candidate groups.

### Phase 3: Motifs and replacement ICs

- Add functional motif registry.
- Implement local block regeneration.
- Down-weight global rails in ownership inference.
- Add signal-chain and output-direction constraints.

### Phase 4: Routing-aware ranking

- Integrate fixed-router probe.
- Integrate KiCad DRC.
- Add congestion and completion metrics.
- Rank candidate vectors without hiding invalidity.

### Phase 5: CopperBench and feedback

- Build 40 golden microboards.
- Add immutable environments and fixed seeds.
- Record user acceptance and manual corrections.
- Use collected trajectories to decide whether learned placement is justified.

## 23. v1 acceptance criteria

The first production release is acceptable when:

1. It supports KiCad boards within the declared scope.
2. Same-revision matching achieves at least 99% precision on stable components.
3. Reference-derived target placement preserves all valid user locks.
4. At least 95% of supported benchmark cases produce geometrically legal placements.
5. No candidate with a failed hard gate can be ranked above a passing candidate.
6. The engine returns a fresh-placement baseline with every reference-based run.
7. Every committed placement has reproducible provenance.
8. The engine either returns a ranked KiCad artifact or a structured failure.
9. Fixed-router evaluation shows a measurable completion-rate improvement over trivial packing.
10. The full pipeline runs without an LLM after cached structured intent and matches are supplied.

## 24. Open decisions

1. Whether `reuse_reference` permits backside-to-frontside component mapping.
2. Whether uniform board scaling should be enabled automatically or require user approval.
3. The initial fixed-router implementation and timeout.
4. The score-vector dominance policy for candidates with different routing and reference-preservation tradeoffs.
5. Whether motif definitions live in Copperhead Cortex or a versioned placement registry.
6. The minimum confidence required for automatic commit in revision-reuse mode.

## 25. Recommended first milestone

Implement `reuse_revision` before broad semantic reference reuse:

```text
existing target board
    -> exact component matching
    -> preserve fixed and unchanged placements
    -> place new support components
    -> legalize locally
    -> DRC
    -> compare against unchanged baseline
```

Then implement the main-IC replacement path demonstrated by the Bluetooth amplifier trial:

```text
reference amplifier block
    -> retain block anchor and interface direction
    -> replace amplifier IC
    -> regenerate local TDA support motif
    -> preserve unrelated components
    -> legalize changed region
    -> route and verify
```

This sequence produces useful behavior quickly while preserving the architecture needed for a general placement engine later.
