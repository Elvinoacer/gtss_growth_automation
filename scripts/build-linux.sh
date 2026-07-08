#!/usr/bin/env bash
# Build Linux installers (.deb + .rpm + .AppImage).
# Must be run on a Linux host (or CI runner).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

# shellcheck source=build-common.sh
source "${SCRIPT_DIR}/build-common.sh"
prepare_build_environment "$REPO_ROOT"

cd "${REPO_ROOT}/desktop"
npx electron-builder --linux deb rpm AppImage
ls -lh dist/ | grep -E '\.(deb|rpm|AppImage)$'
