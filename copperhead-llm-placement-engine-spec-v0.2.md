# Copperhead Reuse Placer: Engineering-Order Plans, Deterministic Packing

**Document ID:** CH-PLACE-0001  
**Version:** 0.2 (revised 2026-09-16: plan and vendored packer; feasibility; subsystems; engineering placement order, critical relationships, tiered ranking, critical routing loop, variants and options)  
**Status:** Draft for owner review  
**Supersedes:** v0.1 (`copperhead-llm-placement-engine-spec-v0.1.md`)  
**Target:** copperhead `src/pcb` placement (RFC 11 §8), branch `feat/pcb-layout-framework`  
**Scope:** placement only; boards the layout framework already imports (two to six copper layers), at most 50 electrical parts, parts on the side they were imported on  
**Research:** `copperhead-placer-research-2026-09-16.md`

## 1. Summary

Copperhead has no placer that works on real boards.

- **B2 (2026-09-06).** pyplacer left courtyard overlaps on 17 of 17 PCBench boards, kicad-tools' force-directed placer left the outline on every board it finished, and the designers' own placements won all 20.
- **Model prototype.** A model writes every coordinate and copperhead's verifier checks each answer (`manual-tests/runs/pcb-schematic-demo/llm-place.ts`). It produced overlap-free placements on three demo boards, but spent 10 to 39 minutes and 52k to 192k output tokens per board.

**Hardware engineers do not place parts by minimising total wirelength.** They place in a strict engineering order:
1. mechanical parts;
2. functional regions;
3. main ICs;
4. critical support parts from the datasheets;
5. current loops;
6. signal-integrity separation;
7. everything else;
8. then they route the critical nets and revise.

What they optimise, in priority order:
1. mechanical correctness
2. datasheet-required placement
3. antenna and thermal constraints
4. high-current loop area
5. sensitive signal separation
6. pin-facing orientation
7. routability
8. trace length
9. visual neatness

tscircuit's packer knows geometry and connected-pad distance, but not that connections differ in physical importance.

This spec builds the **reuse placer** around that process. It copies the placement of an existing board (a previous revision or a related design) onto a new design, and adapts it the way an engineer would. **The model plans like the engineer, and a deterministic geometry engine makes the moves:**

```text
model:   identify blocks -> classify critical relationships -> order placement phases -> propose regions and orientations
engine:  pack each phase with earlier phases fixed -> screen variants -> route critical nets -> hand failures back
model:   reassess failures -> revised plan
```

**v0** runs in this order:
1. **Feasibility.** Check that the parts can fit at all (§7.1).
2. **Subsystems.** Partition the parts by intent, sheets, nearest anchor IC and Louvain clustering, each as a variant (§7.5).
3. **Match and copy.** Map the reference placement onto the new outline (§7.2, §7.3).
4. **Delta table.** Mark each part as locked, copied, changed, displaced, added or ambiguous (§7.4).
5. **Critical relationships.** Classify connections by physical importance: mechanical, RF keepout, supply decoupling, bootstrap, configuration, hot loop, output chain, crystal, aggressor/sensitive, thermal, signal, low (§7.6).
6. **Engineering plan.** Write the blocks and signal flow, critical relationships, placement phases, regions and orientations (§8.1). A deterministic default plan always exists (§8.2), and a model may write more (§9).
7. **Phased packing.** Each phase packs its parts into a **vendored copy of tscircuit's calculate-packing**, with earlier phases held fixed and connections weighted by class (§8.3, §8.4).
8. **Variants.** Generate the partition, clean-up, island and packing variants, and screen them in memory (§8.6).
9. **Critical routing and revision.** Route the critical nets of the best candidates, inspect return paths, then revise and repack (§8.7).
10. **Rank and present.** Rank by the engineering tiers (§8.8) and present up to three distinct options.
11. **Fallback.** Model coordinates for any parts no plan placed (§9.5).

**Stages 1 to 7** each take one of the model's planning decisions away and give it to deterministic code. **The electrical intent track (C1 to C5)** adds checker evaluators for what the engineer protects: voltage clearance, current loops, isolation, thermal, and ordered output chains.

The model never writes the board. Every candidate passes the same gates as any other placer (RFC 11 §10.4).

## 2. What changed from v0.1

| v0.1 | v0.2 | Why |
| --- | --- | --- |
| A general placement engine with four modes | One placer, reuse, with modes `revision` and `related`; placing without a reference is a baseline only | Owner's scope (2026-09-16) |
| §4.1: models express intent, tools own geometry | Kept, and made concrete: the model plans like an engineer (blocks, critical relationships, phases, regions, orientations); a vendored packer makes the moves; model coordinates are only a fallback | tscircuit's split (§4); the owner's account of how engineers place (§4) |
| Candidate generators and legalizer to be designed | tscircuit calculate-packing (MIT), vendored with five patches, run once per placement phase | A working, deterministic, net-aware packer exists |
| One scalar or Pareto score | Ranking by nine engineering tiers in the owner's priority order, each with a tolerance (§8.8) | Different connections have different physical importance |
| Placement ranked by routability first (RFC 11 §11 default profile) | Routability is tier 7, below loops, separation and orientation; critical nets are routed inside the loop (§8.7) | Engineers route critical nets during placement and revise |
| One candidate per strategy | Variant axes: partition source, clean-up, island split, packing strategy and order, plans; screened in memory, then up to three distinct options (§8.6) | Owner's answer to open decisions 14 to 16: try every choice, give several options |
| Motif registry | Critical relationship classes with rules, datasheet facts, model proposals and intent as sources (§7.6) | Rules plus datasheets, with a checker per class |
| `PhysicalBoardIR` in float mm | The existing `PcbDesign` (integer nm) | One IR (RFC 11 §6) |
| `PL001` to `PL013` | `preflight.utilisation.*`, `reuse.*` and `intent.*` codes | One diagnostic family per checker |
| `copperhead place` | `copperhead pcb reuse` | `pcb place` is LLM-free by contract |
| No capacity check | Feasibility check before any engine (§7.1) | Refuse boards that cannot fit |
| No subsystem layer | Subsystems from intent, sheets, nearest anchor or Louvain, packed in two levels (§7.5, §8.3) | Every part lands in `unassigned` on imported boards today |

## 3. Decisions this spec needs from outside it

1. **An exception to RFC 11 §3.8.** On 2026-09-16 the owner decided to build a placer. ADR 0012 records the decision, the B2 and B3 evidence, and the neighbours evaluated:
   - pyplacer and kicad-tools, wrapped (ADR 0008);
   - tscircuit calculate-packing, vendored as the geometry backend (MIT);
   - KiCad 10 Repeat Layout (GUI only);
   - atopile LayoutSync (translation only);
   - Quilter and DeepPCB (closed).

   It also records two further points. The routability estimate of stage 6 is not a router in the §3.8 sense. And critical-net routing inside the loop uses the existing wrapped routers, not new ones.
2. **An amendment to RFC 11.**
   - §3.8 names the exception.
   - §8.3's conditional placer becomes this placer.
   - §8.6 extends reuse to whole boards.
   - §7's constraint classes gain §7.6 and §11.
   - §11 gains the engineering tier ranking as the placement profile for `pcb reuse`; the existing default profiles stay for the other commands.
3. **An OpenSpec change, `add-reuse-placer`.** It carries a proposal, a design, delta specs mapping one to one onto §14, and tasks per stage and per checker.

Order of work: this spec, then ADR 0012 and the RFC 11 amendment, then the OpenSpec change, then v0 code.

## 4. Evidence and design input

Checked against primary sources or measured on 2026-09-16, except the owner's account, which is design input. The research note has the details.

- **How engineers place: the owner's account, 2026-09-16.** For a Bluetooth amplifier:
  1. **Mechanical parts:** power and speaker connectors, buttons, volume control, LEDs, mounting holes, programming connector, and the antenna at an edge with a keepout.
  2. **Functional regions** in signal-flow order: power input, then regulation, then amplifier, then speaker outputs, with Bluetooth and audio filtering feeding the amplifier.
  3. **Main ICs:** the Bluetooth module at the antenna edge, the amplifier near the speaker connectors positioned for its supply and output loops, the power converter near the power input.
  4. **Critical support parts from the datasheet:** decoupling beside the supply pins, bootstrap and gain/feedback parts beside their pins, output inductors between amplifier and connectors, output capacitors near the inductors, thermal vias under the exposed pad.
  5. **Loops made compact**, for example PVCC capacitor to power pin to output stage to ground, and amplifier output to inductor to capacitor or speaker and back.
  6. **Separation:** audio from switching outputs, antenna from copper, clocks and power conversion, and left from right channel. Parts are rotated so connected pins face each other.
  7. **Everything else** in the remaining space around its block.
  8. **Route critical nets, inspect return paths, move or rotate, reroute.**

  The priorities are the nine listed in §1.
- **Datasheets carry this guidance.** From the sibling project `esp32-amp`, `research/DATASHEET-FACTS.md` and `research/LOUDER-ARCHITECTURE.md` (verified 2026-09-04):
  - the ESP32 layout guideline recommends "a clearance of at least 15 mm … in all directions" around the antenna;
  - the TAS5805M needs decoupling at its PVDD pins, a bootstrap capacitor per output, and GVDD and AVDD capacitors;
  - the MAX98357A needs wide, low-resistance output traces.

  Copperhead's intent compiler already asks a model for placement rules from cached datasheets, cited, with hard rules lowered to soft and low-confidence rules made advisory (`src/pcb/agent/intent/compiler.ts`).
- **What copperhead already has for the loop:**
  - `routeBoard` routes a named subset of nets (`netNames`).
  - The staged routing plan already sorts nets into power, critical and bulk (`src/pcb/engines/plan.ts`).
  - A two-layer return-path checker reports pour crossings (gating for nets tagged sensitive), pour fragments and stitching (`src/pcb/verify/checkers/returnpath.ts`).
  - `rank()` sorts eligible candidates lexicographically by completion, hard intent and soft intent, then a weighted score, and keeps the Pareto frontier (`src/pcb/verify/scoring.ts`). The placement profile weights routability 0.35 and HPWL 0.3.
- **tscircuit splits structure from geometry** (core `e0c6b3d`, calculate-packing `a2d60ae`).
  - Its models write code; parts with authored positions are static; constraint clusters are solved with Kiwi.
  - `PackSolver2` places free parts along outline segments, minimising distance to same-net pads.
  - Each side is packed separately, and nested groups pack as whole units.
