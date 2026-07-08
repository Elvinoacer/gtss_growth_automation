#!/usr/bin/env bash
# Build macOS installer (.dmg for x64 + arm64).
# Must be run on a macOS host (or CI runner). Notarization requires an Apple
# Developer ID — set the NOTARIZE_TEAM_ID env var to enable it.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

# shellcheck source=build-common.sh
source "${SCRIPT_DIR}/build-common.sh"
prepare_build_environment "$REPO_ROOT"

cd "${REPO_ROOT}/desktop"

if [ -n "${NOTARIZE_TEAM_ID:-}" ]; then
  export CSC_IDENTITY_AUTO_DISCOVERY=true
  echo ">> Notarization enabled (team ID: $NOTARIZE_TEAM_ID)"
fi

npx electron-builder --mac dmg
ls -lh dist/ | grep -E '\.dmg$'
