#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Shared build helpers used by scripts/build-{linux,windows,macos,all}.sh.
#
# This file is SOURCED, not executed. It provides one function:
#
#   prepare_build_environment <repo_root>
#
# Which:
#   1. Installs desktop/ Node dependencies (Electron, electron-builder, …).
#   2. Installs gtss-growth-engine/ Node dependencies — INCLUDING the native
#      modules (better-sqlite3, sharp, playwright) that must be present at
#      runtime. We skip Playwright's browser-binary download because the
#      desktop launcher uses the user's installed Chrome via CDP (channel:
#      "chrome"), not Playwright's bundled Chromium.
#   3. Rebuilds the engine's native modules against Electron's ABI so they
#      load correctly when the server runs under ELECTRON_RUN_AS_NODE=1
#      (Electron's bundled Node).
#
# Step 3 is the part that was missing previously — `electron-rebuild` was
# being run from desktop/, where better-sqlite3 isn't a dependency, so it
# did nothing. The native module rebuild MUST target gtss-growth-engine/.
#
# Why we skip Playwright's browser download:
#   Playwright's postinstall hook downloads ~300 MB of browser binaries
#   (chromium, firefox, webkit). We don't need them — the app's CDP mode
#   launches the user's real Chrome. Skipping the download keeps the
#   build fast and the bundled installer small.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# Skip Playwright's browser-binary download. The desktop app uses CDP mode
# (channel: "chrome"), which launches the user's installed Chrome — we
# never need Playwright's bundled Chromium / Firefox / WebKit.
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
# Same for Playwright's driver download in some environments.
export PLAYWRIGHT_SKIP_BROWSER_GC=1

prepare_build_environment() {
  local repo_root="$1"
  local desktop_dir="${repo_root}/desktop"
  local engine_dir="${repo_root}/gtss-growth-engine"

  if [ ! -d "$desktop_dir" ]; then
    echo "ERROR: desktop/ directory not found at ${desktop_dir}" >&2
    exit 1
  fi
  if [ ! -d "$engine_dir" ]; then
    echo "ERROR: gtss-growth-engine/ directory not found at ${engine_dir}" >&2
    exit 1
  fi

  # ─── 1. Install desktop/ dependencies ────────────────────────────────────
  echo ">> Installing desktop/ dependencies..."
  (
    cd "$desktop_dir"
    if [ -f package-lock.json ]; then
      npm ci || npm install
    else
      npm install
    fi
  )

  # ─── 2. Install gtss-growth-engine/ dependencies ────────────────────────
  # CRITICAL: the engine's node_modules MUST be installed so electron-builder
  # can bundle them into the .deb / .exe / .dmg. Without this, the previous
  # build config excluded node_modules from the package and the server would
  # crash with "Cannot find module 'express'" on first launch.
  echo ">> Installing gtss-growth-engine/ dependencies (PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1)..."
  (
    cd "$engine_dir"
    if [ -f package-lock.json ]; then
      npm ci || npm install
    else
      npm install
    fi
  )

  # ─── 3. Rebuild engine's native modules against Electron's ABI ──────────
  # The server runs under ELECTRON_RUN_AS_NODE=1 (Electron's bundled Node),
  # so native modules in gtss-growth-engine/node_modules/ MUST be rebuilt
  # against Electron's NODE_MODULE_VERSION — otherwise they throw
  # "NODE_MODULE_VERSION mismatch" on require().
  #
  # We use --module-dir to point at the engine's node_modules. The
  # --which flag limits the rebuild to specific packages (faster than
  # rebuilding every native module in the tree).
  echo ">> Rebuilding engine native modules (better-sqlite3, sharp) for Electron's ABI..."
  (
    cd "$desktop_dir"
    npx electron-rebuild -f \
      --module-dir "$engine_dir" \
      --which better-sqlite3 \
      --which sharp \
      --which @img/sharp-linux-x64 \
      --which @img/sharp-darwin-x64 \
      --which @img/sharp-darwin-arm64 \
      --which @img/sharp-win32-x64 \
      || {
        # The --which list above is conservative; some sharp subpackages
        # may not exist for the current platform. Fall back to a plain
        # rebuild-all if the selective rebuild fails.
        echo ">> Selective rebuild failed; falling back to rebuild-all on engine node_modules..."
        npx electron-rebuild -f --module-dir "$engine_dir"
      }
  )

  echo ">> Build environment ready."
}