- **The packer's limits** (patched in §8.4):
  - courtyards reduced to boxes, and axis-aligned box obstacles;
  - outline containment tested at box corners and pad centres only;
  - one global gap;
  - connection weights that only filter weak connections;
  - a silent centre fallback and whole-solve failure;
  - runtime imports declared only as devDependencies.
- **Models can write coordinates only with a checker, and at a cost.**
  - OmniLayout (arXiv 2607.03261): GPT-5.5 overlap 0.07 and out-of-board 0.17 unaided, 0.007 and 0.019 with tools.
  - MAGE (arXiv 2607.18536): Claude Opus 4.6 writes macro JSON coordinates, and is 133 % worse on TNS without image checks.
- **Model quality collapses with size.** Floorplanning is optimal 57 % to 82 % of the time at 16 modules, but 12 % at 24 (arXiv 2504.12076).
- **Models should not write copper.** In PCBWorld (arXiv 2607.05915), a tool-calling agent routes 65 % of boards cleanly; writing geometry directly, 2 %.
- **A revision is not a transform.** ecc83-pp to ecc83-pp_v2: 7 footprints swapped, outline shrunk; the best transform leaves 6.5 mm mean displacement; 91 % of pairwise order survives.
- **Minimal-displacement repair is cheap.** Nearest-legal search cleared 14 to 23 overlapping pairs on 30-part boards in 0.07 to 0.09 s.
- **Designers leave about half of each side uncovered.** On 23 boards with near-complete courtyards, the fuller side is at median 48 %, 90th percentile 62 %, maximum 93 %.
- **Designers place a sheet's parts together, and netlist partitions find equally compact groups.** Over 11 KiCad demo boards with sheets:

  | Partition | Cohesion | Purity |
  | --- | --- | --- |
  | Sheets | 0.55 | 0.78 |
  | Nearest anchor IC | 0.55 | 0.74 |
  | Louvain | 0.51 | 0.58 |
  | Root sheets split | 0.55 | 0.70 |

  These boards are larger than this scope. Scripts: `manual-tests/runs/placer-research-2026-09-16/subsystems/`.

## 5. Scope

**In scope:**
- one reference board per run;
- a target board populated by `create` or `populateBoard`;
- rotations in 90° steps;
- intent constraints from the registry;
- candidates through `placeBoard`;
- the §7.6 classification and §11 evaluators for every placer;
- critical-net routing with the existing wrapped routers.

**Out of scope:**
- full routing as a product (the probe and critical routing only measure);
- side flips;
- several references;
- channel-to-channel reuse;
- boards over 50 parts;
- images to the model;
- learned policies;
- enclosure geometry beyond edge and fixed constraints (§18).

## 6. Architecture

```text
target + reference + intent + cached datasheets
        |
   feasibility --> REFUSE when over capacity
        |
   subsystem variants, match, transfer, delta table, critical relationships (rules + datasheet + intent)
        |
   default plan (engineering order)        model plans (agent)
                 \                           /
            phase executor: for each phase, compile -> vendored packer -> fix result
                              |
            variant matrix (partition x clean-up x island x strategy/order x plan)
                              |
            in-memory screen: verifyDesign + tiers T1-T6 (no KiCad)
                              |
            top 8: materialize (zone refill, DRC) --> top 5: critical-net routing + return paths
                              |                                  |
                              |                     failures --> revision rules --> model reassessment
                              |                                  |                   (revised plan)
            top 3: routability probe --> tiered ranking --> up to 3 distinct options --> outcome
                              |
            parts no plan placed --> coordinate fallback (agent)
```

### 6.1 Module layout

- **`src/pcb/verify/checkers/preflight.ts`**: the utilisation check (§7.1).
- **`src/pcb/verify/checkers/intent.ts`**: the §7.6 and §11 evaluators, and subsystem intrusion.
- **`src/pcb/verify/estimate.ts`** (stage 6): ratsnest crossings and the routability estimate.
- **`src/pcb/verify/tiers.ts`**: the engineering tier vector per candidate (§8.8).
- **`src/pcb/verify/scoring.ts`**: `rank()` gains tier comparison when a profile carries `tiers`.
- **`src/pcb/verify/profiles/scoring/index.ts`**: gains the `engineering-placement-2-layer` profile.
- **`src/pcb/intent/blocks.ts`**: `deriveBlocks` gains the sheet, nearest-anchor and Louvain sources and the clean-up rules (§7.5).
- **`src/pcb/intent/critical.ts`**: critical relationship classification rules (§7.6). `engines` may import it, like `blocks.ts`.
- **`src/pcb/intent/language.ts`**: gains the §11.6 keys.
- **`src/pcb/ir/kicad/import.ts`**: reads `(sheetname)`, `(sheetfile)`, `(pinfunction)`, `(pintype)` and the footprint `(path)`.
- **`src/pcb/engines/reuse/`**: library code, LLM-free and network-free.
  - `match.ts`, `transfer.ts`, `delta.ts`: §7.2 to §7.4.
  - `plan.ts`: plan types, the default plan, validation (§8.1, §8.2).
  - `phases.ts`: the phase executor (§8.3).
  - `compile.ts`: phase to packer input, and back.
  - `variants.ts`: the variant matrix, screening funnel and option selection (§8.6).
  - `revise.ts`: deterministic revision rules after critical routing (§8.7).
  - `geometry.ts`: extents per rotation, rectangle approximations, the inset outline, loop polygons.
  - Stages add `repair.ts`, `floorplan.ts`, `orient.ts`, `refine.ts`.
- **`src/pcb/engines/critical-route.ts`**: routes a candidate's critical nets through `routeBoard({ netNames })` and runs the return-path checker (§8.7).
- **`src/pcb/engines/probe.ts`**: `ProbeOptions` gains `netNames`.
- **`src/vendor/calculate-packing/`**: the vendored packer with `VENDORED.md` (upstream commit `a2d60ae`, MIT licence, patch list). It imports nothing from `src/`.
- **Engines:**
  - `src/pcb/engines/placers/reuse-copy/adapter.ts` (`placer-reuse-copy`);
  - `src/pcb/engines/placers/reuse-pack/adapter.ts` (`placer-reuse-pack`).
- **Agent code:**
  - `src/pcb/agent/place/plan.ts` (`placer-reuse-plan`: planning and reassessment rounds);
  - `src/pcb/agent/place/coordinates.ts` (`placer-reuse-coordinates`: fallback);
  - `src/pcb/agent/place/prompts.ts`, `schema.ts`.
- **`src/commands/pcb-reuse.ts`**: the command (§12).

`test/pcb-imports.test.ts` already forbids engines from importing agent code, and gains a rule for `src/vendor/`.

### 6.2 Engines and manifests

| Engine | Where | What it does | `determinism` | `networkRequirement` |
| --- | --- | --- | --- | --- |
| `placer-reuse-copy` | engines | The transferred copy; the fidelity baseline | `deterministic` | `none` |
| `placer-reuse-pack` | engines | Default plans over the variant matrix, with deterministic revision | `deterministic` | `none` |
| `placer-reuse-plan` | agent | Model plans and reassessments through the same executor | `nondeterministic`, replayable (§9.6) | `required` |
| `placer-reuse-coordinates` | agent | Model coordinates for parts no plan placed | `nondeterministic`, replayable | `required` |

- All are `executionMode: library` and `harnessOnly: false`.
- Capabilities for all: `rotation`, `fixedComponents`, `layoutReuse`, `arbitraryOutline`.
- `supportedConstraints`: `mechanical`, `relative`, `functional`, `manufacturing.keepout`, `electrical-layout`, `emc`, `thermal`.
- The command registers the agent engines only when `--model` is given, and only then sets the policy's `network` to `required`.

Every engine returns several candidates: one per surviving variant in the funnel, each with its variant key.

### 6.3 IR additions

All additive, with a minor schema bump; the canonical hash includes them.

- **`ComponentInstance.symbolPath?: string`**, from `(path "...")`, for matching (§7.2).
- **`ComponentInstance.sheet?: { name: string; file?: string }`**, from `(sheetname)` and `(sheetfile)`, for subsystems (§7.5).
- **`PadDefinition.pinFunction?: string` and `pinType?: string`**, from `(pinfunction)` and `(pintype)`, for critical relationships (§7.6). Net names are the fallback when pins are unnamed.

## 7. Deterministic front end

### 7.1 Feasibility

This check runs in pre-flight for every placement run.

- **Usable area per side:** outline area, minus cutouts, minus keepouts, minus the edge band (perimeter × `copperEdgeClearanceNm`).
- **Demand:** the summed extent area of the parts on that side. An extent is the courtyard, or else the pad-copper bounding box.
- **Utilisation:** `u = demand / usable`.

| Condition | Diagnostic | Effect |
| --- | --- | --- |
| `u > placementUtilisationMax` (0.95) on a side, or a part fits the inset outline at no rotation | `preflight.utilisation.over-capacity`, error | `REFUSE` before any engine |
| `u > placementUtilisationWarn` (0.62) on a side | `preflight.utilisation.dense`, warning | Run continues; plans are told |

- **Defaults:** 0.62 is the 90th percentile and 0.93 the maximum on 23 designer boards (§4). They live in the fabrication profile.
- **A refusal states:** the shortfall in mm², the growth at the same aspect ratio that reaches 62 %, the ten largest parts, and whether moving SMD parts to the other side would fit.
- **Few courtyards:** under 90 % courtyard coverage, `preflight.utilisation.pad-extents` (info) says demand is underestimated.
- **Packer capacity:** `compile.ts` reports the box-based utilisation as `pack_box_utilisation`.

### 7.2 Matching

```ts
type MatchTier = 'symbol-path' | 'refdes' | 'signature' | 'model';

interface PartMatch {
  targetId: string; referenceId: string; tier: MatchTier;
  footprintChanged: boolean; cost: number; confidence: number;   // 1.0 path, 0.95 refdes, <= 0.9 signature, <= 0.7 model
}

interface MatchSet {
  matches: PartMatch[]; added: string[]; removed: string[];
  ambiguous: { targetId: string; candidates: { referenceId: string; cost: number }[] }[];
}
```

Matching is one-to-one, and each tier removes its pairs before the next:
1. **`symbol-path`:** equal symbol path.
2. **`refdes`:** equal reference designator and prefix class; the footprint may differ.
3. **`signature`:** same prefix class, pad count, and multiset of net names over the pads. Auto-generated names are compared by the part and pad they name. A unique best match is taken; ties go to `ambiguous`.

In `related` mode, tier 2 is off. A model plan may resolve ambiguous parts (confidence at most 0.7). Stage 3 replaces tier 3.

### 7.3 Transfer

Transfer uses only the target's outline and its fixed parts (locked, or placed by a mechanical rule) that match reference parts.

