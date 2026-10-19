#!/bin/bash
# Builds PPSSPP for the browser (WebAssembly + SDL3 + GLES/WebGL2), see Web/README.md.
#
# Two flavors are produced:
#   build-web/     pthread build - required for games; needs SharedArrayBuffer
#   build-web-st/  single-threaded fallback - menu/testing only, games may hang
#
# Requires the emsdk with a recent Emscripten (6.x tested) and cmake.
# Point EMSDK_DIR at your checkout if it is not in ~/emsdk.
set -e

cd "$(dirname "$0")/.."

EMSDK_DIR="${EMSDK_DIR:-$HOME/emsdk}"
if [ -f "$EMSDK_DIR/emsdk_env.sh" ]; then
	# shellcheck disable=SC1091
	source "$EMSDK_DIR/emsdk_env.sh" >/dev/null
fi
if ! command -v emcmake >/dev/null 2>&1; then
	echo "emcmake not found - install the emsdk (https://emscripten.org) or set EMSDK_DIR." >&2
	exit 1
fi

# The SDL3/SDL3_ttf ports must exist before configure so find_package() succeeds.
embuilder build sdl3 sdl3_ttf

# Common flags for both flavors.
COMMON_ARGS=(-DUSE_FFMPEG=OFF -DUSE_DISCORD=OFF -DUSE_MINIUPNPC=OFF -DUSE_SYSTEM_LIBPNG=OFF -DUNITTEST=OFF -DHEADLESS=OFF)

configure_and_build() {
	local dir="$1"
	shift
	mkdir -p "$dir"
	emcmake cmake -S . -B "$dir" -G Ninja -DCMAKE_BUILD_TYPE="${CONFIG:-Release}" "${COMMON_ARGS[@]}" "$@" >/dev/null
	cmake --build "$dir" -j"${JOBS:-$(nproc)}"
	echo "Built $dir"
}

# Only rebuild flavors that are missing or out of date - pass a flavor name to force.
WANT="${1:-both}"
if [ "$WANT" = "both" ] || [ "$WANT" = "mt" ]; then
	configure_and_build build-web -DWEB_PTHREADS=ON
fi
if [ "$WANT" = "both" ] || [ "$WANT" = "st" ]; then
	configure_and_build build-web-st -DWEB_PTHREADS=OFF
fi

echo
echo "Build complete: build-web/ppsspp.* (pthreads) and build-web-st/ppsspp.* (single-threaded)"
echo "Run the LAN server:  node Web/server.js"
