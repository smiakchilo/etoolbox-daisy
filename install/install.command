#!/bin/bash
# EToolbox Daisy - build it yourself from source; nothing pre-built to trust.
#
# What this does, in order (read it, it is short):
#   1. Node.js. When this Mac already has 22.12 or newer on PATH, with npm beside
#      the binary, that one is used. Only when there is none does it download
#      portable Node.js from nodejs.org, check its SHA-256 against the value
#      pinned below, and check the node binary carries a valid code signature
#      from the OpenJS Foundation.
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
#         ./install.command --update <ref-or-zip-url> <app-folder> <app-pid> <status-file>
#                                    what the application runs to update itself
# Double-clicking works too (run "chmod +x install.command" once if it is refused).
# Behind a proxy, set HTTPS_PROXY first. Uses only tools that ship with macOS.
# Set EDAISY_NODE=pinned to ignore an installed Node.js and always use the
# verified download - that is the toolchain the build is tested with.
#
# --update is the same build, run by the application with no window of its own:
#   - the new app is built into a staging folder beside the running one, which
#     keeps working; progress goes to <status-file> as "stage|text" lines;
#   - the staged app is started once with --smoke-test and must exit 0;
#   - once the running app (<app-pid>) has exited, the old bundle is renamed
#     "EToolbox Daisy.app.previous" and the new one takes its place;
#   - when "<status-file>.go" exists the new app is started and must report
#     "started|..." in the status file; if it does not, the old bundle is put back.
# A failed build or smoke test leaves the installed app exactly as it was.
set -euo pipefail

# ---- Pinned inputs ----
NODE_VERSION="24.20.0"
NODE_SHA256_ARM64="40e5607e5ecb3db9192723776da2d75d966260fc74a7a9e731c1bd67dda96bc8"
NODE_SHA256_X64="9e5b2644cf107befb6aefca676b96d3296bc10138096f022ed378d6233ed81f4"
NODE_SIGNER="Node.js Foundation"
# The oldest installed Node.js the build tools declare support for: Electron 44,
# electron-vite 5 and vite 7 all answer 22.12. An older one is refused here
# rather than failing halfway through the build.
NODE_BASELINE_MAJOR=22
NODE_BASELINE_MINOR=12
REPO="smiakchilo/etoolbox-daisy"
APP_NAME="EToolbox Daisy"
UPDATE_MODE=0
APP_DIR=""
APP_PID=""
STATUS_FILE=""
if [ "${1:-}" = "--update" ]; then
  [ "$#" -ge 5 ] || { echo "Usage: install.command --update <ref-or-zip-url> <app-folder> <app-pid> <status-file>"; exit 2; }
  UPDATE_MODE=1
  REF="$2"
  APP_DIR="$3"
  APP_PID="$4"
  STATUS_FILE="$5"
else
  REF="${1:-master}"
fi

# Where the built app is written: the folder this file is in, or - for an update -
# a staging folder beside the installed app.
if [ "$UPDATE_MODE" = "1" ]; then
  APP_BUNDLE="$APP_DIR/$APP_NAME.app"
  PREV_BUNDLE="$APP_BUNDLE.previous"
  OUT_DIR="$APP_DIR/.update-staging"
  rm -rf "$OUT_DIR"
  mkdir -p "$OUT_DIR"
else
  OUT_DIR="$(cd "$(dirname "$0")" && pwd)"
fi

# A Rosetta-translated shell reports x86_64 on Apple Silicon; ask the hardware instead.
if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]; then
  NODE_ARCH="arm64"
  NODE_SHA256="$NODE_SHA256_ARM64"
else
  NODE_ARCH="x64"
  NODE_SHA256="$NODE_SHA256_X64"
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/etoolbox-daisy-build.XXXXXX")"
# The folder holding the node binary that will be used, and the one to put on PATH.
NODE_BIN=""
SRC_DIR="$WORK/src"
SOURCE_URL="${EDAISY_SOURCE_URL:-https://github.com/$REPO/archive/$REF.zip}"
# In update mode the source is a branch or tag, or a whole zip URL.
case "$REF" in *:*) [ "$UPDATE_MODE" = "0" ] || SOURCE_URL="$REF" ;; esac

# What the update is doing, for the failure line; and whether a failure has already been reported.
STEP="starting"
FAILURE_REPORTED=0