1. **Two or more matched fixed parts:** least-squares scale and translation for each rotation in {0, 90, 180, 270}, keeping the smallest residual.
2. **Otherwise:** map the reference outline's bounding box onto the target's. Rotation from the four; separate x and y scale clamped to [0.8, 1.25]; the rotation with the highest outline IoU wins. On ecc83 this gives the lowest mean displacement (6.5 mm).
3. **Record the fit:** below 0.8 IoU, the run emits `reuse.transfer.outline-mismatch`.

Scale moves positions, never footprints. Each part's rotation is its reference rotation plus the transform rotation, and each part keeps the target's side (`reuse.transfer.side-differs` otherwise).

```ts
interface Transfer {
  transform: { rotation: Mdeg; scaleX: number; scaleY: number; dx: Nm; dy: Nm };
  basis: 'anchors' | 'outline'; residualNm: number | null; outlineIoU: number;
  placements: PlacedComponent[];   // reference positions of matched, movable target parts
}
```

### 7.4 Delta table

After the transfer, `verifyDesign` runs the geometry and intent checks, and each target part gets one status:

| Status | Meaning | Default plan | May a model plan change it? |
| --- | --- | --- | --- |
| `locked` | KiCad-locked, or placed by a mechanical rule | static | no |
| `copied` | matched, same footprint, no error-severity finding names it | static at its reference position in its phase | may release it |
| `footprint-changed` | matched, footprint differs | released in its phase, pulled toward its reference position | may keep it static |
| `displaced` | copied, but named by an overlap, outside-board, edge, keepout or §11 finding | released, pulled toward its reference position | may keep it static |
| `added` | no match | released in its phase | yes |
| `ambiguous` | several reference candidates | released without a pull | yes, and may pick the match |

The **delta set** is every part the default plan releases. If it is empty and the placement gate passes, `placer-reuse-pack` returns the copy.

### 7.5 Subsystems

A subsystem is a set of parts placed together, with the arrangement inside left free. `deriveBlocks` blocks are subsystems.

**Partition sources.** Each source that applies to the board produces its own partition variant (§8.6):
1. **`intent`:** SUBSYSTEMS.md headings and schematic intent `group` fields, whenever present.
2. **`sheet`:** one subsystem per sheet name, whenever the board has at least two sheets of 3 or more parts. Sheets are kept whole (§4).
3. **`anchor`:** each part joins the nearest anchor IC (8+ pads, not a connector) over the part graph. Parts sharing a net of k parts are joined with weight 1/(k−1); ground nets and rails (more than max(12, 20 %) of parts) are dropped; power nets weigh 0.25; edge length is 1/weight. Unreached parts form `unassigned`. Always generated.
4. **`louvain`:** Louvain modularity clustering of the same graph (deterministic node order). Always generated.
5. **`model`:** moves, splits and merges in a model plan, each justified (§8.1) and scored as in §10.4.

Partitions that come out identical are merged, keeping the list of sources that produced them.

**Clean-up variants** for the sheet, anchor and Louvain partitions (intent partitions are never changed):
- **`none`:** as produced.
- **`support`:** a two-pin part whose non-ground nets all end on one IC's pins joins that IC's subsystem.
- **`all`:** `support`, plus three rules:
  - **boundary parts:** a part whose nets reach exactly two subsystems stays with the one holding more of its connections, with a `between` hint;
  - **mechanical parts:** parts with no nets, or only ground, belong to no subsystem;
  - **connectors:** a connector joins the subsystem its nets reach most, or forms its own when it reaches three or more.

Sheet names sharing a sheet file are tagged `instanceOf` (E6, later).

Each subsystem is written as `layout.functional.group.<slug>` with its members, anchor and source. The **intrusion evaluator** counts other subsystems' parts inside a subsystem's hull, excluding boundary and mechanical parts: `intent.functional.group.intrusion`, soft, reported as `intrusion_count`.

### 7.6 Critical relationships

A **critical relationship** says how physically important a connection or a group of parts is. Each class carries:
- a placement phase;
- a packer weight;
- a checker;
- a tier.

| Class | Amplifier example | Recognised by (rules) | Phase | Weight | Checked by | Tier |
| --- | --- | --- | --- | --- | --- | --- |
| `mechanical` | power and speaker connectors, buttons, volume control, LEDs, mounting holes, programming connector | connector and switch classes, `mechanical.*` intent, locked parts, the reference's edge-adjacent parts | 1 | fixed | `intent.mechanical.*` | T1 |
| `rf-keepout` | Bluetooth module antenna | module footprints with an antenna keepout area, RF module classes, datasheet facts | 1 | fixed, plus keepout | `intent.manufacturing.keepout`, `intent.rf.edge` (C3) | T3 |
| `supply-decoupling` | capacitors at PVCC/PVDD and VDD pins | capacitor between a supply-pin net and ground; pin functions `VDD*`, `PVDD`, `PVCC`, `AVDD`, `GVDD` | 4 | 6 | `intent.relative.attached` | T2 |
| `bootstrap` | capacitors between BST and OUT pins | capacitor between a `BST*`/`BOOT*` pin and an output pin | 4 | 4 | `intent.relative.attached` (both pins) | T2 |
| `config` | gain-setting and feedback resistors | resistor on a `GAIN*`, `FB*`, `SEL*`, `SD*`, `MODE*` pin | 4 | 4 | `intent.relative.attached` | T2 |
| `crystal` | crystal and load capacitors | crystal or oscillator class on `XTAL*`/`OSC*` pins | 4 | 4 | `intent.relative.attached`, `intent.emc.edge-distance` | T2 |
| `hot-loop` | PVCC capacitor, power pin, output stage, ground | switching regulator or class-D topology (§11.2) | 5 | 8 | `intent.emc.hot-loop` | T4 |
| `output-chain` | amplifier OUT, inductor, capacitor, speaker connector | inductor on an amplifier output net followed by a capacitor or connector | 4 and 5 | 4 | `intent.relative.chain` (C5), `intent.emc.hot-loop` (return loop) | T2, T4 |
| `aggressor` | switching nodes, inductors, class-D outputs, clocks | switch nets, inductors on them, oscillators, clock outputs | 3 to 7 | repulsion (§8.3) | `intent.emc.isolation` | T5 |
| `sensitive` | Bluetooth audio lines, analog inputs, references, antenna | op-amp and ADC inputs, audio input nets, references, nets through 1 MΩ or more, RF modules | 3 to 7 | repulsion | `intent.emc.isolation` | T5 |
| `channel` | left and right output stages | repeated sheets, or mirrored nets with `L`/`R`/`LEFT`/`RIGHT` names | 3 to 7 | repulsion (soft) | `intent.emc.isolation` | T5 |
| `thermal` | exposed-pad vias under the amplifier; hot parts vs electrolytics | exposed-pad footprints; power parts by class and intent power | 3 to 7 | back-side keepout under the exposed pad | `intent.thermal.*` (C4) | T3 |
| `signal` | ordinary logic nets | default | 7 | 1 | none | T8 |
| `low` | pull-ups, pull-downs, LED resistors, test points, jumpers, non-critical bulk capacitors | resistor to a rail on a logic pin, LED series resistors, test point and jumper classes, bulk capacitors beyond the first per rail | 7 | 0.5 | none | T8 |

Ground nets and rails get no attraction; the return-path checker covers them.

```ts
type CriticalClass = 'mechanical' | 'rf-keepout' | 'supply-decoupling' | 'bootstrap' | 'config' | 'crystal'
  | 'hot-loop' | 'output-chain' | 'aggressor' | 'sensitive' | 'channel' | 'thermal' | 'signal' | 'low';

interface CriticalRelation {
  id: string;
  class: CriticalClass;
  refs: string[];                  // parts involved
  pins?: string[];                 // "U1.PVDD", "U1.BST1"
  order?: string[];                // output-chain order, loop order
  maxMm?: number;                  // attachment distance
  maxAreaMm2?: number;             // loop area
  minMm?: number;                  // isolation, keepout clearance
  severity: 'hard' | 'soft' | 'advisory';
  source: 'rule' | 'datasheet' | 'model' | 'user';
  confidence: number;
  cite?: string;                   // datasheet ref and page, rule id, or intent key
}
```

**Sources, highest authority first:**
1. **Intent** (`user`), which may be hard.
2. **Datasheet facts**, through the intent compiler's step 3. Its rule language is extended with these classes. Rules are cited; a hard datasheet rule is kept soft until approved, and confidence below 0.5 is advisory, as the compiler does today.
3. **Rules** (`src/pcb/intent/critical.ts`): pin functions, net names, part classes and topology; soft.
4. **Model proposals** in a plan: confidence at most 0.7, soft or advisory.

Every relation becomes a registry entry under its class's existing key or a §11 key, so the checker verifies it whoever proposed it.

## 8. The engineering plan and phased packing

### 8.1 The placement plan

```ts
type Deg = 0 | 90 | 180 | 270;
type RegionHint = { edge: 'left' | 'right' | 'top' | 'bottom' } | { near: string } | { between: [string, string] } | { quadrant: 'nw' | 'ne' | 'sw' | 'se' };
type PhaseKind = 'mechanical' | 'regions' | 'anchors' | 'support' | 'loops' | 'separation' | 'remaining';

interface PlacementPlan {
  id: string;
  source: 'default' | 'model';
  variant: VariantKey;                            // §8.6
  subsystems: {
    id: string; members: string[];
    source: 'intent' | 'sheet' | 'anchor' | 'louvain' | 'model';
    role: 'power-input' | 'regulation' | 'amplifier' | 'rf' | 'mcu' | 'audio' | 'output' | 'control' | 'mechanical' | 'other';
    anchor?: string; pack: 'island' | 'flat'; region?: RegionHint; justification?: string;
  }[];
  flow: { from: string; to: string }[];           // signal flow between subsystems
  critical: CriticalRelation[];                   // §7.6; model entries are capped
  phases: { kind: PhaseKind; refs: string[]; strategy?: PackStrategy; note?: string }[];   // in execution order
  orientations: { ref: string; face?: { ref: string; pin?: string }; allowed?: Deg[] }[];  // pin-facing hints
  release: string[]; keep: string[];              // reuse: beyond / within the delta set
  matches: { target: string; reference: string }[];
  groups: { id: string; members: string[]; arrangement: 'reference' | 'relations' }[];      // rigid clusters inside one subsystem
  priorWeight: number;                            // 0..1, pull toward reference positions
  rationale: string;                              // at most three sentences
}
```

