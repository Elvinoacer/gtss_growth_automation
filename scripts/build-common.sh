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
  #
  # ── Why --ignore-scripts ───────────────────────────────────────────────
  # `better-sqlite3`'s install script runs `prebuild-install || node-gyp
  # rebuild`. On Windows, `prebuild-install` often finds no prebuilt binary
  # for the exact Node patch version in use, falls back to `node-gyp
  # rebuild`, and dies because:
  #   - `windows-latest` has Visual Studio 18 (Preview) which node-gyp
  #     10.x doesn't recognise, OR
  #   - the user's machine doesn't have Visual Studio's "Desktop
  #     development with C++" workload installed at all.
  #
  # We don't actually WANT the Node-compatible native binary — the server
  # runs under Electron's bundled Node (ELECTRON_RUN_AS_NODE=1), so the
  # binary must be built against ELECTRON's ABI. Step 3 below
  # (`electron-rebuild`) downloads the Electron-compatible prebuilt from
  # better-sqlite3's GitHub Releases — no compilation, no Visual Studio,
  # no node-gyp. `--ignore-scripts` here just prevents the doomed
  # Node-target build from running first and failing the whole pipeline.
  #
  # The same logic applies to `sharp`: its install script downloads the
  # prebuilt libvips binary, but the `@img/sharp-<platform>-<arch>` npm
  # packages (installed as optional deps by `npm ci`) already contain
  # the binary — so skipping the install script is safe.
  echo ">> Installing gtss-growth-engine/ dependencies (--ignore-scripts, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1)..."
  (
    cd "$engine_dir"
    if [ -f package-lock.json ]; then
      npm ci --ignore-scripts || npm install --ignore-scripts
    else
      npm install --ignore-scripts
    fi
  )

  # ─── 3. Rebuild engine's native modules against Electron's ABI ──────────
  # The server runs under ELECTRON_RUN_AS_NODE=1 (Electron's bundled Node),
  # so native modules in gtss-growth-engine/node_modules/ MUST be rebuilt
  # against Electron's NODE_MODULE_VERSION — otherwise they throw
  # "NODE_MODULE_VERSION mismatch" on require().
  #
  # `electron-rebuild` calls `prebuild-install --runtime=electron
  # --target=<electron-version>`, which downloads the prebuilt binary
  # from better-sqlite3's GitHub Releases. No compilation needed on any
  # platform — this works on Linux, Windows, and macOS without Visual
  # Studio / Xcode / build-essential.
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

  # ─── 4. Verify the rebuilt native module actually loads under Electron ──
  # electron-rebuild's exit code only means the rebuild *command* finished.
  # It does not guarantee the resulting .node file is the right ABI for this
  # Electron version. Requiring better-sqlite3 under ELECTRON_RUN_AS_NODE=1
  # turns a future silent ABI mismatch into a clear build-time failure.
  echo ">> Verifying better-sqlite3 loads under Electron's bundled Node..."
  (
    cd "$engine_dir"
    # `require('electron')` returns the absolute path to the Electron binary
    # (electron.exe / Electron.app/.../Electron / electron).
    electron_bin="$(cd "$desktop_dir" && node -p "require('electron')")"
    if [ -z "$electron_bin" ] || [ ! -e "$electron_bin" ]; then
      echo "ERROR: could not resolve Electron binary path for ABI check" >&2
      exit 1
    fi
    ELECTRON_RUN_AS_NODE=1 "$electron_bin" -e "require('better-sqlite3'); console.log('better-sqlite3 OK under Electron ABI')"
  )

  echo ">> Build environment ready."
}
