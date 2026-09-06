#!/usr/bin/env bash
# Fetch the PCBench corpus (MIT, github.com/PCBench/PCBench) at the pinned
# commit and upgrade the qualification suite's boards to the pinned KiCad
# format. Nothing is committed: everything lands under bench/var/ (git-ignored).
#
# Usage: bench/corpora/pcbench.sh [suite.json]   (default: bench/suites/pcbench-qual.json)
# See openspec/changes/add-pcb-layout-framework/adr/0003-corpora-and-licenses.md
# for why the suite is limited to permissively licensed, two-layer, DRC-clean boards.
set -euo pipefail
cd "$(dirname "$0")/../.."
COMMIT=dec3be7
SUITE="${1:-bench/suites/pcbench-qual.json}"
ROOT=bench/var/corpora
mkdir -p "$ROOT"
if [ ! -d "$ROOT/pcbench/.git" ]; then
  git clone -q --depth 1 https://github.com/PCBench/PCBench.git "$ROOT/pcbench"
fi
HAVE="$(git -C "$ROOT/pcbench" rev-parse --short HEAD)"
[ "$HAVE" = "$COMMIT" ] || { echo "pcbench clone is at $HAVE, expected $COMMIT; delete $ROOT/pcbench and rerun" >&2; exit 1; }
command -v kicad-cli >/dev/null || { echo "kicad-cli not found; boards cannot be upgraded" >&2; exit 1; }
OUT="$ROOT/pcbench-upgraded"
mkdir -p "$OUT"
node -e "const s=require('./$SUITE'); for (const b of s.boards) console.log(b.id)" | while read -r id; do
  src="$ROOT/pcbench/PCBs/$id/processed.kicad_pcb"
  dst="$OUT/$id.kicad_pcb"
  [ -f "$src" ] || { echo "missing $src" >&2; exit 1; }
  if [ ! -f "$dst" ]; then
    cp "$src" "$dst"
    kicad-cli pcb upgrade --force "$dst" >/dev/null
  fi
  echo "ready $dst"
done
