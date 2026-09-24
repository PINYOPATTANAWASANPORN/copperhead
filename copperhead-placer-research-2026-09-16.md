# Placer Research, 2026-09-16

Research behind CH-PLACE-0001 v0.2 (`copperhead-llm-placement-engine-spec-v0.2.md`). The question: how to build a copperhead placer in stages, starting with a v0 in which a model copies an existing board's placement and adapts it, then replacing the model's work with deterministic algorithms.

Four research threads ran in parallel: tscircuit, LLM and VLM placement, layout reuse, and deterministic placement. A verification pass then checked the claims the spec depends on.

**Status marks:**
- **[checked]**: verified against the primary source or re-run locally on 2026-09-16.
- **[cited]**: from a research thread, with its source given, not re-checked.
- **[unverified]**: the thread could not confirm it.

Scripts and result files are kept in `manual-tests/runs/placer-research-2026-09-16/`, which git ignores: `layout-reuse/ecc.py` and `align.py`, `deterministic/cpsat_legalize.py`, `greedy_orders.py` and their JSON results, and `tscircuit/packtest/`.

## 1. Where copperhead stands

- **B2 (2026-09-06)** [checked]:
  - pyplacer produced candidates on 17 PCBench boards, and every one had a courtyard overlap.
  - kicad-tools 0.20 force-directed left the outline on every board it finished; its evolutionary strategy crashes.
  - The designers' placements won all 20 real boards.
  - Selection regret was 0, and no invalid candidate outranked a valid one.
- **B3 and B4** [checked]:
  - The rule stages (edge, keepout, separation) brought hard intent to 9 of 9 on the curated boards.
  - Repair cycles fixed no real board.
- **Model prototype** (`manual-tests/runs/pcb-schematic-demo/llm-place.ts`, 2026-09-15) [checked from its logs]:
  - The model returns every part's x, y and rotation, and the verifier reports geometry errors and shorts after each round.

| Board | Placement errors | Output tokens | Time |
| --- | --- | --- | --- |
| ecc83 | 0 in round 1 | 52k | 598 s |
| sonde | 2 in round 1, 0 in round 2 | 192k | about 39 min |
| interf_u | 0 in round 1 | 171k | 2,081 s |

On ecc83, round 2 failed to parse. No placed board was written, and nothing was routed.

## 2. Model-driven placement, 2023 to September 2026

### 2.1 The model writes coordinates

| System | What the model does | Result | Status |
| --- | --- | --- | --- |
| OmniLayout, arXiv 2607.03261 (July 2026), 1,681 schematic-coupled layouts | Returns `{"placements": [{name, x, y, rotation}]}` JSON from a schematic image, part sizes, netlist and outline | GPT-5.5 unaided: overlap 0.07, out-of-board 0.17. With layout-render, overlap and routability tools: 0.007 and 0.019. Gemini 3.1 Pro unaided: 0.26 and 0.10; with tools: 0 and 0. Quilter baseline: 0.023 and 0.019 in 5,841 s | [checked] |
| OmniLayout few-shot | Few-shot examples in the prompt | The text says few-shot helps consistently; the tables are mixed across models | [checked: unclear] |
| MAGE, arXiv 2607.18536 (July 2026), Kahng, Kundu, Pramanik; chip macros | Claude Opus 4.6 writes macro coordinates as JSON in six phases, with rendered flyline and whitespace images as mandatory checks; one group's placement is transformed onto similar groups | Against Hier-RTLMP: WNS 47.0 % better, TNS 80.4 % better. Without images: WNS 40.5 % worse, TNS 133 % worse | [checked] |
| Subitizing floorplanning, arXiv 2504.12076 (April 2025) | Fine-tuned models emit slicing trees | GPT-4o-mini optimal 57 % to 82 % at 16 modules, 12 % at 24 | [checked] |

### 2.2 The model guides an optimiser

- **VeoPlace** (arXiv 2603.28733, March 2026) [cited]:
  - Gemini 2.5 Flash sees the rendered canvas and proposes a region per macro, which an RL placer or DREAMPlace then respects.
  - Better than ChiPFormer on 9 of 10 benchmarks.
  - About 125 calls and about 8 hours per run.
  - About 20 % of its suggestions overlap and fall back.
- **PCBAgent** (ASP-DAC 2025) [cited]:
  - An RL placer with legality masks does the placing. The model turns user intent into commands and fine-tuning parameters.
  - Legal on 17 industrial boards, at 1.04 times the manual wirelength.
- **Tuning and scripting agents** [cited]:
  - ORFS-agent (arXiv 2506.08332) tunes OpenROAD flow parameters.
  - LayoutCopilot (arXiv 2406.18873) turns analog layout requests into scripts.
  - ICPI (arXiv 2608.13767) tunes an analog layout generator's parameters.

