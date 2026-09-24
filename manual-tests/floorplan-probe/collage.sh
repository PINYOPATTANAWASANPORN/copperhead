#!/usr/bin/env bash
# Tile a set of rendered plates into one contact sheet with a heading.
#
# Usage: collage.sh <out.png> <title> <subtitle> <plate.png>...
#
# Kept as a script because the montage and annotate incantation is long and
# gets re-run on every change to the renderer.
set -euo pipefail
OUT="$1"; TITLE="$2"; SUB="$3"; shift 3
TMP="${OUT%.png}.tile.png"
COLS=3
[ "$#" -le 2 ] && COLS="$#"
montage "$@" -tile "${COLS}x" -geometry +16+16 -background '#11151c' "$TMP"
convert "$TMP" -background '#11151c' -gravity north -splice 0x210 \
  -font DejaVu-Serif-Bold -pointsize 86 -fill '#f2f5fa' -annotate +0+56 "$TITLE" \
  -font DejaVu-Sans-Mono-Bold -pointsize 44 -fill '#b9c3d2' -annotate +0+150 "$SUB" \
  "$OUT"
rm -f "$TMP"
identify -format "%f  %wx%h\n" "$OUT"
