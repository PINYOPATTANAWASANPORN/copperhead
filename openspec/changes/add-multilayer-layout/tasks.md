## 1. Copper stack

- [ ] 1.1 `copperStack(design)` in `src/pcb/ir/layers.ts`: F.Cu, In1..InN.Cu, B.Cu from canonical names; `viaSpan(via, stack)`; unit tests on the legacy numbering, the KiCad 10 numbering, two-layer, six-layer, a renamed layer, and eight layers
- [ ] 1.2 Importer: `layerTable()` orders copper by the stack; via `layers` resolved through the stack; pre-flight `preflight.stack` for more than six copper layers or an unnameable copper layer; two-layer golden hashes unchanged (test)
- [ ] 1.3 Every copper-layer site reads the stack: `dsn.ts`, `ses.ts`, `orp.ts`, `svg.ts`, `connectivity.ts`, `geometry.ts`, `metrics.ts`, `returnpath.ts`, the kicad-tools and Freerouting adapters, `plan.ts`, `candidates.ts` (grep leaves no `kind === 'copper'` filter outside `layers.ts`)

## 2. Vias and connectivity

- [ ] 2.1 Connectivity unions a via with every layer in its span; four-layer test: F.Cu to In1.Cu through a via reads complete
- [ ] 2.2 Geometry `geom.via-layers`: ends must be the outer layers and stack members; `via-span` golden expectation
- [ ] 2.3 Runner: an engine result with a via whose ends are not the outer layers is `INVALID_OUTPUT` naming the net (test with a fake router)
- [ ] 2.4 SES and ORS importers map engine vias to the outer pair of the stack

## 3. Fabrication profiles

- [ ] 3.1 `jlcpcb-4layer` and `jlcpcb-6layer`: JSON beside the typed copy, values from kicad-tools `jlcpcb.yaml` (`4_layer`, `6_layer`) with provenance; equality test extended
- [ ] 3.2 `loadProfileFor(design, configured)`: configured profile must match the stack length (`preflight.profile` otherwise); default by count; `verifyDesign`, `routeBoard`, `placeBoard`, `layoutBoard`, `check` use it; evidence names the profile
- [ ] 3.3 Configuration and docs: `pcb.profile` accepts the two new ids; reference table rows

## 4. Engines and plan

- [ ] 4.1 kicad-tools adapter: `--layers` from the stack length (2, 4, 6); provenance test
- [ ] 4.2 `defaultStagedPlan`: default inner-layer directions on four and six layers, intent `routing.layers` overrides; DSN `layer_rule` test
- [ ] 4.3 Manifests: `router-reference` `maxLayers: 2`; registry test for both bounds on a six-layer board (reference ineligible, OrthoRoute eligible)
- [ ] 4.4 Live: Freerouting routes the `four-layer` golden and the verifier reads it complete (COPPERHEAD_TEST_FREEROUTING=1)

## 5. Scoring and metrics

- [ ] 5.1 `default-low-speed-4-layer` and `-6-layer` scoring profiles (two-layer weights without the bottom-layer terms, renormalised); selection by stack length unless `--scoring` names one
- [ ] 5.2 `returnpath.ts` emits its metrics on two-layer boards only; metrics test on a four-layer board

## 6. Renderer

- [ ] 6.1 `svg.ts` draws the stack back to front with per-layer colours and a legend entry per layer carrying copper; test that a four-layer candidate's `In1.Cu` copper appears
- [ ] 6.2 The B4 collage tooling (`render-fit.sh`) needs nothing; regenerate the four-layer scratch renders to confirm inner copper is visible

## 7. Golden corpus and bench

- [ ] 7.1 `generate.ts`: `layers: 2 | 4 | 6` per case, KiCad 10 numbering for four and six, `.kicad_pro` profile name; existing two-layer cases byte-identical
- [ ] 7.2 Cases `four-layer`, `six-layer`, `via-span` with `expected.json` (status, diagnostics, DRC from kicad-cli)
- [ ] 7.3 `bench/suites/multilayer-microboards.json` (track B, both wrapped routers, OrthoRoute added at four and six layers); `bench-runner` test covers a multilayer case
- [ ] 7.4 `bench/corpora/pcbench.sh` and `bench/suites/pcbench-4layer.json`: the permissive four-layer boards that upgrade and pass KiCad 10 DRC, listed from a sweep committed like ADR 0003's
- [ ] 7.5 Run `multilayer-microboards` and `pcbench-4layer`; record the numbers and every harness defect they expose in `bench/reports/M1-<date>.md`; two-layer suites rerun once to show unchanged numbers

## 8. Docs and close-out

- [ ] 8.1 `docs/.../concepts/layout-framework.md` (layers section), configuration and CLI references, README engines table (OrthoRoute eligible at four layers)
- [ ] 8.2 ADR 0011: multilayer decisions (stack from names, through vias only, profiles per count, scoring without return-path terms) with the M1 evidence
- [ ] 8.3 Exit: every two-layer golden expectation and B1 to B4 number reproduces; `four-layer` and `six-layer` route and verify complete with at least one wrapped router; `via-span` is refused
