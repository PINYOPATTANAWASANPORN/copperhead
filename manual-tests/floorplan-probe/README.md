# floorplan-probe

An experiment: place one area-sized bounding box per subsystem on the board
**before** any individual part is placed, and look at the result.

Not a shipped stage, not behind an OpenSpec change, and nothing under `src/` is
touched. It reads a committed placement board for its parts, nets and subsystem
partition and writes only under `manual-tests/runs/floorplan/` (gitignored).

```bash
manual-tests/floorplan-probe/run.sh                      # esp32-amp at 40x50 mm
manual-tests/floorplan-probe/run.sh --size 40x40 --top 3
manual-tests/floorplan-probe/run.sh --sweep              # compare four outlines
```

The console report is laid out as a short paper: a header, then numbered
tables with their captions. Figures go to `manual-tests/runs/floorplan/<board>-<size>/`:

| file | what it is |
| --- | --- |
| `collage.svg` / `.png` | Figure 1: every ranked candidate as a lettered panel on one plate, for comparing shapes at a glance |
| `floorplan-01..NN.svg` / `.png` | Figures 2…N+1: one candidate each, with per-block areas, utilisation and member lists |

The plate carries everything needed to read it unaccompanied: a header with the
outline, part and subsystem counts, occupancy, utilisation and the search
result; a legend tying each tint to its subsystem; and the cost function with
its actual weights and a gloss of each term.

Plates are set in Latin Modern, the Computer Modern revival TeX ships, so they
sit beside a LaTeX document without a typeface clash. On a dark ground, all
runs bold so they survive being scaled down and recompressed for sharing, with
the numbered caption centred beneath the figure. Tint fills sit near 22 %
lightness against an 8 % ground with ~70 % keylines; the first pass used 12 %
fills, which collapsed into five shades of near-black once the PNG was scaled.

PNGs are rendered through headless Chrome when it is on `PATH` (ImageMagick's
built-in SVG renderer honours neither clip paths nor font stacks, and without
Latin Modern installed an SVG falls back to the system serif and loses the
look); the window is sized from the SVG's own `width`/`height` or the plate
comes back cropped.

## Why

`assignRegions` in [`src/pcb/intent/blocks.ts`](../../src/pcb/intent/blocks.ts)
already gives every block a region, but it is a placeholder: equal-width
vertical slots across the outline, one per block, **sized by block count rather
than by what the block holds**. On esp32-amp that hands `mcu` (602 mm² of
parts) and `amplifier` (31 mm²) the same box. Nothing enforces containment
either: `intent.functional.group.region` is a warning with `gate: 'none'`.

The method here follows
[`copperhead-llm-placement-engine-spec-v0.2.md` §10.4](../../copperhead-llm-placement-engine-spec-v0.2.md)
("Stage 4: region planning"), which `add-reuse-placer` explicitly defers.

## Model

Each block gets a **body box** its members must pack inside, plus any
**keep-out boxes** its footprints declare, which may cross the outline.

A slicing floorplan cuts the board in proportion to each block's demand;
every binary tree over every block permutation with both cut orientations is
enumerated (26,880 at five blocks) and scored:

| term | what it measures |
| --- | --- |
| `adjacency` | Σ net weight between two blocks × distance between their centroids, over the board diagonal |
| `flow` | declared subsystem order not advancing along the board's long axis |
| `aspect` | a region shaped like a sliver, past 3:1 |
| `edge` | a block with a connector or an off-board keep-out that reaches no edge |
| `keep-out` | a keep-out band spilling sideways into a neighbouring block |

A candidate is rejected outright when a block carrying an off-board keep-out
reaches no edge, when a member does not fit the region left after its own
block's keep-out band, or when the block's parts exceed that region's area.
At the four outlines below none of those three binds beyond the plain
member-fit test (the band is only 6 mm deep and `mcu` lands on an edge in
every feasible slicing floorplan), but they do bind on a smaller board (at
26 × 26 mm the probe reports 0 feasible layouts, 26,304 of them rejected on
`power-input`).

## What the probe found

**1. The IR's courtyard is unusable as an area measure for this part.**
`importBoard` collapses disjoint courtyard pieces into their common bounding
box ([`import.ts:420`](../../src/pcb/ir/kicad/import.ts)), which fuses
ESP32-S3-WROOM-1's 19.5 × 20.2 mm body ring with its 48 × 21 mm antenna
clearance into a single **48 × 41.2 mm** rectangle: 4.3× the area the module
occupies, and wider than a 40 mm board. Charged that way, U1 alone does not fit
any board we would want to build, and every candidate is rejected.

The Fab body is not a substitute: a 0402's Fab outline is the ceramic, not the
pads, so the passives come out ~30× too small (the whole design measured
706 mm² that way, against 930 mm² measured properly).

The two are not disjoint pieces to separate, either. The WROOM draws **one
connected courtyard** whose antenna box shares endpoints with the body ring, so
piece-splitting finds a single loop. The probe subtracts the declared keep-out
from the courtyard polygon and unions the remainder with the Fab body.

**2. The keep-out zone never reaches the IR at all.** `readZone` runs over
board-level `zone` blocks only, so a keep-out declared *inside* a `footprint`
block, as this one is, never lands in `design.board.keepouts`, which comes
back empty on this board. The probe parses it off the raw s-expression.

**3. The antenna costs the board a 26 × 6 mm no-copper strip, not 48 × 21 mm.**
Mount the module flush to an edge and most of the clearance zone is over air.
What stays on-board is the slice overlapping the module's own extent: the
module PCB runs 6 mm past its courtyard ring, and no copper may sit under it.

**4. 40 × 50 mm is the best of the four outlines tried**, and 40 × 40 works.

| outline | utilisation | feasible layouts | best cost |
| --- | --- | --- | --- |
| 40 × 40 | 0.581 | 160 | 1.371 |
| **40 × 50** | **0.465** | **420** | **1.312** |
| 50 × 50 | 0.372 | 680 | 1.371 |
| 68 × 64 (today's board) | 0.214 | 1168 | 1.356 |

40 × 50 wins because its aspect lets `mcu` take a full-height 26 mm strip with
the antenna at a short edge while the flow runs down the long axis. Note
0.465 lands almost exactly on the spec's 0.48 area-budget target; the board
size and the budget agree without either being tuned to the other.

## What it does not yet do, and what is wrong with the result

- **No connector-edge term.** The best candidate puts J1 (USB-C) and J2
  (speaker terminal) on the same side of the board. The §10.4 cost function has
  no term separating connectors onto the edges they belong on, the same class
  of bug ADR 0013 fixed for detailed placement, reappearing one level up.
  `layout-intent.yaml` states the requirement (J1 west, J2 east, J3 south) and
  the probe ignores it.
- **Mirror images score identically.** Candidates 1 and 2 are always
  reflections of each other; no symmetry reduction.
- **Rotation is not modelled.** Members are tested against a region in both
  90° orientations, but the floorplan never rotates a block as a unit.
- **Regions are not written anywhere.** Nothing is exported to
  `layout.functional.group.<slug>` and no detailed placement is run inside the
  boxes, so none of this is verified against ERC/DRC.
- **Board outline is hypothetical.** The probe floorplans onto a `--size`
  rectangle; the committed board is still 68 × 64 mm.
