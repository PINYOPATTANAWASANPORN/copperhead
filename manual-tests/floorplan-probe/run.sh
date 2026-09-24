#!/usr/bin/env bash
# Run the floorplan probe over a placement board and render the candidates.
#
# Usage: manual-tests/floorplan-probe/run.sh [board] [--size WxH] [--top N] [--sweep]
#
#   board     directory under manual-tests/placement-boards/ (default: esp32-amp)
#   --size    board outline in mm (default: 40x50)
#   --top     how many candidates to render (default: 6)
#   --sweep   run 40x40, 40x50, 50x50 and 68x64 and print the comparison
#   --share [W]  also write <name>-share.png at exactly W pixels wide (default
#             2048), rendered from the vector at that size rather than resized
#             from the 2x PNG, so nothing is resampled before a platform
#             re-encodes it
#
# Reads the committed board for its parts, nets and subsystems; writes only
# under manual-tests/runs/floorplan/ (gitignored). The board is never touched.
set -euo pipefail
cd "$(dirname "$0")/../.."

BOARD=esp32-amp
SIZE=40x50
TOP=6
SWEEP=0
SHARE=0
SHARE_W=2048
while [ $# -gt 0 ]; do
  case "$1" in
    --size) SIZE="$2"; shift 2 ;;
    --top) TOP="$2"; shift 2 ;;
    --sweep) SWEEP=1; shift ;;
    --share) SHARE=1; shift; case "${1:-}" in ''|-*) ;; *) SHARE_W="$1"; shift ;; esac ;;
    -*) echo "unknown flag $1" >&2; exit 1 ;;
    *) BOARD="$1"; shift ;;
  esac
done

SRC="manual-tests/placement-boards/$BOARD"
[ -d "$SRC" ] || { echo "no placement board at $SRC" >&2; exit 1; }

# PNGs: prefer a real browser. ImageMagick's built-in SVG renderer mangles text
# spacing and ignores clip paths, so it is only the fallback.
CHROME="$(command -v google-chrome || command -v chromium || true)"

# The SVG's own width/height, in CSS pixels. Chrome screenshots the window, not
# the document, so without these the plate comes back cropped.
svgsize() { sed -n 's/.*<svg[^>]*width="\([0-9.]*\)"[^>]*height="\([0-9.]*\)".*/\1 \2/p' "$1" | head -1; }

# Render <svg> to <png> at <scale>x the SVG's natural size.
#
# The scale goes to Chrome as the device pixel ratio, so the page is laid out at
# its CSS size and rasterised at scale x that. The result is a true vector
# render at the output resolution: no bitmap is ever resampled, so type and
# hairlines stay crisp at any scale. Downscaling a big PNG afterwards would
# soften both, which is the thing to avoid when a platform re-encodes the image.
render() { # render <svg> <png> <scale>
  local wh w h
  wh="$(svgsize "$1")"; w="${wh%% *}"; h="${wh##* }"
  [ -n "$w" ] || { w=1400; h=1500; }
  if [ -n "$CHROME" ]; then
    "$CHROME" --headless --disable-gpu --no-sandbox --hide-scrollbars \
      --default-background-color=00000000 --force-device-scale-factor="$3" \
      --screenshot="$2" --window-size="${w%.*},${h%.*}" "file://$PWD/$1" >/dev/null 2>&1 || true
  fi
  [ -f "$2" ] || convert -density $(awk -v s="$3" 'BEGIN{print 96*s}') "$1" "$2" 2>/dev/null || true
}

topng() { render "$1" "$2" 2; }

# A sharing copy at an exact pixel width, rendered from the vector rather than
# resized from the 2x PNG.
toshare() { # toshare <svg> <png> <target width px>
  local wh w scale
  wh="$(svgsize "$1")"; w="${wh%% *}"
  [ -n "$w" ] || return 0
  scale="$(awk -v t="$3" -v w="$w" 'BEGIN{printf "%.4f", t/w}')"
  render "$1" "$2" "$scale"
}

if [ "$SWEEP" = 1 ]; then
  for sz in 40x40 40x50 50x50 68x64; do
    echo "=== $sz ==="
    npx tsx manual-tests/floorplan-probe/floorplan.ts --board "$SRC" --size "$sz" --top 1 \
      --out "manual-tests/runs/floorplan/$BOARD-$sz"
    echo
  done
  exit 0
fi

OUT="manual-tests/runs/floorplan/$BOARD-$SIZE"
rm -rf "$OUT"
npx tsx manual-tests/floorplan-probe/floorplan.ts --board "$SRC" --size "$SIZE" --top "$TOP" --out "$OUT"
for f in "$OUT"/*.svg; do topng "$f" "${f%.svg}.png"; done
echo "  (PNG beside each, rendered with ${CHROME:-ImageMagick})"
if [ "$SHARE" = 1 ]; then
  echo
  echo "sharing copies at ${SHARE_W}px wide:"
  for f in "$OUT"/*.svg; do
    out="${f%.svg}-share.png"
    toshare "$f" "$out" "$SHARE_W"
    [ -f "$out" ] && echo "  $(basename "$out")  $(identify -format '%wx%h, %[size]' "$out" 2>/dev/null)"
  done
fi