### 2.3 The model writes placement code

- **Evolved code** [cited]:
  - Evolved global placer (arXiv 2504.17801): wirelength 5 % to 8 % better.
  - OrderPlace (arXiv 2606.08904, ICML 2026): evolves macro-ordering code.
  - GR-Evolve (arXiv 2604.22234): evolves global-router code.
- **Caveat** [cited]: LLM-evolved bin-packing heuristics generalise poorly (arXiv 2501.11411), and simpler derived heuristics beat them (arXiv 2510.27353).

### 2.4 Failure modes and what helped

- **Global geometry is weak** [cited]. FloorplanQA (arXiv 2507.07644) scores optimisation tasks at 5 % to 45%; GeoGramBench stays under 50 % at its hardest level.
- **Scale collapses between 16 and 24 modules** [checked, 2504.12076].
- **Raw geometry fails, tools succeed** [checked]. PCBWorld (arXiv 2607.05915, routing):
  - A GPT-5.4 tool-calling agent completes 65 % of 99 boards cleanly.
  - The same model writing geometry directly completes 2 %.
  - Of GPT-5.4-nano's direct geometry files, 10 % fail to parse.
- **What helped** [cited except where marked]:
  - regions first, detail after;
  - rendered images as feedback on a candidate (MAGE [checked]);
  - verifier and tool loops (OmniLayout [checked]);
  - several candidates, then selection;
  - meaningful part names.

### 2.5 Copy and adapt

- **No paper found in which a model adapts a previous PCB revision** [cited].
- **Closest work:**
  - MAGE transforms a reference group onto similar groups [checked];
  - VeoPlace retrieves earlier placements with their scores [cited];
  - Diode Computers has Claude propose decoupling-capacitor placements on KiCad boards [cited].

### 2.6 Commercial

No vendor discloses a model that places parts [cited].

| Vendor | Disclosed method |
| --- | --- |
| Quilter | RL trained on synthetic physics; ranks many candidates by routing completion and DRC |
| DeepPCB | RL |
| Cadence Allegro X AI | RL on internal designs; needs mechanical and key-IC positions first |
| Zuken AIPR | Learns from past designs |
| JITX | Placement in code as a kinematic tree |
| CELUS | Exports functional blocks |

Flux discloses nothing technical about placement.

### 2.7 Cost and latency

At Opus 5 output pricing, the prototype's 52k to 192k output tokens cost about $1.30 to $4.80 per board [cited].