**Validation** (`plan.ts`, for default and model plans):
- Every refdes exists.
- Each movable part appears in exactly one subsystem and exactly one phase; locked parts appear in no phase.
- `mechanical` is the first phase and `remaining` the last.
- A part's phase is no earlier than the earliest phase of its critical classes allows. For example, `low` parts cannot go before `support`.
- A group's members share a subsystem and a phase.
- `orientations[].face` names an existing part or pin.
- Critical relations from a model carry confidence at most 0.7 and are never hard.
- A model's partition changes need a justification.

Invalid entries are dropped with `reuse.plan.invalid-entry`; a plan with no valid content is discarded (`reuse.model.schema-invalid`).

### 8.2 The default plan

`placer-reuse-pack` builds one default plan per variant, without a model:

- **Subsystems:** the variant's partition. Roles come from their parts' classes: a power connector with a regulator gives `power-input`/`regulation`, a class-D IC gives `amplifier`, and so on. `other` otherwise.
- **Flow:** directed edges between subsystems along non-ground nets, from subsystems holding input connectors or power entry toward subsystems holding output connectors, ordered by shortest path over the subsystem graph.
- **Critical relations:** everything §7.6's sources produce.
- **Phases**, in the engineer's order:
  1. **`mechanical`:** `mechanical` and `rf-keepout` parts.
  2. **`regions`:** no parts. It sets each subsystem's region hint: a subsystem holding an edge connector or an RF module takes that edge; the others take positions along the flow, from the power input side to the output side. Stage 4 replaces hints with planned regions.
  3. **`anchors`:** each subsystem's anchor IC.
  4. **`support`:** `supply-decoupling`, `bootstrap`, `config`, `crystal` and `output-chain` members.
  5. **`loops`:** `hot-loop` members, released again together with their `output-chain` return parts.
  6. **`separation`:** parts named by isolation, keepout or thermal findings after phase 5. Empty when there are none.
  7. **`remaining`:** everything else.
- **Orientations:** every anchor and support part faces the part or pin it has the highest-weight relation with.
- **Reuse** (§7.4): in each phase, copied parts stay static at their reference positions, and only delta parts are packed.
- **Groups:** displaced copied neighbourhoods with legal internal offsets move as `arrangement: 'reference'` groups. Several capacitors on one pin form a group ordered by value.
- **`priorWeight`:** 0.5.

### 8.3 Phase execution and compiling

`phases.ts` runs the phases in order. Each phase's placements become static for every later phase.

