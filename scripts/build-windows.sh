#!/usr/bin/env bash
# Build Windows installers (.exe NSIS + .msi).
# Must be run on a Windows host (or CI runner) — electron-builder can't
# cross-compile Windows binaries from Linux without Wine.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

# shellcheck source=build-common.sh
source "${SCRIPT_DIR}/build-common.sh"
prepare_build_environment "$REPO_ROOT"

cd "${REPO_ROOT}/desktop"
npx electron-builder --win nsis msi
ls -lh dist/ | grep -E '\.(exe|msi)$'
