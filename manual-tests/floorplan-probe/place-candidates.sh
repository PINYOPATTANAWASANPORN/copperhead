#!/usr/bin/env bash
# Place the board once per floorplan candidate and render each result coloured
# by subsystem.
#
#   1. floorplan the board and emit one intent file per candidate
#   2. for each: a fresh copy of the project, re-outlined, with that intent
#   3. `pcb place` into it
#   4. render the result with parts coloured by subsystem, over the regions the
#      floorplan gave them
#
# Usage: manual-tests/floorplan-probe/place-candidates.sh [board] [--size WxH] [--top N] [--budget S]
#
# Writes only under manual-tests/runs/floorplan-place/ (gitignored). The
# committed project is never touched.
set -euo pipefail
cd "$(dirname "$0")/../.."

BOARD=esp32-amp
SIZE=40x50
TOP=6
BUDGET=300
while [ $# -gt 0 ]; do
  case "$1" in
    --size) SIZE="$2"; shift 2 ;;
    --top) TOP="$2"; shift 2 ;;
    --budget) BUDGET="$2"; shift 2 ;;
    -*) echo "unknown flag $1" >&2; exit 1 ;;
    *) BOARD="$1"; shift ;;
  esac
done

SRC="manual-tests/placement-boards/$BOARD"
BASE="manual-tests/runs/floorplan-place/$BOARD"
FP="$BASE/floorplan"
[ -d "$SRC" ] || { echo "no placement board at $SRC" >&2; exit 1; }

W="${SIZE%x*}"; H="${SIZE#*x}"

KT_PY="$PWD/vendor/tools/kt-venv/bin/python"
[ -x "$KT_PY" ] && export COPPERHEAD_PYTHON="${COPPERHEAD_PYTHON:-$KT_PY}"

rm -rf "$BASE"; mkdir -p "$FP"
echo "== floorplan: $SIZE, top $TOP =="
npx tsx manual-tests/floorplan-probe/floorplan.ts --board "$SRC" --size "$SIZE" --top "$TOP" --out "$FP" --emit-intent

CHROME="$(command -v google-chrome || command -v chromium || true)"
topng() { # topng <svg> <png>
  local wh w h
  wh="$(sed -n 's/.*<svg[^>]*width="\([0-9.]*\)"[^>]*height="\([0-9.]*\)".*/\1 \2/p' "$1" | head -1)"
  w="${wh%% *}"; h="${wh##* }"; [ -n "$w" ] || { w=1400; h=1500; }
  [ -n "$CHROME" ] && "$CHROME" --headless --disable-gpu --no-sandbox --hide-scrollbars \
    --default-background-color=00000000 --force-device-scale-factor=2 \
    --screenshot="$2" --window-size="${w%.*},${h%.*}" "file://$PWD/$1" >/dev/null 2>&1 || true
  [ -f "$2" ] || convert -density 180 "$1" "$2" 2>/dev/null || true
}

FIG=1
for f in "$FP"/intent-*.yaml; do
  L="$(basename "$f" .yaml)"; L="${L#intent-}"
  RUN="$BASE/$L"
  echo
  echo "== candidate ($L) =="
  cp -r "$SRC" "$RUN"
  rm -f "$RUN/layout-intent.yaml"
  cp "$f" "$RUN/intent.yaml"
  PCB="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$RUN/.copperhead/config.json','utf8')).board)")"

  # re-outline: the committed board is 68 x 64, the floorplan targets $SIZE.
  # The outline is a single gr_rect, so this is a one-line rewrite.
  node -e '
    const fs=require("fs"), [p,w,h]=process.argv.slice(1);
    const t=fs.readFileSync(p,"utf8");
    const m=/\(gr_rect \(start ([\d.-]+) ([\d.-]+)\) \(end ([\d.-]+) ([\d.-]+)\)/.exec(t);
    if(!m) throw new Error("no gr_rect outline in "+p);
    const x0=+m[1], y0=+m[2];
    const out=t.replace(m[0], `(gr_rect (start ${x0} ${y0}) (end ${x0+ +w} ${y0+ +h})`);
    fs.writeFileSync(p,out);
    console.log(`  outline ${w} x ${h} mm at (${x0}, ${y0})`);
  ' "$RUN/$PCB" "$W" "$H"

  npx tsx src/cli.ts --repo "$RUN" pcb place --mode race --blocks --seed 0 \
    --budget-seconds "$BUDGET" --run-dir .copperhead/runs/place --apply 2>&1 \
    | tee "$RUN/place.log" | sed -E 's/((geom|drc|intent)\.[a-z_.-]+; ){3,}/(repeated diagnostics elided) /g' \
    | grep -E '^(PASS|PARTIAL|FAIL|REFUSE|HOLD)|applied|attach:|stage 1|staged plan' || true

  # Render whatever the run produced: the applied board if a candidate passed,
  # else the best-ranked candidate, so a failed run is still visible.
  SHOW="$RUN/$PCB"
  if ! grep -q "^  applied " "$RUN/place.log"; then
    BEST="$(node -e '
      const fs=require("fs"),p=process.argv[1];
      try{const r=JSON.parse(fs.readFileSync(p,"utf8"));
        const c=[...r.candidates].sort((a,b)=>a.rank-b.rank)[0];
        process.stdout.write(c?c.id:"");}catch{process.stdout.write("");}
    ' "$RUN/.copperhead/runs/place/ranking.json")"
    for d in "$RUN/.copperhead/runs/place/candidates/$BEST"*/; do
      [ -f "$d/candidate.kicad_pcb" ] && SHOW="$d/candidate.kicad_pcb" && break
    done
    echo "  (nothing applied; rendering best-ranked candidate $BEST)"
  fi

  FIG=$((FIG+1))
  npx tsx manual-tests/floorplan-probe/render-placed.ts \
    --board "$SHOW" --intent "$f" --out "$BASE/placed-$L.svg" \
    --figure "$FIG" --caption "Placement from floorplan ($L), $BOARD, $W x $H mm."
  topng "$BASE/placed-$L.svg" "$BASE/placed-$L.png"
done

echo
echo "floorplan: $FP/collage.png"
echo "placed:    $BASE/placed-*.png"