- **`mechanical`:**
  - Parts with `mechanical.fixed` or `mechanical.edge` constraints go through the existing rule stage (`placeMechanical`).
  - Copied mechanical parts stay at their reference positions.
  - Added mechanical parts without constraints are packed against the edge named by their region hint (boundary segments only).
  - RF modules are placed with the antenna side at their edge, and their keepout (the footprint's keepout area, else the datasheet or intent `minMm`) becomes an obstacle for every later phase.
- **`regions`:** computes the attractor point of each region hint.
- **`anchors`:** anchors are packed alone on the board.
  - They are pulled toward their region attractor, and toward phase-1 parts they share critical relationships with, at the class weight. An amplifier is pulled to its speaker connectors through `output-chain`, a converter to its power input.
  - Allowed rotations come first from `orientations`: the rotation whose weighted pin-to-partner vectors point most directly at their partners is tried first, then the others.
- **`support`, `loops`, `remaining`:** packed per subsystem island with two-level packing, anchors and earlier phases static.
  1. Each `island` subsystem packs its phase parts alone, with nets leaving the subsystem as attractors at the outside parts.
  2. Islands and flat parts then pack on the board.
  3. `loops` adds a local search for hot loops of 6 parts or fewer: every legal assignment of rotations, and position swaps between equal-footprint members, keeping the smallest loop polygon area (§11.2).
- **`separation`:** releases the named parts and repacks them with aggressor courtyard boxes inflated by the isolation distance. Where no distance is given, a nearest-legal move outward (stage 1) runs instead.

**Compiling a packing phase** (`compile.ts`):
- **Units:** nanometres to millimetres, and back rounded to the nearest nanometre.
- **Static parts:** all parts placed so far, with pads as rectangles on their nets and extent boxes as courtyards. Other-side parts become point-sized network references; through-hole parts are also obstacles on the other side.
- **Released parts:** pads and box at rotation 0, and allowed rotations (orientations first).
- **Groups:** one composite part each.
- **Weights** (patch P3): each pad's net weight is the highest weight of the classes that net belongs to (§7.6). Ground and rails are 0; a net with no class is `signal`, 1.
- **Reference pull:** a point-sized static attractor at each released matched part's reference centre, on a private network, weight `priorWeight` × 2.
- **Region hints:** an attractor at the hint point, weight 0.5.
- **Critical pins:** for `supply-decoupling`, `bootstrap`, `config` and `crystal`, an attractor at the named pin, at the class weight.
- **Repulsion:** the packer has no repulsive term. While a phase packs `sensitive` parts, `aggressor` parts' boxes are inflated by the isolation distance, and the other way round. `channel` relations inflate by half.
- **Obstacles:** keepouts, RF keepouts, cutouts and back-side exposed-pad keepouts, as rectangles.
- **Boundary:** the outline inset by `copperEdgeClearanceNm` (exact containment, P2).
- **Clearance:** `minGap` 0.25 mm; high-voltage parts' boxes inflated by half their clearance (§11.1).
- **Order:** within a phase, by class weight, then extent area (`packFirst`).

### 8.4 The vendored packer and its patches

**Vendored:** `lib/` of tscircuit/calculate-packing at `a2d60ae`, without its tests, `testing/`, `plumbing/` (circuit-json conversion) and `graphics-debug` visualisation.

| Patch | Change | Why |
| --- | --- | --- |
| P1 | Local replacements for the `@tscircuit/math-utils` and `@tscircuit/solver-utils` imports; `@flatten-js/core` (MIT) kept as a dependency, or outline construction ported to `polygon-clipping` | Only devDependencies upstream; the clone's copies carry no licence field |
| P2 | Exact boundary containment | Upstream tests pad centres and box corners only |
| P3 | Weighted network distance | Upstream weights only filter weak connections |
| P4 | No silent centre fallback | Upstream places the first part "even if it violates constraints" |
| P5 | Failure detail: part, rotations, closest rejection reason | Retries, diagnostics and model feedback need it |

Stage 5 adds exact courtyard rectangles, several candidates per segment, and bounded backtracking. A repulsive cost term (P6) is a stage-5 option, to replace box inflation if P5's report shows inflation wastes space.

The vendored code stays deterministic. Ported upstream tests cover the unpatched modules.

### 8.5 Failures and retries

A phase whose solve fails retries in this order:
1. The pad-count order, then x order.
2. `minGap` 0.15 mm.
3. Release static neighbours of the failing parts within 2 mm, but only parts from the `remaining` phase or delta parts, never `mechanical` or `anchors` parts.
4. Flat packing for that phase (`reuse.pack.flat-fallback`).

Parts still unplaced are carried to the next phase's retry once, and then reported: `status: 'partial'`, `unplacedComponentIds`, `reuse.pack.unplaceable` with P5's detail.

### 8.6 Variants, screening and options

The owner's rule (2026-09-16): where a choice is uncertain, generate each option as a variant, compare the boards, and give the user several options.

**Variant axes:**

| Axis | Values |
| --- | --- |
| Partition | each applicable source of §7.5: `intent`, `sheet`, `anchor`, `louvain`, after merging identical partitions |
| Clean-up | `none`, `support`, `all` (not applied to `intent`) |
| Island split | `none`; `20`: island subsystems above 20 parts split by nearest anchor inside them (`reuse.subsystems.split`) |
| Packing | strategy `minimum_sum_squared_distance_to_network` or `minimum_sum_distance_to_network`, × order (class weight then area, or pad count) |
| Plan | the default plan, and each model plan (a model plan fixes its own partition; the other axes apply where it does not) |

`VariantKey` is `{ partition, cleanup, islandSplit, strategy, order, planId }`.

**Budget.** At most `--max-variants` packing runs per plan (default 48). The matrix is enumerated partition × clean-up × island split first, with the default packing. The four packing combinations run only for the 4 best variants after screening. Identical placements are merged by placement hash.

**Screening funnel**, cheapest first, one engine at a time:
1. **Pack** every variant (in-process).
2. **Screen in memory:** `verifyDesign` on the IR (geometry, connectivity, intent including §7.6 and §11), and the tier vector T1 to T6 (plus the estimate after stage 6). No kicad-cli, no router.
3. **Materialize** the top 8 by tiers: KiCad zone refill and DRC, as `placeBoard` does today.
4. **Critical-net routing and return paths** on the top 5 (§8.7), with revision.
5. **Routability probe** on the top 3 (`probe.maxCandidates`).
6. **Rank** by tiers (§8.8).

**Options.** The outcome presents up to 3 eligible candidates (`--options`, default 3) that differ in at least one of these ways:
- their partition (different subsystems after merging);
- their subsystem arrangement (the order of subsystem centroids along either axis differs);
- mean part displacement between them of at least 3 mm.

The top-ranked candidate is always option A. Options B and C are the best-ranked candidates distinct from all earlier options.

Each option lists its variant key, its tier vector, and a three-line trade-off against option A, generated from the tier differences (for example "hot-loop area 18 % smaller; one more critical crossing; routability equal"). `--apply` writes option A unless `--option B|C` is given.

### 8.7 Critical-net routing and revision

- **Critical nets:**
  - nets of every `hot-loop`, `supply-decoupling`, `bootstrap` and `output-chain` relation;
  - power nets;
  - nets the intent or the routing classification marks critical (`src/pcb/engines/plan.ts`).
- **Routing.** `critical-route.ts` calls `routeBoard` on the materialised candidate with:
  - `netNames` set to the critical nets;
  - `router-freerouting`, mode `single`;
  - a 45 s budget, and the board's rules.

  The result is measurement only and is never kept as copper.
- **Inspection:**
  - `critical_completion`;
  - `critical_detour_ratio`: routed length ÷ straight-line pad distance per connection, 90th percentile;
  - `critical_vias`;
  - the return-path checker with `sensitiveNetIds` from `sensitive` relations: pour crossings, fragments, stitching.
- **Findings:**
  - `reuse.critical.unrouted` per unrouted critical connection, naming its parts and pins;
  - `reuse.critical.detour` above a ratio of 2;
  - `quality.pour.crossing` on sensitive nets.
- **Revision cycle**, at most 3 per candidate family, each producing a new candidate that keeps the history:
  1. **Deterministic rules** (`revise.ts`), in order:
     - rotate the parts on an unrouted or detoured critical connection to face each other;
     - swap equal-footprint support parts when that shortens the connection;
     - release the `remaining` parts between the two pads and repack them;
     - for a pour crossing, move the `signal` or `low` part whose track crosses away from the sensitive net's path.

     Then re-execute from the earliest affected phase, and reroute.
  2. **Model reassessment,** with `--model`, when the rules leave failures. One `placer-reuse-plan` round receives the failures with their subsystem, parts, pins and routed geometry summary, and returns plan edits: orientations, region hints, relations, releases, phase membership. Re-execute from the earliest affected phase, and reroute.
- **Afterwards.** Revised candidates re-enter the funnel at step 4, and the routability probe (step 5) runs on the final top 3.

### 8.8 Ranking by engineering tiers

Profile `engineering-placement-2-layer` (§6.1). The gates come first, as today: an ineligible candidate never outranks an eligible one. Eligible candidates are then compared **tier by tier**. Values within a tier's tolerance count as equal, and the comparison moves to the next tier. The existing weighted score breaks final ties, and Pareto membership is kept.

| Tier | Priority | Compared on (in order) | Better | Equal within |
| --- | --- | --- | --- | --- |
| T1 | Mechanical correctness | soft mechanical violations (hard ones are gates); total offset from mechanical targets | lower | 0; 0.1 mm |
| T2 | Datasheet-required placement | soft violations of `supply-decoupling`, `bootstrap`, `config`, `crystal`, `output-chain`; mean excess distance over their maxima | lower | 0; 0.25 mm |
| T3 | Antenna and thermal | RF keepout and thermal violations; smallest RF clearance margin | lower; higher | 0; 0.5 mm |
| T4 | High-current loop area | summed `hot-loop` and output return loop area, mm² | lower | 10 % |
| T5 | Sensitive signal separation | isolation and channel violations; smallest isolation margin | lower; higher | 0; 0.5 mm |
| T6 | Pin-facing orientation | escape conflicts on critical relations plus critical ratsnest crossings | lower | 1 |
| T7 | Routability | `critical_completion`; `routability_completion`; `critical_detour_ratio`; `estimate_overflow` (stage 6) | higher; higher; lower; lower | 0; 2 points; 0.2; 5 % |
| T8 | Trace length | class-weighted HPWL | lower | 5 % |
| T9 | Visual neatness | alignment score (§18); 0 until it exists | higher | none |

- **Unmeasured tiers.** A tier a candidate has not been measured on (for example T7 before routing) compares as unknown, and ties with any value. The funnel measures the same tiers for all candidates at each step.
- **Profile structure.** `ScoringProfile` gains `tiers: { id, metrics: { key, better: 'lower' | 'higher', tolerance: { abs?: number; rel?: number } }[] }[]`. `rank()` uses tiers when present; the existing profiles, without tiers, rank as today.
- **Tolerances** are defaults to calibrate on the P reports (open decision 17).

## 9. The model in v0

### 9.1 Role

The model plays the engineer's planning part. It does not place parts:
1. **Identify blocks and roles:** subsystem edits, roles and signal flow.
2. **Classify critical relationships** the rules missed, from part values, pin names and the cached datasheet facts.
3. **Order placement phases:** move parts between phases, within the validation rules.
4. **Propose regions and orientations:** region hints and pin-facing hints.
5. **Reassess failures:** after critical routing (§8.7), turn failures into plan edits.

`placer-reuse-plan` makes one tool-less `Provider.chat` call per round and validates the JSON reply, as the repair planner does.

### 9.2 Input

The system prompt (template `reuse-plan/1`) explains:
- the plan fields;
- that the engine computes every coordinate;
- the engineering order and the nine priorities of §1;
- that relations must cite a datasheet fact, a pin name or a part class.

The user message is one JSON document with no coordinates beyond part positions:

```jsonc
{
  "board": { "outlineBBoxMm": [0, 0, 60, 40], "keepouts": [], "capacity": { "front": 0.48, "warn": 0.62 } },
  "parts": [
    { "ref": "U3", "value": "TAS5805M", "footprint": "HTSSOP-28", "sizeMm": [9.7, 6.4], "status": "added",
      "pins": { "PVDD": ["1", "2"], "BST_A": ["26"], "OUT_A": ["27"] }, "nets": ["PVDD", "OUT_A", "BST_A"] }
  ],
  "subsystemVariants": [{ "partition": "anchor", "cleanup": "support", "subsystems": [{ "id": "amp", "anchor": "U3", "members": ["U3", "C10", "C11", "L1", "L2"] }] }],
  "critical": [{ "class": "supply-decoupling", "refs": ["C10", "U3"], "pins": ["U3.PVDD"], "source": "rule", "severity": "soft" }],
  "datasheetFacts": [{ "ref": "U3", "text": "decoupling at the PVDD pins; bootstrap capacitors per output", "cite": "TAS5805M datasheet 8.1.3" }],
  "reference": { "transfer": { "basis": "outline", "outlineIoU": 0.93 }, "delta": { "added": ["U3"], "footprintChanged": [], "displaced": [] } },
  "defaultPlan": { "...": "§8.2" },
  "screened": [{ "variant": { "partition": "anchor", "cleanup": "support", "islandSplit": "none" }, "tiers": { "T1": [0, 0], "T2": [2, 0.8], "T4": [64.0] }, "findings": [] }]
}
```

- `datasheetFacts` come from the intent compiler's cached datasheets (`cachedDatasheets`), trimmed per part.
- Board text is data inside JSON strings, never instructions.
- In a reassessment round, the message adds `criticalRouting`: unrouted connections, detours, pour crossings, each with parts, pins and subsystem.

### 9.3 Output

`{ "plans": [PlacementPlan, ...] }` with K plans (default 2) in different stances:
- **`strict`:** keep the reference and the default phases, and change only what findings require.
- **`engineer`:** reorganise regions and orientations to the engineering priorities.

Plans are validated by `plan.ts` (§8.1). One retry with the parse error, then the round is lost.

### 9.4 Rounds

1. **Planning round** on the default plans' screened results.
2. **Screen and route.** The model's plans enter the variant funnel (§8.6), and critical routing runs on their best candidates.
3. **Up to 2 reassessment rounds** on remaining critical-routing failures (§8.7).

The loop stops early when an option passes the placement gate with every part placed and has no critical-routing findings, or when the budget runs out.

### 9.5 Coordinate fallback

`placer-reuse-coordinates` runs only with `--model` and without `--no-fallback`, when no candidate passes the placement gate with every part placed.

- **Model's parts:** only the best candidate's unplaced parts and the parts named in its gate findings.
- **Input:** those parts' courtyard boxes per rotation and pad offsets, with everything else as obstacles.
- **Output:** coordinates. Entries outside that set are dropped (`reuse.model.illegal-move`).
- **Loop:** the rule stages, stage 1 once it exists, and `verifyDesign` after each answer; at most 3 rounds.
- **Result:** a separate candidate with provenance `model-coordinates`.

### 9.6 Replay

Every request and response is stored with the model id, template id, input hash and usage. `pcb reuse --replay <runDir>` reads responses by input hash instead of calling the model.

The packer is deterministic, and critical routing runs Freerouting with a fixed seed. Replay therefore reproduces every candidate placement exactly, and routing metrics within Freerouting's own determinism.

### 9.7 Budget

| Limit | Plan and reassessment | Coordinate fallback |
| --- | --- | --- |
| Output tokens per run | 25,000 | 30,000 |
| Rounds | 1 planning + 2 reassessment | 3 |
| Timeout per round | 600 s | 900 s |
| Wall time per run | 2,400 s, shared, excluding the routability probe | |

When a budget runs out, the engine ends with its best candidates and emits `reuse.model.budget`.

## 10. Stages that add determinism

The model's decisions in v0 are:
- (a) releases beyond the delta set;
- (b) critical relationship classification beyond the rules, and support grouping;
- (c) ambiguous matches;
- (d) regions and signal flow;
- (e) orientations, phase membership and order;
- (f) fallback coordinates;
- (g) subsystem edits;
- (h) reassessment after critical routing.

A stage merges when its report (§13.4) meets two conditions:
- it is no worse than the previous stage on the tier vector of the selected option (T1 to T7 within tolerance) and on fidelity;
- it lowers `model_share`, model output tokens or fallback use.

| Stage | Adds | Takes | Extends |
| --- | --- | --- | --- |
| 1 | Minimal-displacement repair: nearest-legal search against repacking with a strong reference pull | (a), (f) | `engines/reuse/repair.ts`, `engines/legalize.ts` |
| 2 | Critical relationship rules completed from datasheet facts, with deterministic extraction for the common forms (decoupling at named pins, bootstrap per output, inductor between output and connector, antenna clearance); attachment groups | (b) | `intent/critical.ts`, `agent/intent/compiler.ts` step 3 |
| 3 | Matching by attribute costs, net-neighbourhood signatures and optimal assignment | (c) | `engines/reuse/match.ts` |
| 4 | Region planning over subsystems along signal flow; partition refinement scored on the reference placement | (d), (g) | `intent/blocks.ts`, `engines/reuse/floorplan.ts` |
| 5 | Packer upgrades: exact courtyards, several candidates per segment, backtracking, optional repulsion (P6) | (f), part of (e) | `src/vendor/calculate-packing/` |
| 6 | Pin-facing orientation pass, ratsnest crossings, coarse routability estimate | (e) | `engines/reuse/orient.ts`, `verify/estimate.ts` |
| 7 | Revision policy learned from the P reports' critical-routing failure taxonomy, plus refinement that preserves the reference | (h) | `engines/reuse/revise.ts`, `engines/reuse/refine.ts` |

### 10.1 Stage 1: minimal-displacement repair

Two repairers are measured against each other:
- **(i) Nearest-legal search:** conflicting parts reinserted at the nearest legal position on a 0.05 mm spiral grid, with exact courtyard rectangles, clearance inflation and one spatial index per side (`flatbush`, ISC); area order first, then x order, then 4 seeded random orders; least total displacement wins.
- **(ii) Repacking:** conflicting parts plus static neighbours within 1 mm, with `priorWeight` 1.

P1 compares displacement, tier vector and gate pass, and keeps the better one. It runs after every phase that leaves conflicts, after each fallback round, and on every other placer's result in `placeBoard`.

### 10.2 Stage 2: critical relationship rules from datasheets

- **Deterministic extraction** of the common datasheet forms from cached datasheet text:
  - supply pins named with a decoupling value and distance;
  - "bootstrap capacitor between BST and OUT";
  - output filter inductor and capacitor values per output;
  - antenna clearance in millimetres;
  - exposed-pad thermal vias.

  Each becomes a `CriticalRelation` with `source: 'datasheet'` and a cite. The model's classification (b) is then asked only about pins and parts no rule or extraction covered.
- **Support grouping:** several capacitors on one pin form a group ordered by value; crystal and load capacitors form a group.
- **Measure:** share of model relations duplicated by rules or extraction; T2 and T4 on E8 and the loop boards.

### 10.3 Stage 3: matching

- **Cost matrix:** footprint class, pad count, value, and a 2-refinement Weisfeiler–Lehman signature of each part's net neighbourhood (ported from bpc-graph, MIT).
- **Assignment:** Hungarian, with dummy rows and columns at a threshold; ties broken by symbol path, value, distance.
- **Close calls only** go to the model.
- **Measure:** precision and recall against symbol paths, with the paths hidden.

### 10.4 Stage 4: region planning

- **Subsystems and flow:** from the variant, with transferred reference regions as the start in reuse.
- **Area budget:** `demand / u`, starting at 0.48 and rising until the regions fit (`reuse.floorplan.block-dense` past 0.62, `reuse.floorplan.infeasible` past 0.95).
- **Anchors:**
  - edge-connector and RF subsystems touch their edge;
  - fixed parts stay inside their subsystem's region;
  - keepouts are subtracted;
  - flow edges pull regions into sequence.
- **Shape:** a slicing floorplan. Cost = Σ adjacency weight × centroid distance + flow-order violations + area error + aspect penalty + displacement from reference regions. Exhaustive up to 6 subsystems; annealing on normalized Polish expressions (Wong and Liu) above.
- **Partition refinement (takes (g)):** a split, merge or move is accepted when it lowers subsystem cohesion without losing purity on the reference placement.
- **Output:** regions to `layout.functional.group.<slug>`, compiled as per-region `bounds` and boundary in the island packs.
- **Measure:** region IoU against designer blocks, T4 and T5, `model_share`.

### 10.5 Stage 5: packer upgrades

- **Exact courtyards:** courtyards as disjoint rectangles per rotation.
- **Several candidates per segment:** the best point plus the ends of the feasible interval.
- **Bounded backtracking:** on failure, remove up to 3 parts and retry.
- **Multi-start** orders.
- **Optional repulsion term (P6)** replacing box inflation.
- **Measure:** unplaced parts and fallback use to zero on E1 and E2; box utilisation headroom; T5 margins against inflation.

### 10.6 Stage 6: orientation and routability estimate

- **Orientation pass:** each packed part and group takes the rotation minimising class-weighted escape conflicts and crossings on its critical relations, with a penalty for changing rotation; stage 1 runs afterwards.
- **Ratsnest crossings** per net pair on the same side, ground and pours excluded.
- **Coarse estimate:** a 1 mm grid with capacity from netclass width and clearance, and A* with negotiated congestion (PathFinder), at most 8 iterations and under 1 s for 50 parts. It writes no copper.
- **Measure:** T6 before and after; within-board correlation of crossings and the estimate with `critical_completion` and probe completion; screening quality (does the in-memory top 8 contain the final option A).

### 10.7 Stage 7: revision policy and refinement

- **Failure taxonomy.** Each P report classifies critical-routing failures: unrouted between facing parts, blocked channel, detour around an obstacle, pour crossing, via-limited.
- **Rules per class** are added to `revise.ts` when they fix at least as many failures as model reassessment on the same cases.
- **Refinement:** simulated annealing with cost in tier order, as a lexicographic penalty (T2 violations ≫ T4 area ≫ T5 margin ≫ T6 ≫ T8 length), plus displacement from reference. Stage 1 runs afterwards.
- **Measure:** reassessment rounds and tokens down; T4 to T7 not worse.

### 10.8 What stays with the model after stage 7

- Ambiguity beyond the matcher's margin.
- Conflicts between reference and rules.
- Critical relationships no rule or extraction covers.
- Explanations of options.
- `related` mode across different designs.

## 11. Electrical intent track

Today the intent checker evaluates `mechanical.fixed/edge/orientation`, `relative.attached`, `functional.group/separation`, `manufacturing.keepout` and `routing.width`. The `electrical-layout`, `emc` and `thermal` classes exist in the constraint type but have no evaluator, and `gates.ts` already gates on `intent.electrical-layout.creepage`.

| Checker | Delivered with | Default severity |
| --- | --- | --- |
| C1 voltage clearance | stage 1 | hard |
| C2 current loops (switching hot loops, amplifier output return loops) | v0 (T4 needs it) | soft; hard with a number |
| C3 isolation (aggressor/sensitive, channels, RF edge and clearance, crystal edge distance) | v0 (T3, T5 need it) | soft; hard with a number |
| C4 thermal (distance, back-side keepout under exposed pads) and matched pairs | stage 2 | soft |
| C5 ordered chains (output filter order) | v0 (T2 needs it) | soft |

### 11.1 C1: voltage clearance

- **Voltages:** `layout.electrical-layout.voltage.<net>` from intent (`electrical.voltages`), net-name inference (soft, confidence at most 0.6), or model proposals (at most 0.6).
- **Domains and clearance:** domains pair up into `layout.electrical-layout.creepage.<a>.<b>`. The `voltageClearance` table in the fabrication profile is entered at implementation from IPC-2221B Table 6-1 (external, uncoated), not from memory. Mains and safety-rated products need product-standard values (IEC 60664-1, IEC 62368-1) as user intent.
- **Evaluation:** shortest pad-copper distance between domains (through-hole pads on every layer), with no credit for slots. Hard violations gate. `intent.electrical-layout.voltage-unknown` (info) fires for high-voltage-looking net names without voltages.
- **Placement effect:** box inflation in compilation, pad inflation in stage 1.

### 11.2 C2: current loops

- **Switching hot loops:** buck (input capacitor, high-side switch or IC VIN/SW, low-side switch or diode, ground) and boost (switch, diode, output capacitor, ground). Recognised by `SW`/`LX`/`PH` pins or net names, an inductor on the switch net, and capacitors to ground.
- **Class-D supply loops:** PVCC/PVDD capacitor, power pin, output stage, ground pin.
- **Output return loops:** amplifier output pin, inductor, capacitor or speaker connector pin, and back to the amplifier's ground or opposite output pin.
- **Constraint:** `layout.emc.hot-loop.<id>` with `{ kind: 'switching' | 'supply' | 'output', parts, pads (loop order), max_area_nm2? }`.
- **Metric:** polygon area through the pad centres in loop order, in mm² (`loop_area_mm2`, summed as T4).
- **Violation:** `intent.emc.hot-loop` when a maximum is given.

### 11.3 C3: isolation

- **Parts:** `aggressor` and `sensitive` parts from §7.6.
- **Constraints:**
  - `layout.emc.isolation.<id>`: courtyard-to-courtyard distance between aggressor and sensitive sets;
  - `layout.emc.channel.<id>`: between left and right channel output groups;
  - `layout.emc.edge-distance.<ref>`: crystals from edges and connectors;
  - `layout.rf.edge.<ref>`: the RF module's antenna side within 1 mm of the board edge, and its clearance keepout free of copper, parts and other modules, with `minMm` from the datasheet or intent (the ESP32 guideline's 15 mm is a recommendation, soft unless the intent makes it hard).