# Writes "<stage>|<text>" to the status file in one move, so the app never reads half a line.
status() {
  [ "$UPDATE_MODE" = "1" ] || return 0
  printf '%s|%s\n' "$1" "$2" > "$STATUS_FILE.tmp" && mv -f "$STATUS_FILE.tmp" "$STATUS_FILE"
}

# Prints the executable inside an app bundle.
bundle_exe() {
  echo "$1/Contents/MacOS/$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$1/Contents/Info.plist")"
}

# Runs a command with a time limit in seconds; returns its exit code, or 124 on timeout.
run_with_timeout() {
  limit="$1"
  shift
  "$@" >/dev/null 2>&1 &
  pid=$!
  waited=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$limit" ]; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      return 124
    fi
    sleep 1
    waited=$((waited + 1))
  done
  wait "$pid"
}

# Starts the app at $1 detached, telling it where the status file is; sets NEW_PID.
launch_app() {
  EDAISY_UPDATE_STATUS_FILE="$STATUS_FILE" nohup "$(bundle_exe "$1")" >/dev/null 2>&1 &
  NEW_PID=$!
}

KEEP_WORK=1
cleanup() {
  code=$?
  if [ "$UPDATE_MODE" = "1" ]; then
    if [ "$code" != "0" ]; then
      rm -rf "$OUT_DIR"
      [ "$FAILURE_REPORTED" = "1" ] || status failed "$STEP failed"
    fi
    rm -rf "$WORK"
    return
  fi
  if [ "$KEEP_WORK" = "0" ]; then
    rm -rf "$WORK"
  else
    echo
    echo "Failed. The temporary files in \"$WORK\" are kept for inspection; delete that folder when done."
    echo "Nothing else was changed, except possibly files written to \"$OUT_DIR\"."
  fi
}
trap cleanup EXIT

# Prints the folder holding the Node.js already on PATH, when it is new enough
# and carries npm beside the binary - the layout scripts/app-build.mjs needs.
# Fails (empty output) when this Mac has nothing usable.
usable_installed_node() {
  command -v node >/dev/null 2>&1 || return 1
  node_exec="$(node -p process.execPath 2>/dev/null)" || return 1
  [ -n "$node_exec" ] || return 1
  node_version="$(node -p process.versions.node 2>/dev/null)" || return 1
  major="${node_version%%.*}"
  rest="${node_version#*.}"
  minor="${rest%%.*}"
  case "$major" in '' | *[!0-9]*) return 1 ;; esac
  case "$minor" in '' | *[!0-9]*) return 1 ;; esac
  [ "$major" -gt "$NODE_BASELINE_MAJOR" ] ||
    { [ "$major" -eq "$NODE_BASELINE_MAJOR" ] && [ "$minor" -ge "$NODE_BASELINE_MINOR" ]; } ||
    return 1
  bin_dir="$(dirname "$node_exec")"
  if [ ! -f "$bin_dir/node_modules/npm/bin/npm-cli.js" ] &&
    [ ! -f "$bin_dir/../lib/node_modules/npm/bin/npm-cli.js" ]; then
    return 1
  fi
  echo "$bin_dir"
}

# ---- 1. Node.js: the one installed here when it is new enough, else the pinned build ----
STEP="Node.js setup"
status installing-node "Preparing Node.js"
if [ "${EDAISY_NODE:-auto}" != "pinned" ] && installed_bin="$(usable_installed_node)"; then
  NODE_BIN="$installed_bin"
  echo "Using the installed Node.js $("$NODE_BIN/node" -p process.versions.node) - $NODE_BIN"
  echo "It is neither downloaded nor signature-checked by this script."
fi

if [ -z "$NODE_BIN" ]; then
  if [ "${EDAISY_NODE:-auto}" != "pinned" ]; then
    echo "No Node.js $NODE_BASELINE_MAJOR.$NODE_BASELINE_MINOR or newer with npm was found; downloading the pinned $NODE_VERSION ..."
  fi
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
  mv "$WORK/node-v$NODE_VERSION-darwin-$NODE_ARCH" "$WORK/node"
  rm "$WORK/$NODE_TGZ"
  NODE_BIN="$WORK/node/bin"
  codesign --verify --strict "$NODE_BIN/node"
  if ! codesign -dvv "$NODE_BIN/node" 2>&1 | grep "^Authority=Developer ID Application: $NODE_SIGNER"; then
    echo "node is not signed by $NODE_SIGNER."
    exit 1
  fi
  echo "node signature: valid, $NODE_SIGNER"
fi