Techniques, all [cited]:
- ask for diffs, not full placements;
- cache the fixed prompt prefix, using the 1-hour cache because rounds run longer than 5 minutes;
- use structured outputs (copperhead's `Provider` has none today [checked]);
- let a deterministic legalizer fix small overlaps instead of spending rounds on them;
- work a block at a time, 15 to 20 parts at most;
- use a cheaper model for fix-up rounds, gated by the verifier;
- run candidates in parallel rather than as sequential rounds.

## 3. tscircuit

Shallow clones read on 2026-09-16; all repositories are at `github.com/tscircuit/<repo>`.

### 3.1 Repositories

| Repo | Commit | Licence |
| --- | --- | --- |
| core | `e0c6b3d` (2026-09-15) | LICENSE file present [checked], MIT [cited] |
| calculate-packing | `a2d60ae` (2026-08-30) | LICENSE file present [checked], MIT [cited] |
| bpc-graph | `e1d3fb8` | LICENSE file present [checked], MIT [cited] |
| matchpack | `32dad82` (2026-09-08) | LICENSE file present [checked], MIT [cited] |
| checks | `6851d04` | no licence file [checked] |
| circuit-json-placement-analysis | not recorded | no licence [cited] |
| schematic-match-adapt | not recorded | no licence [cited] |

### 3.2 Placement mechanisms

- **Explicit positions** [cited]: `pcbX`/`pcbY`/`pcbRotation`, edge properties, expressions that refer to other parts' positions and extents, `<constraint>` elements solved with the Cassowary solver, and grid and flex layouts.
- **Pack layout (`PackSolver2` from calculate-packing)** [cited]:
  - The default for any group with more than one unpositioned child and no manual edits.
  - Greedy: parts are ordered by pad count (not area) and never moved once placed.
  - For each edge segment of the already-packed parts and each of 4 rotations, it finds one point that minimises wirelength (an IRLS/Weiszfeld solve).
  - Collision checking uses courtyard bounding boxes only.
  - The solver has no layer concept and no keepouts.
  - When a part has no valid candidate, the whole solve fails.
  - A research run of 7 parts was deterministic and took 20 to 60 ms. With bounds set, a large module with few pads had no valid position; unbounded, it went 2.5 mm off the area (issue core#2272).
  - Open issues and PRs: #43, #128 (rotated courtyards ignored), #130 (first part outside the bounds).
- **PCB match-adapt is not implemented** [checked]. `_getPcbLayoutMode()` can return `"match-adapt"`, but `doInitialPcbLayout` dispatches only `grid`, `pack` and `flex` (`lib/components/primitive-components/Group/Group.ts` at `e0c6b3d`). The issue (core#3136) is open, and its fix PR (#3137) was closed unmerged [cited].
- **Schematic match-adapt** [cited]:
  - **bpc-graph:** partitions the circuit, matches each partition to one of about 90 hand-written corpus designs by Weisfeiler–Lehman (WL) distance, pairs parts greedily, copies template centres, and pushes neighbours apart when sizes differ. It has no match threshold, and in core the corpus is passed empty and the caller is never invoked.
  - **schematic-match-adapt (PMARS):** template edit operations; only the match and adapt stages were built, and it was abandoned in June 2025.
  - **What core runs instead:** since August 2025 core's schematic layout runs **matchpack**. It detects crystals and decoupling capacitors, partitions around chips, packs partitions with `PackSolver2`, and aligns power rows and loads afterwards.
- **Model use** [cited]:
  - No model places parts. tscircuit agents write `pcbX` and loop until `tsci check placement` passes.
  - That check returns findings ranked by severity, with suggested moves such as "move C1 0.25mm down".
  - Their pilot PCB benchmark (2026-09-05) had 0 full passes out of 10.

### 3.2a Second pass on the packer (2026-09-16) [checked]

The owner's analysis (tscircuit's models write code; a deterministic packer computes coordinates) was checked against core `e0c6b3d` and calculate-packing `a2d60ae`.

**Confirmed:**
- **Authored parts are static.** `Group_doInitialPcbLayoutPack.ts` collects static parts, and on their own side they act as obstacles. `_getPcbLayoutMode` returns `pack` only with no manual edits and more than one unpositioned child.
- **Sort order.** `sortComponentQueue.ts` orders by `packFirst`, then pad count (`b.pads.length - a.pads.length`).
- **Statics attract.** `PackSolver2` starts with the static parts as packed parts, so their pads attract and collide. The first free part is placed at the centre, with a fallback that places it there "even if it violates constraints".
- **Cost.** `calculateDistance` sums, per pad, the distance to the nearest packed pad on the same network, squared under the `*_squared_*` strategies. `weightedConnections` only drops weak connections (`isStrongConnection`); weights do not scale the cost.
- **Other side.** Core packs each side separately. Other-side static parts become `network_reference_*` parts with a 1e-6 courtyard, so they attract without colliding.
- **Clusters.** Core unions constrained parts into clusters and solves relative centres with `@lume/kiwi`.

**Limits, from `lib/types.ts` and `SingleComponentPackSolver.ts`:**
- Pads are `type: "rect"`, and a courtyard is one offset box.
- `convertCircuitJsonToPackOutput.ts` reduces rect, polygon, outline and circle courtyards to a bounding box.
- Obstacles are axis-aligned boxes.
- The `boundaryOutline` check tests pad centres and bounding-box corners only.
- `minGap` is global.
- A sub-solver failure fails the whole solve.

**Size and dependencies:**
- `lib/` is about 6,000 lines of TypeScript outside tests, of which `plumbing/` is 882.
- Runtime imports come from `@tscircuit/math-utils` (`computeDistanceBetweenBoxes`, `clamp`, types), `@tscircuit/solver-utils` (`BaseSolver`), `@flatten-js/core` (MIT 1.6.14) and `graphics-debug`. All are listed only under devDependencies.
- The math-utils and solver-utils copies in the clone's node_modules carry no `license` field.

**Consequence:** the spec now uses the packer as v0's geometry backend, behind a model-written or default plan, with five patches: local helpers, exact containment, weighted distance, no silent fallback, and failure detail. See spec §8.

### 3.3 What copperhead takes

- **Code (MIT):**
  - bpc-graph's WL features and matcher, for stage 3, with the greedy assignment replaced by an optimal one.
  - calculate-packing's candidate loop, vendored for stage 4, with courtyards, area ordering, several candidates per segment and board sides added.
- **Ideas:**
  - matchpack's crystal and decoupling detection (stage 2);
  - findings phrased as concrete moves;
  - pushing neighbours apart when a footprint grows.
- **Nothing** from checks, the placement-analysis package or schematic-match-adapt: they have no licence.
- **Not a dependency:** the calculate-packing npm package imports undeclared modules that pulled in 68 MB of dependencies [cited].

## 4. Layout reuse in EDA tools

- **KiCad 9 and 10 multichannel** [cited from KiCad doxygen source and the 10.0.4 changelog]:
  - A placement rule area takes its source from a sheet, component class, group or (in 10) design block. Repeat Layout copies footprints, then tracks, vias, zones and graphics.
  - The transform is the offset between rule-area centres, or the anchor footprint's position and rotation difference.
  - The topology matcher (`topo_match.cpp`) requires the same pin count, the same footprint ID and a compatible refdes prefix, then compares per-pin connection signatures in a backtracking search.
  - **Any unmatched part fails the whole repeat**, and overlaps are not resolved.
  - By those rules KiCad would refuse the ecc83 pair [cited, inferred from the source].
- **Headless use on this machine: none** [cited]:
  - `kicad-cli` 10.0.4 has no layout-apply command.
  - `pcbnew.Multichannel.repeatLayout` is a GUI action.
  - The SWIG `pcbnew` module (importable only from `/usr/bin/python3`) can create rule areas but cannot run the repeat.
  - kicad-python 0.8.0 needs KiCad running.
- **ReplicateLayout** (MitjaNemec, GPL-2.0, 5.0.1) [cited]:
  - Copies a hierarchical sheet around an anchor footprint, including tracks and zones in a bounding box.
  - A GUI plugin with no overlap handling; its README says KiCad now does this natively.
- **HierarchicalPcb** (MIT, archived January 2026) [cited]: matches by internal ID and places around an anchor.
- **atopile LayoutSync** (MIT) [cited]:
  - Matches by an `atopile_address` property.
  - Anchor: the footprint with the most pads. The offset is translation only (the code has `# TODO rotation?`).
  - Skips unmatched parts and does not handle overlaps.
  - Runs headless in `ato build`.
- **Altium** [cited]:
  - Copy Room Formats matches by channel offset or source designator.
  - Layout Replication needs the same components and connectivity; its main component is the one with the most pins.
  - Reuse blocks arrive through an ECO.
  - Matching and conflict details are [unverified].
- **Cadence Allegro Place Replicate** [cited]: a module file mapped onto a selected group of parts. Forum threads report unmatched symbols that must be mapped by hand. Criteria [unverified].
- **Other tools** [cited]:
  - Horizon EDA copies placement relative to a clicked reference package.
  - JITX poses each child relative to its parent in a kinematic tree.
  - EasyEDA Pro uses reuse-block and channel attributes.
  - No layout-reuse feature was found in LibrePCB [unverified].
- **Common finding** [cited]: none of these tools legalizes after the copy; overlaps are left to DRC.

## 5. Matching, alignment, incremental placement

- **Matching tiers** [cited]:
  1. Stable IDs (refdes, symbol path).
  2. Attributes as costs rather than hard filters (footprint, value, pad count, prefix).
  3. Structure: Weisfeiler–Lehman colour refinement on the part–net graph. Exact VF2 breaks under any edit.
  4. Assignment: Hungarian or LAPJV with dummy rows and columns plus a threshold.
  
  Repeated channels and parallel capacitors are symmetric cases; break ties by path, then value, then distance.
- **Libraries** [cited]:
  - npm: munkres-js 1.2.2 (Apache-2.0 or BSD-3); munkres-algorithm 1.0.2 (MIT); ml-matrix 6.15.0 (MIT). No maintained VF2 on npm; WL refinement is small enough to write.
  - Python: networkx 3.6.1 (BSD-3); scipy `linear_sum_assignment` (BSD). igraph and pynauty are GPL.
- **Alignment** [cited]:
  - Single-anchor rigid copy is fragile (worst on ecc83, section 6).
  - Least squares over all matches: Kabsch (rigid) or Umeyama (similarity, 1991), closed form in 2D.
  - Enumerate the 8 rotation and mirror cases.
- **When the outline changes, the options are** [cited]:
  - (a) copy rigidly, clip, legalize;
  - (b) scale by the bounding box;
  - (c) fit on mechanical anchors and interpolate the interior;
  - (d) keep blocks rigid and move only their centroids.
  
  The thread recommends (d), then (c), then legalizing.
- **Incremental and ECO placement** [cited]:
  - Tetris (Hill, 2002).
  - Abacus (Spindler, Schlichtmann, Johannes, ISPD 2008).
  - Min-cost-flow minimum perturbation (Brenner, DATE 2012).
  - Diffusion-based migration (Ren, Pan, Alpert, DAC 2005).
  - ECO-system (Roy, Markov, ASP-DAC 2007).
  - Analog layout retargeting: constraint graphs from the reference's left-of and above relations, then a linear program that minimises displacement.

## 6. The ecc83 revision pair

Source: `/usr/share/kicad/demos/ecc83`, `ecc83-pp.kicad_pcb` to `ecc83-pp_v2.kicad_pcb`.

- **Parts** [checked]:
  - Same 15 reference designators, with 7 footprints changed:
    - C1: CP_Radial D10 to D12.5;
    - C2: 4.7 mm disc to 12 mm axial;
    - P1 to P4: Altech AK300 to 1×02 pin headers;
    - U1: Valve_ECC-83-1 to -2.
  - 7 parts changed rotation.
  - The outline went from 52.07 × 46.36 mm to 48.26 × 41.91 mm.
  - One net was renamed.
- **Identity** [cited]: P5 to P8 have new symbol UUIDs and values. 11 of 15 parts match by symbol path, 0 of 15 by footprint UUID.
- **How well a transform of v1 explains v2** [checked, `align.py` re-run]:

| Transform of v1 | Mean / median / max displacement (mm) | Pairwise order kept |
| --- | --- | --- |
| none | 7.47 / 5.46 / 17.47 | 0.91 |
| outline centre translation | 7.01 / 4.31 / 17.81 | 0.91 |
| outline bounding-box affine (sx 0.927, sy 0.904) | 6.54 / 5.11 / 17.10 | 0.91 |
| best rigid (Kabsch, 3.6°) | 7.16 / 4.67 / 15.78 | 0.91 |
| best similarity (Umeyama, s 0.910) | 7.02 / 4.82 / 14.99 | 0.91 |
| rigid about U1 (today's `placer-layout-reuse`) | 8.21 / 6.32 / 18.39 | 0.91 |
| similarity fit on the 4 mounting holes | 6.59 / 5.01 / 17.40 | 0.91 |

The designer re-laid out the board. No transform gets under 6.5 mm mean displacement, but 91 % of the pairwise left/right and above/below relations survive. Of the rows above, only the outline mappings can be computed at run time; the other fits need the designer's v2 positions.

## 7. Deterministic building blocks

### 7.1 Legalization

| Method | Fit for PCBs | Status |
| --- | --- | --- |
| Nearest-legal-position search (spiral or diamond; OpenROAD `dpl`, BSD-3) | No rows needed; any shape; 4 rotations | [cited] |
| Tetris: the same search in x order, placed parts never move | Good | [cited] |
| Abacus (ISPD 2008): about 30 % less movement than Tetris | Needs rows; the PCB analogue is a constraint graph per axis (VPSC) | [cited] |
| VPSC (Dwyer, Marriott, Stuckey, GD 2005); `webcola` 3.4.0 (MIT) ships an implementation | Good for rectangles | [cited] |
| Min-cost flow (Brenner, Vygen) | Only when a region is over-full | [cited] |
| Linear program over displacement with fixed pair relations; NS-place (arXiv 2210.14259) legalizes PCBs with MILP; `highs` 1.15.3 (MIT, WASM) | Good as a polish | [cited] |
| Shove (what `legalize.ts` does for edge, keepout and separation) | No optimality; can oscillate | [checked] |

**Geometry** [cited]:
- KiCad courtyards are mostly rectilinear and split exactly into rectangles.
- clipper2-ts has Minkowski sums and booleans, but uses float coordinates; nanometre products exceed 2^53 [unverified robustness].
- Spatial indexes: flatbush 4.6.2 (ISC), rbush 4.0.1 (MIT).

**In the repo** [checked]: `polygon-clipping` 0.15.7 is already a dependency. Copperhead has no courtyard-overlap legalizer today.

### 7.2 Legalization experiment

36 footprints (30 movable, 6 locked) plus a keepout, 0.05 mm grid, 0.1 mm gap, 0.5 mm edge inset. The objective was L1 displacement plus 2 mm per rotation change. OR-Tools 9.15 ran in a scratch venv; the `bench/var/tools/or-venv` on this machine has no OR-Tools. [checked from `cpsat_results.json` and `greedy_orders.json`]

| Board (utilisation) | Start: overlapping pairs / off-board | Greedy, area order (total L1) | Tetris x order | Best of 30 random orders (legal count) | CP-SAT, 1 worker, greedy hint |
| --- | --- | --- | --- | --- | --- |
| 62×46 mm (34 %) | 14 / 6 | 62.0 mm, max 9.0 | 64.0 | 49.8 (30/30) | returned its hint after 5 s, gap 79 % |
| 52×40 mm (46 %) | 19 / 6 | 86.0 | 81.5 | 65.8 (26/30) | unchanged after 6 s, gap 84 % |
| 48×37 mm (54 %) | 23 / 6 | 99.0 | 94.5 | 78.0 (10/30) | unchanged after 6 s, gap 86 % |

Greedy runs took 0.07 to 0.09 s in Python. CP-SAT runs no large-neighbourhood search with one worker, so the multi-worker runs it needs clash with the shared machine.

### 7.3 Packing, optimisation, exact solvers

All [cited]:
- **Rectangle packers** (MaxRects, skyline; `maxrects-packer` 2.7.3, MIT) are blind to nets.
- **Nesting engines** (SVGnest, MIT; sparrow, MIT) maximise density, which a PCB does not want. Borrow the no-fit polygon as a primitive only.
- **Simulated annealing** with a displacement penalty: about 10^5 moves on 50 parts in under a second in TypeScript [estimate]. pyplacer failed on representation (bounding boxes, no edge rule), not on annealing.
- **Analytical placers** (ePlace, RePlAce, DREAMPlace; Cypress for PCBs, ISPD 2025, Apache-2.0) are not worthwhile at 50 parts; revisit above about 300.
- **CP-SAT** (`NoOverlap2D` with optional boxes per rotation) is feasible at this size but proves little optimality. It is useful for proving an outline infeasible, or for exactly re-placing a window of 8 to 10 parts [untested].

### 7.4 Cheap routability estimates

All [cited]:
- **HPWL:**
  - B2 measured r = 0.03 on 12 microboard candidates and −0.65 across PCBench, mostly a board-size effect [checked, B2].
  - On `decoupling-far`, halving HPWL halved routing completion [checked, B2].
- **RUDY** (Spindler, Johannes, DATE 2007): a 3D variant reaches Pearson 0.85 against chip global-route congestion.
- **Ratsnest crossings:** each is roughly a via or a detour on two layers. No PCB study found.
- **Channel capacity:** at 2.54 mm pitch with 1.6 mm pads, the gap fits 2 tracks at 0.15/0.15 mm or 1 at 0.25/0.20 mm.
- **NS-place:** a net-separation margin cut routed wirelength 25 %, vias 50 % and DRC violations 79 % on 14 boards.
- **Conclusion:** none of these is validated against detailed-route completion on small two-layer PCBs, so copperhead must measure it within each board.

## 8. Datasets

- **OmniLayout:** 1,681 layouts, 77.24k placement instances, EAGLE XML. The paper names both CC-BY-4.0 (data) and CC BY-NC-ND 4.0 (paper) [checked: both statements present; which covers the data needs confirming].
- **PCB-Bench** (ICLR 2026): 174 OSHWHub projects with placement files, no licence file [cited].
- **PCBWorld D3:** 679 open-source boards (99 in D3-A); licence per its Appendix P [checked: counts; licence not read].
- **PCBench** (MIT repository): per-board licences, 605 of 1,183 unrecorded [checked, from the framework's corpus notes].
- **Cypress** (Apache-2.0 code) [cited]; data licence [unverified].
- **Revision pairs:** no public dataset [cited].
  - Candidate: Glasgow `hardware/boards/glasgow` revC3 and revD0 [cited]. The repository carries 0BSD and Apache-2.0 licence files [checked]; which covers the hardware [unverified].
  - Mining approach: git history of `*.kicad_pcb` files, keeping commit pairs whose footprint sets overlap at Jaccard 0.7 or more and whose parts moved.

## 9. Stage orders the threads proposed

| Thread | Order after v0 |
| --- | --- |
| LLM placement | legalizer; attachment rules; topology matching plus anchor transform; region packing with the model choosing regions; global optimiser with a congestion proxy; offline heuristic evolution |
| Layout reuse | matching (tiers, WL, Hungarian); global alignment (8 cases, weighted Umeyama); outline remap per block; added parts by attachment rules; order-preserving minimum-displacement legalizer; reuse-fidelity scoring |
| Deterministic | exact-geometry legalizer; attachment rules; routability score; net-aware packing of unmatched parts; annealing that keeps the prior; optional exact polish (VPSC, LP, CP-SAT window) |
| tscircuit | pre-match before prompting; matching (WL plus optimal assignment); alignment and transfer; packing with fixed parts as obstacles; optimisation from elsewhere |

**Reconciled in the spec (§10, after the second revision the same day).** Packing moved into v0 as the vendored calculate-packing behind a placement plan, so the stages now take planning decisions away from the model:
1. minimal-displacement repair (nearest-legal search against repacking with a strong reference pull)
2. attachment rules as groups and relations
3. matching
4. region planning, compiled into per-region packs
5. packer upgrades (exact courtyard rectangles, several candidates per segment, backtracking)
6. orientation pass plus routability estimate
7. refinement

A feasibility check runs before all of them, and the electrical intent checkers C1 to C4 run alongside.

Two of the three threads that ranked stages by gain put the legalizer first. The layout-reuse thread listed stages in pipeline order, not by priority.

Every thread agrees on v0's shape:
- match parts deterministically before prompting;
- lock what copied cleanly;
- have the model place only new, changed or displaced parts;
- gate every answer with copperhead's own checker.

## 10. Utilisation of designer boards

Measured 2026-09-16 [checked]. Script and results: `manual-tests/runs/placer-research-2026-09-16/utilisation/`.

**Method:** per board side, the summed part extents (courtyard, else pad-copper bounding box) divided by the outline area minus cutouts. The boards are 27 from `bench/var/corpora/pcbench-upgraded` and 19 KiCad 10 demos.

| Set | n | Median | 75th percentile | 90th percentile | Max |
| --- | --- | --- | --- | --- | --- |
| Fuller side, all boards | 46 | 47 % | 54 % | 65 % | 100 % |
| Fuller side, boards with courtyards on at least 90 % of parts | 23 | 48 % | 54 % | 62 % | 93 % |
| Both sides summed, all boards | 46 | 50 % | 60 % | 71 % | 126 % |

**Examples:**
- ecc83-pp 51 %, ecc83-pp_v2 47 %;
- sonde xilinx 64 % (front 54 %, back 9 %);
- interf_u 48 %;
- StickHub 126 % (front 93 %, back 33 %) is the densest.

**Caveats:**
- Boards whose footprints lack courtyards are measured with pad boxes and underestimate demand (several PCBench boards have courtyards on under 10 % of parts).
- Tiny outlines (an NFC antenna) are meaningless and left in the counts.

The spec takes 0.62 as the warn threshold and 0.95 as the refusal threshold per side (§7.1).

## 11. Subsystem grouping

Measured 2026-09-16 [checked]. Scripts and results: `manual-tests/runs/placer-research-2026-09-16/subsystems/` (`sheet-cohesion.mts`, `net-clustering.mts`, `results.txt`, `clustering-results.txt`).

**Context:**
- KiCad boards record each footprint's hierarchical sheet as `(sheetname "...")` and `(sheetfile "...")`. Copperhead's importer does not read them [checked].
- `deriveBlocks` knows only SUBSYSTEMS.md headings and schematic intent groups, so on an imported board every part lands in `unassigned` [checked].
- tscircuit core packs nested groups as whole units (`Group_doInitialPcbLayoutPack.ts` handles child `pcb_group_id`s and "aggregate packed groups") [checked].

**Boards:** the 11 files among the KiCad demos and PCBench with at least two sheets of 3+ parts (10 designs; multichannel_mixer routed and unrouted). They range from 63 to 1,494 parts. No PCBench board has usable sheets; they are KiCad 4/5 files.

**Scores**, on the designer's placement:
- **Cohesion:** per part, mean distance to its own group ÷ mean distance to other groups, averaged; below 1 is compact. A finer partition scores lower by construction.
- **Purity:** the share of parts inside a group's bounding box that belong to it, averaged over groups of 3+ parts.
- **ARI:** adjusted Rand index against the sheets.

**Partitions compared:**
- **Louvain:** modularity clustering. Parts sharing a net of k parts are joined with weight 1/(k−1); ground and rail nets (more than max(12, 20 %) of parts) are dropped, and power nets weigh 0.25.
- **Nearest anchor:** each part joins the nearest IC with 8+ pads that is not a connector, over the same graph with edge length 1/weight.
- **Root split:** sheets, with the root sheet split by nearest anchor.
- **Hybrid:** sheets, with root sheets, sheets over 20 parts and sheets with 2+ anchors split by nearest anchor.

| Partition | Median ARI vs sheets | Median ARI, non-root parts | Median cohesion | Median purity |
| --- | --- | --- | --- | --- |
| Sheets | 1.00 | 1.00 | 0.55 | 0.78 |
| Nearest anchor | 0.24 | 0.55 | 0.55 | 0.74 |
| Louvain | 0.32 | 0.48 | 0.51 | 0.58 |
| Root split | 1.00 | 1.00 | 0.55 | 0.70 |
| Hybrid | 0.71 | not computed | 0.55 | 0.67 |

**Per board:**
- **Sheet cohesion** is below 1 on 10 of 11 boards. The exception is tinytapeout-demo at 1.17, whose root sheet holds 125 of 150 parts.
- **Nearest anchor recovers IC-organised sheets:**
  - complex_hierarchy: ARI 0.82, 1.00 on non-root parts;
  - multichannel_mixer: 0.86, 0.89 on non-root parts;
  - pic_programmer: 1.00 on non-root parts.

  It fails on tinytapeout-demo (0.03) and kit-dev-coldfire (0.20).
- **Root split** helps only tinytapeout-demo (cohesion 1.17 to 0.73). It lowers purity on kit-dev-coldfire (0.67 to 0.52) and One-Air-Max (0.61 to 0.43).

**Consequence for the spec (§7.5):**
- Intent first, then sheets kept whole, then nearest anchor for single-sheet boards and unassigned parts.
- Louvain stays an open alternative.
- A size split applies only to packing islands (§8.2).
- Everything is re-measured at this spec's scale in P0.

## 12. Engineering placement order: what copperhead already has

The owner's account (2026-09-16) of how a hardware engineer places a Bluetooth amplifier is design input, not a measurement. The spec restructures the plan around it:
- phases: mechanical, regions, main ICs, critical support, loops, separation, remaining;
- nine priorities, from mechanical correctness down to visual neatness;
- routing critical nets during placement.

Checked in the code on the same day:

- **Ranking** (`src/pcb/verify/scoring.ts`) [checked]. `rank()` applies gates, then sorts eligible candidates lexicographically by `completion_rate`, hard intent violations, soft intent violations, and a normalised weighted score, keeping Pareto membership. The placement profile `default-placement-2-layer` gates on courtyard overlap, outside-board and hard intent, and weights `routability_completion` 0.35, `hpwl_nm` 0.3, `congestion_overflow` 0.2, `routability_drc_errors` 0.1, `runtime_s` 0.05. There is no tier concept, so the spec adds `tiers` to `ScoringProfile`.
- **Routing a net subset** [checked]. `RouteOptions.netNames` routes named nets only. The staged routing plan (`src/pcb/engines/plan.ts`) sorts nets into power, critical and bulk, and routes power first, then critical, then bulk. `routabilityProbe` (`src/pcb/engines/probe.ts`) has no net option; the spec adds `netNames`.
- **Return paths** [checked]. `checkReturnPath` (`src/pcb/verify/checkers/returnpath.ts`) applies to two-layer boards. It reports pour contiguity (`quality.pour.fragments`), top signals crossing pour gaps (`quality.pour.crossing`, gating only for `sensitiveNetIds`) and stitching near connectors (`quality.stitching`).
- **Datasheet-derived rules** [checked]. The intent compiler (`src/pcb/agent/intent/compiler.ts`) has two model steps:
  - step 1 assigns roles from a fixed list: mcu, regulator, decoupling, bulk-cap, crystal, load-cap, connector, esd, led, pull-up, pull-down, sense, switch, inductor, diode, mounting, test-point, sensor, driver, transceiver, other;
  - step 3 proposes placement rules (attachments, groups, separation, keepouts) from BOM.md and cached datasheets (`cachedDatasheets`), with a cite and a confidence. Hard rules come back soft, and entries below confidence 0.5 become advisory.

  Nothing extracts datasheet rules without a model.
- **The amplifier project** `esp32-amp` (sibling of copperhead) [checked]:
  - Its two board files hold an outline and no footprints.
  - The workspace schematic (2026-09-06) has 140 electrical parts: ESP32-WROVER-E, TAS5805MPWP, AP63205WU, TPS7A4701, CP2102N, CYPD3177, two TPS259470 eFuses, USBLC6-2SC6, 5 inductors, 48 capacitors, 37 resistors, 8 test points, 7 push buttons, 6 TVS diodes and more.
  - `research/DATASHEET-FACTS.md` (verified 2026-09-04) quotes the ESP32 layout guideline: "a clearance of at least 15 mm is recommended in all directions" around the antenna.
  - `research/LOUDER-ARCHITECTURE.md` records TAS5805M decoupling at the PVDD pins, bootstrap capacitors per output, and GVDD and AVDD capacitors. The MAX98357A datasheet asks for wide, low-resistance output traces.
  - At 140 parts the design is above the spec's 50-part scope, so the spec extracts its amplifier and power-input subsystems as test boards.

## 13. Corrections found in verification

- **ecc83 parts.** "Same 15 parts" was wrong: 7 footprints changed.
- **PCBWorld.** Direct geometry writing completes 2 % of boards, not none. The 10 % parse-failure figure is for GPT-5.4-nano only.
- **OmniLayout few-shot.** The effect is unclear rather than a consistent gain.
- **ecc83 transforms.** The best transform leaves 6.5 mm mean displacement, not 7 mm. Only outline-based transforms are computable at run time, which changed the spec's v0 transfer design (§7.3).
- **Part identity.** Copperhead's `ComponentInstance.id` is the footprint UUID [checked, `src/pcb/ir/kicad/import.ts`], so symbol-path matching needs a new IR field (spec §6.3).