- **Metrics without a number:** `isolation_min_mm`, `channel_min_mm`, `crystal_edge_min_mm`, `rf_clearance_min_mm`.
- **Violations:** `intent.emc.isolation`, `intent.emc.channel`, `intent.emc.edge-distance`, `intent.rf.edge`, `intent.rf.clearance`.

### 11.4 C4: thermal and matched pairs

- **`layout.thermal.distance.<id>`:** `{ hot, protect, min_nm }`.
- **`layout.thermal.exposed-pad.<ref>`:** no back-side part over the exposed pad's area plus 1 mm, so thermal vias fit.
- **`layout.electrical-layout.matched.<id>`:** `{ pairs, max_offset_nm, axis? }`.
- **Violations:** `intent.thermal.distance`, `intent.thermal.exposed-pad`, `intent.electrical-layout.matched`.

### 11.5 C5: ordered chains

- **Constraint:** `layout.relative.chain.<id>` with `{ order: [refs], max_length_nm?, max_step_nm? }`. Example: amplifier OUT_A, then L1, then C12, then J3.
- **Evaluation:**
  - **Order:** each part's projection onto the line from the first part's pad to the last part's pad is monotonic in chain order, within half a courtyard.
  - **Detour:** the summed pad-to-pad path length ÷ the first-to-last distance.
- **Violations:** `intent.relative.chain.order`, and `intent.relative.chain.length` against a maximum. The detour ratio feeds T2's excess distance.

### 11.6 Intent language additions

`docs/LAYOUT.intent.yaml` gains the keys below. Unknown keys still `HOLD`.

```yaml
electrical:
  voltages: { PVDD: 24, "+3V3": 3.3 }          # long form { volts: 325, kind: ac-peak } for AC
placement:
  critical:                                    # §7.6 relations stated by the user
    - class: supply-decoupling
      refs: [C10, U3]
      pins: [U3.PVDD]
      max_mm: 2
  hot_loops:
    - kind: supply
      parts: [C10, U3]
      max_area_mm2: 20
  chains:
    - order: [U3, L1, C12, J3]
  isolation:
    - noisy: [U3, L1, L2]
      sensitive: [U1, R4]
      min_mm: 5
  channels:
    - left: [L1, C12]
      right: [L2, C13]
      min_mm: 3
  rf:
    - ref: U1
      edge: top
      clearance_mm: 15
  edge_distance:
    - ref: Y1
      min_mm: 3
  thermal:
    - hot: [U3]
      protect: [C20]
      min_mm: 6
  exposed_pads: [U3]
  matched:
    - pairs: [[Q3, Q4]]
      max_offset_mm: 0.5
```

`electrical` joins `placement` and `routing` at the top level. The intent compiler's step 3 rule language gains the same keys, so datasheet-derived rules use them.

### 11.7 Fixtures and measure

`bench/golden/generate.ts` adds microboards, each with a seeded violation and a fixed variant:
- `hv-clearance`;
- `buck-hot-loop` (input capacitor 12 mm from the regulator);
- `noisy-sensitive` (crystal beside an ADC input, 1 mm from the edge);
- `amp-output-chain` (inductor placed beyond the connector);
- `rf-edge` (module antenna 8 mm inside the edge, a capacitor in the clearance);
- `exposed-pad` (a back-side resistor under an exposed pad).

They join `intent-microboards`, and the measure is B3's.

