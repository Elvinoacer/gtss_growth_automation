#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Build all native installers for GTSS Growth Engine.
#
# Usage:
#   scripts/build-all.sh             # build for current platform
#   scripts/build-all.sh --all       # build for all platforms (requires CI)
#
# Output goes to desktop/dist/. Each installer is named:
#   GTSS-Growth-Engine-Setup-<version>-x64.exe    (Windows NSIS)
#   GTSS-Growth-Engine-<version>-x64.msi          (Windows MSI)
#   GTSS-Growth-Engine-<version>-amd64.deb        (Linux .deb)
#   GTSS-Growth-Engine-<version>-x86_64.rpm       (Linux .rpm)
#   GTSS-Growth-Engine-<version>-x64.AppImage     (Linux AppImage)
#   GTSS-Growth-Engine-<version>-x64.dmg          (macOS .dmg)
#   GTSS-Growth-Engine-<version>-arm64.dmg        (macOS .dmg Apple Silicon)
#
# Prerequisites:
#   - Node.js 20+ and npm
#   - For cross-platform builds: a CI runner on each target OS. electron-builder
#     cannot cross-compile Windows .exe from Linux or vice versa without
#     Docker/Wine.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
DESKTOP_DIR="${REPO_ROOT}/desktop"

# shellcheck source=build-common.sh
source "${SCRIPT_DIR}/build-common.sh"
prepare_build_environment "$REPO_ROOT"

cd "$DESKTOP_DIR"

# Build for current platform by default.
case "$(uname -s)" in
  Linux*)  TARGETS="--linux deb rpm AppImage";;
  Darwin*) TARGETS="--mac dmg";;
  MINGW*|MSYS*|CYGWIN*|Windows*) TARGETS="--win nsis msi";;
  *) echo "Unknown OS"; exit 1;;
esac

if [ "${1:-}" = "--all" ]; then
  echo ">> Building for ALL platforms (cross-compile via Docker/Wine if available)..."
  TARGETS="--win nsis msi --linux deb rpm AppImage --mac dmg"
fi

echo ">> Running: electron-builder $TARGETS"
npx electron-builder $TARGETS

echo ""
echo ">> Done. Artifacts in desktop/dist/:"
ls -lh dist/ | grep -E '\.(exe|msi|deb|rpm|AppImage|dmg)$'
