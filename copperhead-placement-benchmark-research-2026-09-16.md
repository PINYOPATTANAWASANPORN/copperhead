# Placement Benchmark Research, 2026-09-16

Research behind RFC 15, "The Copperhead PCB Placement Benchmark Standard". The draft is at `../wt-rfc14-placement/rfc/rfc15.md`, and its companion placer standard is RFC 14.

Three research threads started from the owner's proposal:
- benchmark methodology;
- routing as the evaluator, and engineering-intent metrics;
- datasets, contamination, statistics and stability.

The owner's proposal covered a validity cascade, intent metrics per circuit class, same-router routing with several seeds, six baselines, four task categories plus microboards, stability, a 35/25/15/10/5/5/5 composite, and a 40-board v1.

Status marks:
- **[checked]**: verified locally or against the primary source in this session.
- **[cited]**: from a research thread, not re-checked.
- **[unverified]**: the thread could not confirm it.

The scratch downloads (PDFs, extracted text, the Freerouting v2.4.1 clone) are in the session scratchpad under `research/bench-*`, which is temporary.

## 1. Methodology

### 1.1 Proxy metrics and scoring in contests

- **ISPD 2006** [cited]: HPWL × (1 + CPU factor + density penalty).
- **ISPD 2011** [cited]: total overflow from a fixed global router, plus a runtime factor; rank sum across circuits.
- **DAC 2012** [cited]: HPWL × routed-congestion factor × runtime factor. Earlier congestion metrics did not "accurately score" congestion.
- **ISPD 2014/2015** [cited]:
  - moved to detailed-routing evaluation because of miscorrelation between global and detailed routing;
  - scored against the contestant median;
  - invalid placements got the maximum score;
  - organisers legalised placements and penalised the displacement;
  - hidden designs.
- **MLCAD 2023** [cited]: a fixed failure penalty of 500 inside a mean, where one failure can swamp the result.
- **ICCAD 2026 FloorSet contest** [cited]: hard violation = 10, feasible cost capped below 10, so every feasible entry beats every infeasible one. That the hosting repository is the official one is [unverified].
- **Macro Placement Challenge 2026** [cited]: proxy cost to rank, the top 7 re-run through OpenROAD, overlap disqualifies, hidden designs.
- **Cheng, Kahng et al.** (ISPD 2023; arXiv 2302.11014 v3, 2026) [cited]:
  - over 30 low-proxy-cost placements, Kendall tau between proxy cost and post-route results is poor (area 0.058, routed wirelength 0.402, WNS 0.051);
  - a stronger annealing baseline beat Circuit Training.
- **ChiPBench** (arXiv 2407.15026; NeurIPS 2025 D&B) [cited]: intermediate metrics correlate weakly with final power, performance and area.
- **Lesson:** proxies lose rank correlation among good solutions, which is where rankings are decided.

### 1.2 PCB placement benchmarks

All [cited]:
- **Cypress** (ISPD 2025): wirelength, density, crossings, Freerouting 1.9 completion normalised to the human layout. The repository has only small cases (Apache-2.0).
- **OmniLayout:** 1,681 EAGLE layouts; overlap, out-of-board, HPWL, crossings, post-route metrics, similarity to reference; single runs.
- **PCBWorld:** clean pass = full connectivity plus zero DRC.
  - It headlines best-of-5, with @1 in the appendix.
  - It notes that selection hides differences between methods.
  - Unlicensed PCBench boards are research-only.
- **RL_PCB** (DATE 2024): averages over successful trials only; tolerates up to 10% overlap.
- **PCBAgent** (ASP-DAC 2025): averages over non-overlapping layouts only.
- **PCB-Bench** (ICLR 2026): text and multimodal Q&A; no geometric scoring.
- No public PCB placement leaderboard was found.

### 1.3 Aggregation and human review