## 12. Command

```bash
copperhead pcb reuse --board new.kicad_pcb --reference old.kicad_pcb \
  [--mode revision|related] [--model claude-code:claude-opus-5] [--plans 2] [--rounds 3] [--no-fallback] \
  [--max-variants 48] [--options 3] [--option A|B|C] [--no-critical-routing] \
  [--movable R1,C3] [--budget-seconds 2400] [--max-output-tokens 25000] \
  [--no-probe] [--probe-top 3] [--replay <runDir>] [--apply] [--run-dir <path>] [--json]
```

- **Without `--model`:** `placer-reuse-copy` and `placer-reuse-pack` over the variant matrix, with deterministic revision, and the baselines. LLM-free and network-free.
- **With `--model`:** adds `placer-reuse-plan`, and `placer-reuse-coordinates` unless `--no-fallback`.
- **Output:**
  - `options.md`: options A to C with variant keys, tier vectors, trade-offs and renders;
  - `ranking.json` and `outcome.json`;
  - `board.svg` per option;
  - `variants/` with every plan, phase result, screen result and critical-routing result.
- **`--apply`** writes option A, or the option named by `--option`.
- **`related` mode** checks the reference licence with `intent/licenses.ts`.
- **Every placement command** gains the feasibility check and the §7.6 and §11 evaluators.

**Later:** `pcb layout --reference`, and `pcb.reuseReference` for `create`.

## 13. Evaluation

### 13.1 Corpus

| Set | Content | Ground truth | From |
| --- | --- | --- | --- |
| E1 | ecc83-pp to ecc83-pp_v2 | the designer's v2 | v0 |
| E2 | Synthetic revisions of the golden microboards and permissive PCBench boards: parts deleted or added, footprints swapped, outline shrunk 5–15 %, a mounting hole moved, one refusal case | original placement; legality and tiers | v0 |
| E3 | Revision pairs mined from open-hardware histories (Glasgow revC3 to revD0 first) | the later revision | stage 3 |
| E4 | OmniLayout layouts with parts deleted or perturbed (licence to confirm; EAGLE import) | the expert placement | stage 4 |
| E5 | The §11.7 microboards | seeded violations | v0 (C2, C3, C5); C1, C4 with their stages |
| E6 | multichannel_mixer, channel to channel | the designer's channels | outside v0 |
| E7 | The 11 KiCad demo boards with at least two sheets | sheets and placement | v0 (subsystems) |
| E8 | `esp32-amp` (sibling project), an ESP32 Bluetooth speaker amplifier (see below) | tiers T1 to T7 and an engineer's review of options A to C | v0 |
| E9 | PCBench loop boards: `kitspace_12_24_boost_converter`, `kitspace_hbridge_driver`, `kitspace_piezo_amplifier` | the designer's placement (loop area, isolation) | v0 |

**E8 in detail.** The workspace schematic (2026-09-06) holds 140 electrical parts:
- ICs: ESP32-WROVER-E, TAS5805M amplifier, AP63205 buck, TPS7A47 LDO, CP2102N USB-UART, CYPD3177 USB-PD sink, two TPS259470 eFuses, USBLC6;
- 5 inductors, 48 capacitors, 37 resistors, and the connectors, buttons, test points and protection parts.

Its board file holds only an outline, and datasheet facts are cited in `research/DATASHEET-FACTS.md`.

At 140 parts it is above this spec's scope, so v0 uses it in two ways:
- (a) its amplifier subsystem (TAS5805M with its supply, bootstrap and output parts) and its power-input subsystem (barrel jack, USB-C, eFuses, AP63205 with its hot loop), each populated with `populateBoard` as a board under 50 parts, and placed with and without E2-style synthetic references;
- (b) the full design for §7.5 and §7.6 classification only, which needs no placement.

