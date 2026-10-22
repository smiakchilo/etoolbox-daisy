#!/bin/bash
# EToolbox Daisy - build it yourself from source; nothing pre-built to trust.
#
# What this does, in order (read it, it is short):
#   1. Downloads portable Node.js from nodejs.org, checks its SHA-256 against the
#      value pinned below, and checks the node binary carries a valid code
#      signature from the OpenJS Foundation.
#   2. Downloads this repository's source as a zip from GitHub.
#   3. With that Node, installs the locked npm dependencies (install scripts
#      disabled), builds the application and writes "EToolbox Daisy.app" into
#      the folder this file is in.
#   4. Deletes the temporary work folder and starts the application.
#
# Afterwards the app runs on its own; this file is no longer needed. The app is
# built on this Mac; it is sealed with an ad-hoc signature, which Apple Silicon needs.
# Your settings and chats live elsewhere and are not touched; run this again in
# the same folder to update the application.
#
# Usage:  ./install.command          build the latest source of the default branch
#         ./install.command <ref>    build a branch, tag or commit instead
# Double-clicking works too (run "chmod +x install.command" once if it is refused).
# Behind a proxy, set HTTPS_PROXY first. Uses only tools that ship with macOS.
set -euo pipefail

# ---- Pinned inputs ----
NODE_VERSION="24.20.0"
NODE_SHA256_ARM64="40e5607e5ecb3db9192723776da2d75d966260fc74a7a9e731c1bd67dda96bc8"
NODE_SHA256_X64="9e5b2644cf107befb6aefca676b96d3296bc10138096f022ed378d6233ed81f4"
NODE_SIGNER="OpenJS Foundation"
REPO="smiakchilo/etoolbox-daisy"
REF="${1:-master}"

# The folder this file is in.
OUT_DIR="$(cd "$(dirname "$0")" && pwd)"

# A Rosetta-translated shell reports x86_64 on Apple Silicon; ask the hardware instead.
if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]; then
  NODE_ARCH="arm64"
  NODE_SHA256="$NODE_SHA256_ARM64"
else
  NODE_ARCH="x64"
  NODE_SHA256="$NODE_SHA256_X64"
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/etoolbox-daisy-build.XXXXXX")"
NODE_DIR="$WORK/node"
SRC_DIR="$WORK/src"
SOURCE_URL="${EDAISY_SOURCE_URL:-https://github.com/$REPO/archive/$REF.zip}"

KEEP_WORK=1
cleanup() {
  if [ "$KEEP_WORK" = "0" ]; then
    rm -rf "$WORK"
  else
    echo
    echo "Failed. The temporary files in \"$WORK\" are kept for inspection; delete that folder when done."
    echo "Nothing else was changed, except possibly files written to \"$OUT_DIR\"."
  fi
}
trap cleanup EXIT

# ---- 1. Portable Node.js ----
NODE_TGZ="node-v$NODE_VERSION-darwin-$NODE_ARCH.tar.gz"
echo "Downloading Node.js $NODE_VERSION ($NODE_ARCH) from nodejs.org ..."
curl -fL --retry 3 -o "$WORK/$NODE_TGZ" "https://nodejs.org/dist/v$NODE_VERSION/$NODE_TGZ"
GOT="$(shasum -a 256 "$WORK/$NODE_TGZ" | cut -d' ' -f1)"
if [ "$GOT" != "$NODE_SHA256" ]; then
  echo "The Node.js download does not match the pinned SHA-256."
  echo "  expected $NODE_SHA256"
  echo "  got      $GOT"
  exit 1
fi
tar -xzf "$WORK/$NODE_TGZ" -C "$WORK"
mv "$WORK/node-v$NODE_VERSION-darwin-$NODE_ARCH" "$NODE_DIR"
rm "$WORK/$NODE_TGZ"
codesign --verify --strict "$NODE_DIR/bin/node"
if ! codesign -dvv "$NODE_DIR/bin/node" 2>&1 | grep -q "^Authority=Developer ID Application: $NODE_SIGNER"; then
  echo "node is not signed by $NODE_SIGNER."
  exit 1
fi
echo "node signature: valid, $NODE_SIGNER"

# ---- 2. Source ----
echo "Downloading source from $SOURCE_URL ..."
mkdir "$WORK/unpack"
curl -fL --retry 3 -o "$WORK/source.zip" "$SOURCE_URL"
tar -xf "$WORK/source.zip" -C "$WORK/unpack"
mv "$WORK"/unpack/*/ "$SRC_DIR"
test -f "$SRC_DIR/scripts/app-build.mjs"

# ---- 3. Install, build, write the app next to this file (caches stay in the work folder) ----
export PATH="$NODE_DIR/bin:$PATH"
export npm_config_cache="$WORK/npm-cache"
export npm_config_update_notifier=false
export electron_config_cache="$WORK/electron-cache"
export ELECTRON_CACHE="$WORK/electron-cache"
export ELECTRON_BUILDER_CACHE="$WORK/builder-cache"
cd "$SRC_DIR"
"$NODE_DIR/bin/node" scripts/app-build.mjs --out "$OUT_DIR"

# ---- 4. Clean up and start ----
cd "$OUT_DIR"
KEEP_WORK=0
rm -rf "$WORK"
echo
echo "EToolbox Daisy is ready: $OUT_DIR/EToolbox Daisy.app"
open "$OUT_DIR/EToolbox Daisy.app"