All [cited]:
- **Zhang and Hardt** (ICML 2024): multi-task rankings are unstable; an irrelevant entrant can reorder the others.
- **Agarwal et al.** (NeurIPS 2021): intervals, IQM, stratified bootstrap, performance profiles.
- **"The Leaderboard Illusion"** (NeurIPS 2025): private variant testing biases leaderboards.
- **Design2Code** (NAACL 2025): automatic similarity metrics are only partial proxies for human preference.
- **Chatbot Arena** (ICML 2024) and **UI-Bench** (2025): Bradley–Terry with confidence intervals.
- No PCB study with blind expert review was found.

## 2. Routing as the evaluator

### 2.1 Freerouting v2.4.1

- **No seed option; the random generators are fixed** [checked, source clone]:
  - `BatchAutorouter.java:135` `new Random(0)`;
  - `MazeSearchEngine` creates `new Random()` but re-seeds with `setSeed(ctrl.ripupCosts)` ("Keep v1.9 deterministic randomization across passes");
  - `PlanarDelaunayTriangulation` and `PolygonShape` use fixed seeds.
- **Headless jobs are single-threaded** [checked]: `RoutingPipeline.createForHeadless` exists, and `docs/settings.md:149` says "Headless and API jobs always use the single-threaded" optimizer.
- **Remaining variance comes from wall-clock limits** [cited, inferred from source]: a per-connection limit growing per pass, fanout and optimizer deadlines, and the job timeout.
- **Version changes** [cited]: issue #872 shows a board routing 5/5 on 2.2.4 and 0/5 on 2.3.0 and 2.4.1.
- **PCBWorld variance** [cited]: Freerouting 2.1.0 over 4 runs, clean pass 0.80 ± 0.01 on D3-A.
- **Stopping rule** [cited]: from pass 8, every 4th pass restores a better board; it stops after 10 passes without a gain above 0.5 on a 0–1000 score.

### 2.2 Other routers

- **kicad-tools 0.20.0:** `route` has `--seed` and `--deterministic-budget` [checked: `kicad_tools/cli/parser.py` lines 3682 and 4181]. Sensitivity to `PYTHONHASHSEED` is [cited].
- **OrthoRoute:** hard-coded seed 42; inner layers only [cited]. GPU determinism [unverified].

### 2.3 Copperhead defects found

All three [checked]:
1. The profiles list `hole_near_hole` as a critical DRC type (`jlcpcb-2layer.json:31`, the 4- and 6-layer profiles, `index.ts:70`). KiCad 10's key is `hole_to_hole` (`drc_item.cpp` line 110 on the 10.0 branch), so the entry never matches.
2. `src/pcb/verify/checkers/kicad-drc.ts` counts critical violations from `report.violations` (error severity) only. Critical types that KiCad reports as warnings, such as `pth_inside_courtyard`, are never counted.
3. `src/pcb/engines/probe.ts` reports `routability_drc_errors` from `drc_error_count`, not `drc_critical_count`.

Also [cited]:
- The Freerouting adapter passes only `-de`, `-do` and `-mp`; `job.seed` has no effect.
- The kicad-tools manifest claims `seeded` without passing `--seed`.

### 2.4 Congestion and layer metrics

All [cited]:
- **RUDY** (DATE 2007) is a pre-route estimate. Copperhead's current proxy is bounding-box coverage per 2 mm cell, not RUDY.
- **Post-route congestion:** per-cell utilisation = routed length ÷ (cell side × ⌊side / (width + clearance)⌋), and channel overflow across cut lines.
- **Layer changes:** count via traversals per connection. Copperhead's `layer_transition_count` equals `via_count`.

## 3. Engineering-intent sources

Downloaded and read by the routing/intent thread [cited]; key quotes are in its report.