The suite is `bench/suites/reuse-revisions.json` (E1, E2, E8's subsystem boards, E9), of kind `placement`, with all four reuse engines plus `placer-fixed` and `placer-pyplacer`, run with `copperbench --max-parallel 1`.

### 13.2 Metrics

Per candidate, in addition to the existing placement metrics:

- **Tier vector:** `tier_T1` to `tier_T9` (each an array of the tier's metrics), and the funnel step reached.
- **Gates:** `gate_passed`, `unplaced_count`, `intent_hard_violations`, `intent_soft_violations`.
- **Loops and chains:** `loop_area_mm2` (by kind), `chain_order_violations`, `chain_detour_ratio`.
- **Separation:** `isolation_min_mm`, `channel_min_mm`, `rf_clearance_min_mm`, `crystal_edge_min_mm`, `creepage_violations`.
- **Orientation:** `escape_conflicts`, `critical_crossings`.
- **Routing:** `critical_completion`, `critical_detour_ratio`, `critical_vias`, `quality.pour.crossing` on sensitive nets, `routability_completion`, `routability_drc_errors`, `estimate_overflow`.
- **Capacity:** `utilisation_front`, `utilisation_back`, `pack_box_utilisation`.
- **Fidelity:** displacement mean, median and max, `pairwise_order_agreement`, `neighbour_jaccard`, `rotation_agreement`, `region_iou`.
- **Subsystems:** `subsystem_count`, `subsystem_cohesion`, `subsystem_purity`, `intrusion_count`, compared only at equal partition.
- **Variants and options:**
  - `variants_generated`, `variants_merged`, `screen_top8_contains_final` (did screening keep the final option A);
  - `option_count`;
  - `option_distinctness` (mean displacement between options).
- **Provenance and model share:**
  - Provenance per part: `copy`, `pack-default`, `pack-model-plan`, `revise-rule`, `revise-model`, `model-coordinates`, `repair`, `floorplan`, `orient`, `refine`.
  - `model_share`: the fraction of movable parts whose position depended on a model plan field that differs from the default plan, or on a model reassessment or fallback.
- **Cost:** `model_rounds`, tokens, `model_seconds`, `packer_seconds`, `screen_seconds`, `critical_routing_seconds`, `probe_seconds`.
- **Matching:** `match_precision`, `match_recall`.

### 13.3 Baselines in every run

- `placer-reuse-copy`.
- `placer-reuse-pack` with the default plan of the first partition and no revision (the flat "tscircuit-like" baseline: one packing run, net distance only, no phases, no classes).
- `placer-fixed`.
- `placer-pyplacer`.
- On E1, E2 and E8 once each: the from-scratch model placement (`llm-place.ts`).

### 13.4 Reports

In `bench/reports/`: `P0-<date>.md` for v0, `P1` to `P7` per stage, and `C1` to `C5` per checker. Each gives:
- per-board tier vectors of options A to C;
- the comparison with the previous stage and with the flat baseline;
- the critical-routing failure taxonomy (from P0 on);
- the merge decision.

## 14. Acceptance criteria

### 14.1 v0

1. On E1, E2 (non-refusal), E8's subsystem boards and E9, `pcb reuse --model` returns at least one option passing the placement gate with every part placed on at least 90 % of cases. Without `--model`, at least 70 %. *(Targets; revisit after P0.)*
2. No candidate that fails a gate ranks above one that passes, and tier ranking follows §8.8. A unit test gives two candidates equal on T1 to T3 and differing on T4 beyond tolerance, and checks T4 decides whatever their HPWL.
3. On E9, the selected option's T4 loop area is no more than 1.25 × the designer's placement's, measured with the same C2 relations. *(Target; revisit after P0.)*
4. On E1, the selected option passes the placement gate with `pairwise_order_agreement` against the designer's v2 of at least 0.88.
5. On every case, the default plan's phases run in the §8.2 order. The phase log shows each phase's parts, and no `low` part is placed before `support`. Unit test on E8.
6. Critical routing runs on the top 5 and the return-path checker on the same candidates. On `amp-output-chain` and `buck-hot-loop` (fixed variants) it reports full `critical_completion`. Deterministic revision fixes a seeded unrouted connection between two parts facing away from each other.
7. Variants:
   - the matrix covers every applicable partition source, the three clean-up settings and both island settings (§8.6), with identical partitions merged;
   - on E7's complex_hierarchy, sheet and anchor partitions merge (they coincide on non-root parts);
   - on each E8 subsystem board, at least 2 distinct options are presented whenever at least 2 distinct eligible candidates exist;
   - `options.md` lists each option's variant key, tier vector and trade-off.
8. Per E2 case with `--model`: median output tokens at most 12,000; median wall time at most 10 minutes excluding the routability probe. *(Targets; revisit after P0.)*
9. Plan validation drops entries naming locked or unknown parts, out-of-order phases and hard model relations (`reuse.plan.invalid-entry`). The fallback drops entries outside its set (`reuse.model.illegal-move`). Unit tests with a scripted provider.
10. `--replay` reproduces every candidate placement exactly with no provider configured.
11. Without `--model`, the command is LLM-free and network-free: a test stubs `globalThis.fetch` to throw and asserts no provider is constructed.
12. Round files and transcripts pass through `redactSecrets`.
13. Every candidate records:
    - reference and target hashes;
    - match set and transform;
    - variant key and plan id;
    - phase log;
    - compiled input hashes;
    - vendored packer commit and patches;
    - critical routing summary;
    - model template, usage and provenance per part.
14. The E2 refusal case ends `REFUSE` before any engine with the shortfall. A board at 70 % runs with `preflight.utilisation.dense`.
15. `src/vendor/calculate-packing/` has `VENDORED.md`, the import guard, ported tests, and a test per patch.
16. Subsystems:
    - on a SUBSYSTEMS.md project, the intent partition equals the headings;
    - on E7, the sheet partition keeps sheets whole, and clean-up `all` lists the parts it moves;
    - anchor and Louvain partitions are generated on every board;
    - `reuse.subsystems.source` names each subsystem's sources.
17. Two-level packing:
    - on a two-subsystem fixture, no part of either island ends inside the other's hull;
    - a forced island failure falls back to flat;
    - intrusion is reported on a seeded fixture and not on the fixed one.
18. Critical relationships:
    - on the full E8 design, rules classify every capacitor on a PVDD, VDD or BST pin and every inductor on an amplifier output as `supply-decoupling`, `bootstrap` or `output-chain`, and the AP63205 input capacitor, switch pins and inductor as a `hot-loop`;
    - relations from cached datasheets carry a cite and are never hard;
    - the E5 microboards for C2, C3 and C5 pass B3's measure.

### 14.2 Per stage

A stage is accepted when its report shows, on E1, E2, E8's subsystem boards and E9 (and E3 and E4 once they exist), all of the following:
- gate pass rate no lower;
- the selected option's tier vector T1 to T7 not worse beyond tolerance on any board;
- fidelity no more than 0.02 lower in pairwise order;
- `model_share`, output tokens, reassessment rounds or fallback use lower.

Additionally:
- **Stage 5:** fallback use is 0 on E1 and E2.
- **Stage 6:** reports the correlations of §10.6.

### 14.3 Electrical track

Each checker is accepted when:
- it detects its seeded E5 violation with the measured value;
- it reports nothing on the fixed variant;
- over the 27 PCBench boards, it produces no hard finding without a number from intent or a cited datasheet.

C1 additionally: `hv-clearance` is refused at the placement gate with a table and voltages.

## 15. Diagnostics

Diagnostics use the existing `Diagnostic` shape.

| Code | Source | Severity | Replaces v0.1 |
| --- | --- | --- | --- |
| `preflight.utilisation.over-capacity` | preflight | error (gate) | PL006 in part |
| `preflight.utilisation.dense` | preflight | warning | none |
| `preflight.utilisation.pad-extents` | preflight | info | PL007 |
| `reuse.reference.unreadable` | reuse | error | PL001 |
| `reuse.outline.invalid` | reuse | error | PL002 |
| `reuse.transfer.outline-mismatch` | reuse | warning | PL003 |
| `reuse.transfer.side-differs` | reuse | warning | none |
| `reuse.match.ambiguous` | reuse | info | PL004 |
| `reuse.match.low-coverage` | reuse | warning | none |
| `reuse.subsystems.source` | reuse | info | none |
| `reuse.subsystems.split` | reuse | info | none |
| `reuse.plan.invalid-entry` | reuse | warning | PL005 in part |
| `reuse.phase.log` (per phase: parts, retries, result) | reuse | info | none |
| `reuse.pack.box-obstacle` | reuse | info | PL007 in part |
| `reuse.pack.retry` | reuse | info | none |
| `reuse.pack.flat-fallback` | reuse | info | none |
| `reuse.pack.unplaceable` | reuse | error | PL006 |
| `reuse.variant.merged` | reuse | info | none |
| `reuse.critical.unrouted` | reuse | warning | PL009 in part |
| `reuse.critical.detour` | reuse | warning | none |
| `reuse.revision.cycle` (what changed, by rule or model) | reuse | info | none |
| `reuse.model.schema-invalid` | reuse | warning | PL012 |
| `reuse.model.illegal-move` | reuse | warning | none |
| `reuse.model.budget` | reuse | warning | PL013 |
| `reuse.fallback.used` | reuse | info | none |
| `reuse.floorplan.block-dense` | reuse | warning | none |
| `reuse.floorplan.infeasible` | reuse | error | PL005 in part |
| `reuse.reference.license-hold` | reuse | error | none |
| `intent.functional.group.intrusion` | intent | soft | none |
| `intent.electrical-layout.creepage` | intent | per constraint (hard: gate) | none |
| `intent.electrical-layout.voltage-unknown` | intent | info | none |
| `intent.emc.hot-loop` | intent | per constraint | none |
| `intent.emc.isolation`, `intent.emc.channel`, `intent.emc.edge-distance` | intent | per constraint | none |
| `intent.rf.edge`, `intent.rf.clearance` | intent | per constraint | none |
| `intent.relative.chain.order`, `intent.relative.chain.length` | intent | per constraint | none |
| `intent.thermal.distance`, `intent.thermal.exposed-pad` | intent | per constraint | none |
| `intent.electrical-layout.matched` | intent | per constraint | none |

The new `intent.*` codes gate only when their constraint is hard, which needs a gate-list change in `gates.ts`.

## 16. Security and reliability

- **Board text and datasheet text are untrusted.** Both travel as JSON strings. The model has no tools, so an injected instruction can at most produce a plan, which validation and the gates check.
- **Model relations are capped and never hard;** a model can never lower a clearance or keepout a user or datasheet set.
- **Credentials** come only from environment variables; round files and transcripts are redacted.
- **Only `--apply` writes the target.**
- **The vendored packer changes only by explicit re-vendoring.**
- **Machine load stays low.**
  - The variant funnel runs in-process until step 3.
  - At most 8 KiCad refills, 5 critical routings (45 s each) and 3 probes run per board, one at a time.
  - The funnel sizes are options, so an overloaded machine can shrink them.

## 17. Implementation plan

| Step | Content | Exit |
| --- | --- | --- |
| 0 | ADR 0012, RFC 11 amendment, OpenSpec change `add-reuse-placer` | `openspec validate`; owner approves |
| v0.a | IR additions; feasibility; subsystem sources and clean-up; matching, transfer, delta; `placer-reuse-copy` | acceptance 14, 16 |
| v0.b | `intent/critical.ts` rules; C2, C3, C5 evaluators and fixtures; intent language keys; compiler step-3 language | acceptance 18 |
| v0.c | Vendored packer with P1 to P5; `plan.ts` default plan; `phases.ts`, `compile.ts` with classes, two-level packing and retries; `placer-reuse-pack` | acceptance 5, 15, 17 |
| v0.d | `variants.ts` funnel and options; `tiers.ts` and tiered `rank()`; `probe.maxCandidates` | acceptance 2, 7 |
| v0.e | `critical-route.ts`, `ProbeOptions.netNames`, `revise.ts` rules | acceptance 6 |
| v0.f | `placer-reuse-plan` planning and reassessment; `placer-reuse-coordinates`; replay; budget | acceptance 9, 10, 12 |
| v0.g | `pcb reuse` command, `options.md`, docs, network test | acceptance 11, 13 |
| v0.h | E2 generator, E8 population, suites, §13.2 metrics, P0 report | acceptance 1, 3, 4, 8 |
| 1 + C1 | Repair; voltage clearance | §14.2, §14.3 |
| 2 + C4 | Datasheet extraction; thermal and matched pairs | §14.2, §14.3 |
| 3 to 7 | One change per stage with its report | §14.2 |

## 18. Beyond stage 7 (not scheduled)

- **Mechanical and assembly.** Enclosure geometry and height zones from a STEP or outline drawing; connector mating overhang; assembler spacing by package class; rail and V-cut bands; fiducials; polarity direction; SMD on one side; test point access; user-facing parts at cutouts.
- **Visual neatness (T9).** An alignment pass (rows, equal pitch, grid snap), with a human-likeness metric from designer boards.
- **Priors from real boards.** Distributions of pin-to-capacitor distance, loop area by topology, isolation distances, and utilisation by board class, to calibrate class weights, tier tolerances and defaults.
- **Interactive use.** Honour user moves, re-place one region, re-run only affected phases.
- **Learning from corrections.** Record placement diffs after `--apply`, and which option the user picked.
- **Images.** Send option renders to the model in reassessment rounds once the provider interface carries images.

**Not planned:** reinforcement-learning placers, analytical GPU placers at 50 parts or fewer, full thermal or signal-integrity simulation.

## 19. Open decisions

Decisions 14 to 16 of the previous revision are resolved by the owner (2026-09-16): every choice becomes a variant axis (§8.6), and options are presented.

1. **Command surface:** `pcb reuse` (this spec), or `--reference` on `pcb place` with the model behind `pcb layout`.
2. **Images** in reassessment rounds.
3. **Side flips and mirroring** in `related` mode.
4. **K plans and model choice** for planning and for reassessment.
5. **v0 target numbers** in §14.1 criteria 1, 3 and 8.
6. **Placement without a reference** (same pipeline, no copy) in v0 or as a baseline.
7. **OmniLayout data licence** before E4.
8. **Coordinate fallback** in v0.
9. **High-voltage boards without voltages:** warn or `HOLD`.
10. **Region planning in `revision` mode** moving copied blocks.
11. **Utilisation thresholds** by board class.
12. **Vendoring details:** flatten-js or polygon-clipping; `src/vendor/`.
13. **Probe budget:** top 3, or time cap.
14. **Class weights** (§7.6) and **tier tolerances** (§8.8): keep the stated defaults until P0, or calibrate first on E9 designer boards.
15. **Phase order changes by the model:** within validation (this spec), or fixed order with only membership changes.
16. **Critical routing budget:** top 5 at 45 s each (this spec), or top 3.
17. **Routability position:** T7 as the owner's order says (this spec), or a gate on `critical_completion` below a floor (for example 80 %) to stop elegant but unroutable options.

## 20. References

- RFC 11, The Copperhead PCB Layout Generation Standard: §3.8, §6, §7, §8.1, §8.3, §8.5, §8.6, §10.4, §11.
- Copperhead evidence:
  - B2, B3 and B4 reports;
  - ADR 0008;
  - `manual-tests/runs/pcb-schematic-demo/llm-place.ts`;
  - `manual-tests/runs/placer-research-2026-09-16/` (utilisation, alignment, legalization, subsystems);
  - `src/pcb/verify/scoring.ts`, `src/pcb/engines/plan.ts`, `src/pcb/engines/route.ts`, `src/pcb/verify/checkers/returnpath.ts`, `src/pcb/agent/intent/compiler.ts`.
- Owner input, 2026-09-16: the hardware engineer's placement order and priorities (§1, §4).
- `esp32-amp` (sibling project): `research/DATASHEET-FACTS.md`, `research/LOUDER-ARCHITECTURE.md` (verified 2026-09-04), citing the ESP32 Hardware Design Guidelines (PCB layout design) and the TAS5805M and MAX98357A datasheets.
- tscircuit, all MIT:
  - core `e0c6b3d` (`Group.ts`, `Group_doInitialPcbLayoutPack/`);
  - calculate-packing `a2d60ae` (`lib/types.ts`, `PackSolver2/`, `SingleComponentPackSolver/`, `OutlineSegmentCandidatePointSolver/`, `plumbing/`);
  - bpc-graph `e1d3fb8`, matchpack `32dad82`.
- Papers:
  - OmniLayout, arXiv 2607.03261;
  - MAGE, arXiv 2607.18536;
  - Subitizing-Inspired LLMs for Floorplanning, arXiv 2504.12076;
  - PCBWorld, arXiv 2607.05915.
- Algorithms:
  - Umeyama, TPAMI 1991;
  - Wong and Liu, DAC 1986;
  - McMurchie and Ebeling, PathFinder, FPGA 1995;
  - Spindler et al., Abacus, ISPD 2008;
  - Spindler and Johannes, RUDY, DATE 2007;
  - Blondel et al., J. Stat. Mech. P10008, 2008;
  - Hubert and Arabie, Journal of Classification 2(1), 1985.
- KiCad 10 multichannel tool and topology matcher.
- Standards, read at implementation: IPC-2221B Table 6-1, IEC 60664-1, IEC 62368-1.
