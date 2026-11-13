#!/usr/bin/env bash
# One command: build both sides, make the thumbnails if they are not there yet, run the native
# grid and then the WebKitGTK one through the same scroll script, and print the comparison.
#
#   bash prototypes/native-grid/run.sh                    the full run, about two and a half minutes
#   bash prototypes/native-grid/run.sh --photos ~/Pictures   with thumbnails made from your own JPEGs
#   bash prototypes/native-grid/run.sh --n 20000 --tile 150 --lat-min 5 --lat-max 40 --parallel 6
#   bash prototypes/native-grid/run.sh --web-grids app,canvas   only some of the WebKit grids
#
# The WebKit side runs once per grid in --web-grids (default app,pool,canvas: the app's own
# components, reused DOM tiles, one canvas), then the native side once.
# Every option goes to both sides unchanged (see README.md). Do not touch the windows while
# they scroll, and leave them visible: a covered or minimised window is not drawn.
set -euo pipefail
# --web-grids is this script's; every other option goes to both sides.
GRIDS=app,pool,canvas
PASS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --web-grids) GRIDS="${2:?--web-grids needs a list, e.g. app,pool,canvas}"; shift 2 ;;
    --web-grids=*) GRIDS="${1#*=}"; shift ;;
    *) PASS+=("$1"); shift ;;
  esac
done
set -- ${PASS[@]+"${PASS[@]}"}
IFS=, read -r -a GRID_LIST <<< "$GRIDS"
for g in "${GRID_LIST[@]}"; do
  case "$g" in app|pool|canvas) ;; *) printf 'run.sh: unknown grid %s (app, pool or canvas)\n' "$g" >&2; exit 2 ;; esac
done
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
APP="$HERE/../../app"
say() { printf '\n== %s\n' "$*"; }
die() { printf '\nrun.sh: %s\n' "$*" >&2; exit 1; }

# ---- what it needs -----------------------------------------------------------------------
missing=()
command -v cargo >/dev/null || missing+=("cargo (Rust): sudo pacman -S --needed rustup && rustup default stable")
command -v node >/dev/null && command -v npm >/dev/null || missing+=("node and npm: sudo pacman -S --needed nodejs npm")
command -v pkg-config >/dev/null || missing+=("pkg-config: sudo pacman -S --needed pkgconf base-devel")
if command -v pkg-config >/dev/null; then
  pkg-config --atleast-version=4.12 gtk4 2>/dev/null || missing+=("GTK 4.12 or newer with headers: sudo pacman -S --needed gtk4   (found: $(pkg-config --modversion gtk4 2>/dev/null || echo none))")
  pkg-config --exists webkit2gtk-4.1 2>/dev/null || missing+=("WebKitGTK for GTK 3, API 4.1 (what the app uses): sudo pacman -S --needed webkit2gtk-4.1")
  pkg-config --exists gtk+-3.0 2>/dev/null || missing+=("GTK 3 with headers: sudo pacman -S --needed gtk3")
fi
if [ ${#missing[@]} -gt 0 ]; then
  printf '\nrun.sh: this needs a few things that are not installed:\n' >&2
  printf '  - %s\n' "${missing[@]}" >&2
  printf '\nOn Manjaro, all at once:\n  sudo pacman -S --needed base-devel pkgconf gtk4 gtk3 webkit2gtk-4.1 nodejs npm\n' >&2
  printf '(Debian/Ubuntu: sudo apt install build-essential pkg-config libgtk-4-dev libgtk-3-dev libwebkit2gtk-4.1-dev nodejs npm)\n' >&2
  exit 1
fi
[ -n "${WAYLAND_DISPLAY:-}${DISPLAY:-}" ] || die "no display: run this from a terminal inside your desktop session (Wayland or X11)."

# ---- build -------------------------------------------------------------------------------
say "building the two binaries (cargo --release; the first time takes a few minutes)"
(cd "$HERE" && cargo build --release)
BIN="${CARGO_TARGET_DIR:-$HERE/target}/release"

say "building the page with the app's own grid"
# The page is built from app/src with the app's own packages.
NM="${NG_NODE_MODULES:-$APP/node_modules}"
if [ ! -d "$NM/vite" ]; then
  echo "app/node_modules is not there; installing the app's packages (npm ci in app/)"
  (cd "$APP" && npm ci)
fi
ln -sfn "$NM" "$HERE/web/node_modules"
(cd "$HERE/web" && npx vite build --logLevel warn)

# ---- run ---------------------------------------------------------------------------------
OUT="$HERE/results/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT"
"$BIN/ng-native" --gen-only "$@"

# The page goes first: where its tiles end up depends on the engine's scroll bar and the
# window's frame, so the native side is then given the same width and height to lay out in.
SAME=()
WEB=()
STEPS=$(( ${#GRID_LIST[@]} + 1 ))
STEP=0
if [ "${NG_ONLY:-webkit}" = webkit ]; then
  for g in "${GRID_LIST[@]}"; do
    STEP=$((STEP + 1))
    say "$STEP of $STEPS: the '$g' grid in WebKitGTK. A window opens and scrolls by itself for about a minute."
    "$BIN/ng-webkit" --dist "$HERE/web/dist" --out "$OUT/webkit-$g.json" --web-grid "$g" "$@" 2> >(tee "$OUT/webkit-$g.log" >&2) || die "the WebKitGTK side ($g) failed; see $OUT/webkit-$g.log"
    WEB+=("$OUT/webkit-$g.json")
    if [ ${#SAME[@]} -eq 0 ]; then
      num() { tr -d '\n ' < "$OUT/webkit-$g.json" | sed -n "s/.*$1\([0-9][0-9]*\).*/\1/p"; }
      gw=$(num '"grid_width":'); vw=$(num '"view":\['); vh=$(num '"view":\[[0-9]*,')
      [ -n "$gw" ] && SAME+=(--grid-width "$gw")
      [ -n "$vw" ] && [ -n "$vh" ] && SAME+=(--view-width "$vw" --view-height "$vh")
    fi
    sleep 2
  done
fi
if [ "${NG_ONLY:-native}" = native ]; then
  STEP=$((STEP + 1))
  say "$STEP of $STEPS: the native GTK4 grid. Another window, the same script."
  "$BIN/ng-native" --out "$OUT/native.json" "$@" ${SAME[@]+"${SAME[@]}"} 2> >(tee "$OUT/native.log" >&2) || die "the native side failed; see $OUT/native.log"
fi
[ -f "$OUT/native.json" ] && [ ${#WEB[@]} -gt 0 ] || { echo "one side only; results in $OUT"; exit 0; }

# ---- report ------------------------------------------------------------------------------
REPORT="$OUT/native-grid-comparison.txt"
{
  "$BIN/ng-compare" "$OUT/native.json" "${WEB[@]}"
  printf '\n---- raw: native.json ----\n'; cat "$OUT/native.json"
  for f in "${WEB[@]}"; do printf '\n---- raw: %s ----\n' "$(basename "$f")"; cat "$f"; echo; done
} > "$REPORT"
echo
"$BIN/ng-compare" "$OUT/native.json" "${WEB[@]}"
say "written to $REPORT  (this one file is all there is to send)"