| Class | Sources | Numeric thresholds |
| --- | --- | --- |
| Decoupling | TPA3116D2 §10.1; TAS5805M §9.1.2 (reference-layout distances); UG483 v1.4 ch. 2 (2 in for 0805 bulk, backside caps when power planes are low) | device-specific only |
| Buck | TI SLYT614 (input capacitor the most important), SNVA021 (ceramic input capacitor as close as possible, loops curl the same way), SLYT682 (hot loop, 2 nH at > 5 A/ns) | none |
| Crystals | ST AN2867 §7; Microchip AN2648; Espressif (crystal ≥ 2.7 mm from the clock pin, no magnetic parts nearby) | device-specific only |
| RF | Espressif ESP32 layout guideline (antenna at or beyond the edge, no hollowed centre; 15 mm is housing clearance); u-blox NINA-B3 PIFA "insensitive to placement" | module datasheet keepouts |
| Class-D | TPA3116D2 §7.3.6 (220 nF bootstrap per output), §10.1 (tight output loop, filter close to outputs); TAS5805M §7.3.1 (BST–OUT caps, identical half-bridges) | none for filter–connector distance or symmetry |
| Protection | TI SLVA680 (TVS near the connector, protected IC much farther away, no stub; 0.25 nH ≈ 10 V at 8 kV); SLLA414A §4.14 | "much further" not quantified |
| Differential | SLLA414A §4.3 (symmetric, parallel, break-out within 0.25 in) | device-specific |

Unverified: ADI MT-101, the ADI hot-loop article, Nordic and u-blox keepout dimensions, TDA7492 layout guidance (reportedly no external bootstrap).

## 4. Datasets and licences

### 4.1 PCBench [checked]

The DRC sweep (`bench/corpora/pcbench-drc-sweep.json`, 177 boards) has 37 clean, permissively licensed boards; 19 of them are in the 20-board placement qualification suite (`bench/suites/placement-pcbench.json`). The held-out boards, by footprint count:

| Footprints | Licence | Board |
| --- | --- | --- |
| 3 | Apache-2.0 | rufs autosave (duplicate) |
| 4 | MIT | grove_adaptor |
| 5 | MIT | ir_sensor |
| 12 | Apache-2.0 | atmel-programmer |
| 15 | MIT | gas_sensor |
| 18 | MIT | 12V5A_breakout |
| 20 | MIT | power_supply |
| 22 | MIT | 4_switch_array |
| 27 | MIT | solenoid_driver |
| 33 | MIT | QRPCard |
| 36 | MIT | 8_switch_array |
| 40 | MIT | prog-cc-100mA |
| 51 | Unlicense | HellScribe |
| 66 | MIT | fan_controller |
| 76 | MIT | training_board_v02 |
| 89 | MIT | OpAmpPassXsistorBenchSupply |
| 123 | MIT | recalbox-gpio-board (two copies) |

- The 6 BeeHive boards share one upstream repository [cited].
- PCBench's `licenses` field is GitHub's repository-level detection [cited].
- RFC 14's E9 loop boards (12_24_boost_converter, hbridge_driver, piezo_amplifier) are in the qualification suite, so they are development cases.

### 4.2 Other sources

- **KiCad demos:** licences per demo [cited]. Demos with no licence file have unclear redistribution rights [unverified]. stickhub is CC-BY-NC-SA and must be excluded; cm5_minima is CERN-OHL-S, 6 layers.
- **OSHWHub:** EasyEDA designs; `kicad-cli pcb import` 10.0.4 has no EasyEDA format [cited], so excluded.
- **OmniLayout data:** the claimed CC-BY-4.0 conflicts with CC-BY-SA constituents (Arduino, SparkFun) [cited].
- **Owner's transfer examples** [cited]:
  - CM4 → CM5 is out of scope (6+ layers, 100+ parts).
  - TPA3116 (class-D) → TDA7297 (class-AB, no LC filter) crosses topologies; TDA7492 is the realistic target.
  - Actual boards for these pairs are [unverified].

### 4.3 Revision pairs and transfer candidates

