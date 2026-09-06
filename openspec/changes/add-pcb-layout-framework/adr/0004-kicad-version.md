# ADR 0004: Pin KiCad 10

**Status:** Accepted (2026-09-06)
**RFC:** 11 §6.4, Appendix C.2 item 4

## Evidence

KiCad 10.0.4 is installed on the reference machine and in CI (`ppa:kicad/kicad-10.0-releases`). Its `kicad-cli pcb drc` offers `--refill-zones`, `--save-board`, `--schematic-parity`, `--all-track-errors`, and per-severity filters, and `kicad-cli pcb upgrade --force` rewrites boards from KiCad 3 through 9 in place (ADR 0003: 177 of 181 legacy boards). The read-only reader already handles board files from `20240108` (KiCad 8). pyplacer targets KiCad 9's `20241229` format and parsed a KiCad 10 board unchanged in the live run.

## Decision

Pin major 10. Import accepts `(version …)` from `20240108` through the value KiCad 10.0.4 writes; older files are upgraded with `kicad-cli pcb upgrade --force` on a copy before import; a newer major returns `UNSUPPORTED`. `doctor` reports a version mismatch through the existing `kicadCheck`. The adapter's tests run on 10.0.x only.

## Consequences

KiCad 9 users are supported for reading, not guaranteed for writing; exported boards carry the version the project declares, so a 9-era project stays loadable in 9 as long as no 10-only construct is emitted (none are in v1).