# ---- 2. Source ----
STEP="source download"
status downloading "Downloading the source"
echo "Downloading source from $SOURCE_URL ..."
mkdir "$WORK/unpack"
curl -fL --retry 3 -o "$WORK/source.zip" "$SOURCE_URL"
tar -xf "$WORK/source.zip" -C "$WORK/unpack"
mv "$WORK"/unpack/*/ "$SRC_DIR"
test -f "$SRC_DIR/scripts/app-build.mjs"

# ---- 3. Install, build, write the app next to this file (caches stay in the work folder) ----
export PATH="$NODE_BIN:$PATH"
export npm_config_cache="$WORK/npm-cache"
export npm_config_update_notifier=false
export electron_config_cache="$WORK/electron-cache"
export ELECTRON_CACHE="$WORK/electron-cache"
export ELECTRON_BUILDER_CACHE="$WORK/builder-cache"
STEP="build"
status building "Building the application"
cd "$SRC_DIR"
"$NODE_BIN/node" scripts/app-build.mjs --out "$OUT_DIR"

# ---- 4a. Update: test the staged build, wait for the app to quit, swap, start, roll back on failure ----
if [ "$UPDATE_MODE" = "1" ]; then
  STEP="smoke test"
  status testing "Testing the new version"
  NEW_EXE="$(bundle_exe "$OUT_DIR/$APP_NAME.app")"
  if EDAISY_UPDATE_STATUS_FILE="" run_with_timeout 180 "$NEW_EXE" --smoke-test; then :; else
    exit 1
  fi

  # A later update uses this copy of the script, so the install folder keeps the current one.
  if [ -f "$APP_DIR/install.command" ]; then
    cp "$SRC_DIR/install/install.command" "$APP_DIR/install.command.new" &&
      chmod +x "$APP_DIR/install.command.new" &&
      mv -f "$APP_DIR/install.command.new" "$APP_DIR/install.command" || true
  fi

  STEP="waiting for the app to quit"
  status ready "The update is ready"
  cd /tmp
  while kill -0 "$APP_PID" 2>/dev/null; do sleep 1; done

  STEP="swap"
  rm -rf "$PREV_BUNDLE"
  swapped=0
  for _ in $(seq 1 30); do
    if mv "$APP_BUNDLE" "$PREV_BUNDLE" 2>/dev/null; then
      swapped=1
      break
    fi
    sleep 1
  done
  if [ "$swapped" = "0" ]; then
    status failed "The installed app could not be replaced"
    FAILURE_REPORTED=1
    [ ! -f "$STATUS_FILE.go" ] || launch_app "$APP_BUNDLE"
    rm -f "$STATUS_FILE.go"
    exit 1
  fi
  if ! mv "$OUT_DIR/$APP_NAME.app" "$APP_BUNDLE"; then
    mv "$PREV_BUNDLE" "$APP_BUNDLE" || true
    status failed "The new version could not be put in place"
    FAILURE_REPORTED=1
    [ ! -f "$STATUS_FILE.go" ] || launch_app "$APP_BUNDLE"
    rm -f "$STATUS_FILE.go"
    exit 1
  fi

  if [ ! -f "$STATUS_FILE.go" ]; then
    status swapped "Updated; starts next time"
    exit 0
  fi

  STEP="start"
  status swapped "Updated"
  launch_app "$APP_BUNDLE"
  started=0
  for _ in $(seq 1 120); do
    if grep -q '^started|' "$STATUS_FILE" 2>/dev/null; then
      started=1
      break
    fi
    kill -0 "$NEW_PID" 2>/dev/null || break
    sleep 2
  done
  if [ "$started" = "1" ]; then
    rm -rf "$PREV_BUNDLE"
    rm -f "$STATUS_FILE.go"
    exit 0
  fi

  kill "$NEW_PID" 2>/dev/null || true
  rm -rf "$APP_BUNDLE"
  mv "$PREV_BUNDLE" "$APP_BUNDLE" || true
  status reverted "The new version did not start; the previous one was restored"
  FAILURE_REPORTED=1
  rm -f "$STATUS_FILE.go"
  launch_app "$APP_BUNDLE"
  exit 1
fi

# ---- 4. Clean up and start ----
cd "$OUT_DIR"
KEEP_WORK=0
rm -rf "$WORK"
echo
echo "EToolbox Daisy is ready: $OUT_DIR/EToolbox Daisy.app"
open "$OUT_DIR/EToolbox Daisy.app"