From two follow-up threads that downloaded the boards and counted top-level footprints and copper layers [cited]. Counts include logos, fiducials and mounting holes unless marked electrical. Licences are as the threads report them, to confirm at admission.

**Revision pairs:**

| Pair | Licence | Footprints | Cu | Change |
| --- | --- | --- | --- | --- |
| KiCad ecc83-pp → ecc83-pp_v2 | reported CC-BY-SA-4.0 via `demos/LICENSE.README` in KiCad's source tree | 15 → 15 | 2 | 7 footprints changed, all parts re-placed, outline shrunk |
| Pico-DVI-Sock 23968d9 → e546724 | CC0 | 14 → 15 | 2 | 5 V header added (single change) |
| Pico-DVI-Sock 32e548a → 4879c85 | CC0 | 14 → 14 | 2 | outline corners rounded only |
| Olimex MOD-LCD2.8RTP rev B → C → D | Apache-2.0 | 38 → 42 → 44 | 2 | connectors replaced, touch IC added; then LCD FPC changed and moved, 15 footprints changed |
| Tomu v0.3 → current | CC-BY-SA-4.0 or TAPR | 16 → 17 | 2 | headers replaced, outline 13×11 → 13×9.4 mm |
| Olimex ESP32-DevKit-LiPo rev C → D | Apache-2.0 | 59 → 56 | 2 | CH340T → CH340X; buck → LDO |
| Olimex ESP32-DevKit-LiPo rev A1 → B | Apache-2.0 | 50 → 58 | 2 | 11 added, 3 removed, 23 footprints changed |
| tigard v1.0 → v1.1 | CC-BY-SA-4.0 | 92 → 92 | 2 | pure moves (about 1 mm) |
| OLIMEX iCE40-DAC rev A → A1 | Apache-2.0 | 51 → 51 | 2 | one value change, no moves (a no-op control) |
| Raspberry Pi CM5 IO rev 1 → 2 | unverified | 76 → 79 | 4 | U5 removed; R11, R13, TP2, TP4 added |
| Glasgow C1 → C2 | 0BSD or Apache-2.0 | 240 → 267 | 4 | ESD arrays and a crypto IC removed, SP3012 and resistor packs added, 162 parts moved |

**CM4/CM5 carriers:**
- Official CM4 IO: 151 footprints, 4 Cu; per a Raspberry Pi staff forum post it is open with no limitations.
- CM5 IO: 76–79 footprints, 4 Cu, licence unverified.
- CM5 MINIMA: 98–112 footprints, 4–6 Cu, CERN-OHL-S.
- The only 2-layer carriers found (PicoBerry, CM4_ROUTER) are CM4-only.
- The only extractable shared block is the PCIe/M.2 3.3 V buck (AP64501 → AP3441).

**Transfer candidates:**
- **Amplifier:**
  - zOnlyKroks/pcb-consortium TPA3116D2DADR: CC0, KiCad 10, 50 footprints, 2 Cu, routed.
  - devesh1995/SoundBox TDA7492: Unlicense, KiCad 7, 48 footprints, 2 Cu, routed, 4 inductors.
  - Same-author easier tier: TPA3110D2 (43) → TPA3116D2DADR (50).
  - Class-AB partial case: jabolos10/Bluetooth_Speaker_PCB TDA7297 (MIT, 66 footprints, needs extraction).
- **Buck:**
  - Boardoza TPS62130A 3V3 → Boardoza TPS563203 3V3: CC-BY-SA-4.0, KiCad 9, about 20 footprints each, 2 Cu.
  - The AP63203 port is a SparkFun CC-BY-SA derivative.
- **ESP32:**
  - Olimex ESP32-DevKit-LiPo rev D (Apache-2.0, KiCad 5, 56 footprints, 51 electrical) → Olimex ESP32-C3-DevKit-Lipo rev D (CERN-OHL-S-2.0 per README; the LICENSE file says GPL-3.0; 61 footprints, 50 electrical). Both 2 Cu.
  - Espressif DevKits publish PDF and DXF only, with no licence, so they were not used.

