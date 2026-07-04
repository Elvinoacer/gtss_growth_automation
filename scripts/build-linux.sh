#!/usr/bin/env bash
# Build Linux installers (.deb + .rpm + .AppImage).
# Must be run on a Linux host (or CI runner).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
cd "${REPO_ROOT}/desktop"

if [ ! -d node_modules ]; then npm install; fi
npx electron-rebuild -f -w better-sqlite3
npx electron-builder --linux deb rpm AppImage
ls -lh dist/ | grep -E '\.(deb|rpm|AppImage)$'
