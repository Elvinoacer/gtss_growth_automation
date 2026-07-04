#!/usr/bin/env bash
# Build Windows installers (.exe NSIS + .msi).
# Must be run on a Windows host (or CI runner) — electron-builder can't
# cross-compile Windows binaries from Linux without Wine.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
cd "${REPO_ROOT}/desktop"

if [ ! -d node_modules ]; then npm install; fi
npx electron-rebuild -f -w better-sqlite3
npx electron-builder --win nsis msi
ls -lh dist/ | grep -E '\.(exe|msi)$'