**KiCad demo licence:**
- The follow-up thread reports `demos/LICENSE.README` in KiCad's source tree stating CC BY-SA 4.0 for all demo files.
- Fetching that file failed from both the GitHub mirror and GitLab raw URLs (404) [unverified].
- The local Debian copyright file carries only KiCad's generic licence text.
- Six installed demos carry their own LICENSE files: cm5_minima, royalblue54L_feather, tiny_tapeout, jetson, stickhub, openair-max [checked].

## 5. Contamination

All [cited]:
- HumanEval overlap with The Pile and The Stack, with performance gaps by similarity (Riddell et al., ACL 2024).
- Rephrased samples defeat n-gram decontamination (Yang et al. 2023).
- Performance tracks GitHub presence only before the cutoff (Roberts et al., ICLR 2024); drops after cutoff (LiveCodeBench, LiveBench).
- SWE-Bench Illusion: file paths identified from issue text.
- SWE-Bench+: leaked solutions.
- GSM1k: drops on fresh look-alikes.
- BIG-bench canary GUID reproduced by GPT-4 base (community evidence).

## 6. Statistics

- **Wilson 95% intervals** [checked, computed]: 5/5 → [0.566, 1.0]; 4/5 → [0.376, 0.964]; 0/5 → [0, 0.434]; 35/40 → [0.739, 0.945]; 20/40 → [0.352, 0.648].
- **Minimum exact two-sided Wilcoxon p-value** [checked]: n = 5 → 0.0625; n = 10 → 0.00195.
- **Simulated power at α = 0.05** [cited]: 40 boards, d = 0.5 → 0.85; d = 0.3 → 0.44; 10 boards, d = 0.5 → 0.28.
- **References** [cited]: Henderson et al. 2018 (seed sets differ significantly), Colas et al. 2018, Bouthillier et al. 2021, Dodge et al. 2019 (expected best-of-n), Agarwal et al. 2021, Demšar 2006.

## 7. Stability

All [cited]:
- **Alpert, Nam, Villarrubia, Yildiz,** "Placement Stability Metrics", ASP-DAC 2005: SOM = 3·Σ aᵢ(|Δx|+|Δy|) / (A_t·(W+H)), where 1 ≈ random movement. Definitions checked in US 2005/0235237.
- **Roy and Markov,** ECO-system: average displacement 0.3% of half-perimeter; 2.7% of cells moved more than 1.5%.
- **ICCAD 2017 legalisation contest:** average and maximum displacement.
- **Misue et al. 1995 "mental map":** orthogonal order, proximity, topology.

## 8. What changed from the owner's proposal (RFC 15 Appendix A)

| Change | RFC 15 section |
| --- | --- |
| Validity is a sort key | §5.2 |
| No silent harness repair | §5.3 |
| Critical DRC keys matched across severities | §5.4 |
| Congestion measured after routing | §8.6, §11.6 |
| Fixed anchors (random-legal floor, re-routed human anchor), unclamped | §11.3 |
| Routing repeats in place of seeds, plus a deterministic cross-check router | §8.2, §8.5 |
| The median, not best-of-R, as primary | §8.3 |
| Reference preservation scored only where required | §11.6 |
| Leakage control at 80% partial | §10.2 |
| Contamination tiers, perturbation, memorisation probe, dev/test separation | §13 |
| Pre-registration, hierarchical bootstrap, paired tests, resolution statement | §12 |
| Stability after Alpert et al. | §12.6 |
| Independent annealing baseline, since tscircuit is algorithmically RFC 14's own packer | §9.1 |
| Human review as exploratory | §14 |
| CM4/CM5 excluded; TDA7297 relabelled a partial-transfer case | App. B |
