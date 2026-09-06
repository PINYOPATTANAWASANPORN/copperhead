# Golden microboards

Ten small KiCad 10 boards, each carrying exactly one seeded layout fault, with an `expected.json` naming the diagnostic the layout harness must raise for it and what KiCad's own DRC reports (RFC 11 §13.2 and §14 milestone B0; ADR 0003). They are the layout half of the broken-fixture zoo asked for in #14.

| Case | Seeded fault | Harness diagnostic | KiCad DRC sees |
| --- | --- | --- | --- |
| `overlap` | C1's courtyard overlaps U1's | `geom.courtyard-overlap` | `courtyards_overlap` |
| `outside-board` | R1 wholly outside the outline | `geom.outside-board` | nothing (no rule fires for a footprint entirely outside) |
| `fixed-connector` | J1 constrained to the west edge, placed mid-board (`intent.yaml`) | `intent.mechanical.edge` | nothing |
| `decoupling-far` | C1 attached to U1 pins 8/4 within 2 mm, placed 20 mm away (`intent.yaml`) | `intent.relative.attached` | nothing |
| `keepout` | R2 inside the keepout ring around H1 | `intent.manufacturing.keepout` | `items_not_allowed` |
| `open` | SIG1 track stops short of R1.1 | `conn.open` | unconnected item, `track_dangling` warning |
| `short` | VCC track lands on a GND pad | `conn.short` | `shorting_items` (plus `solder_mask_bridge`, a consequence) |
| `clearance` | two tracks 0.05 mm apart under a 0.2 mm rule | `drc.clearance` | `clearance` |
| `completion` | legal placement, nothing routed | `conn.unrouted` × 14 | 14 unconnected items |
| `congestion` | 36-pin header fanning 16 nets into a QFN through one channel | `quality.congestion` (metric) | 21 unconnected items |

Four of the ten are invisible to DRC. That is the point of the set: a harness that only wraps KiCad DRC cannot pass B0.

`expected.json` fields: `status` (the terminal status the run must end in), `diagnostics` (codes and entity references the harness must emit), `drc.errorTypes` (KiCad error types that must appear), `drc.consequential` (types that may appear because they follow from the fault), `drc.unconnected` (KiCad's unconnected-item count), `metricsWithin` (metric ranges, from Phase 2).

## Regenerating

`npx tsx bench/golden/generate.ts` rebuilds every board from the installed KiCad footprint libraries (`footprintSearchDirs()`); the recipe for each case is in that file. The generated boards are committed so tests never depend on the libraries being installed. `test/bench-golden.test.ts` runs KiCad DRC on each board (skipped without `kicad-cli`) and holds the `drc` block to what KiCad reports.

Footprints come from the KiCad footprint libraries, CC-BY-SA-4.0 with the KiCad library exception, which permits their use in a board without the share-alike obligation.
