#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Release — build all installers and publish to GitHub Releases.
#
# Usage:
#   GH_TOKEN=ghp_xxx scripts/release.sh [version]
#
# If version is omitted, the version from desktop/package.json is used.
# The script:
#   1. Bumps desktop/package.json version (if version arg given).
#   2. Tags the repo (skipped if tag already exists).
#   3. Runs build-all.sh.
#   4. Publishes artifacts to GitHub Releases via electron-builder.
#
# This script is typically run by CI (GitHub Actions) on a tag push.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$REPO_ROOT"

if [ -z "${GH_TOKEN:-}" ]; then
  echo "ERROR: GH_TOKEN env var is required."
  echo "Create a token at https://github.com/settings/tokens (repo scope)."
  exit 1
fi

VERSION="${1:-}"
if [ -n "$VERSION" ]; then
  echo ">> Bumping version to $VERSION..."
  (cd desktop && npm version "$VERSION" --no-git-tag-version)
  git add desktop/package.json
fi

# Read the current version.
VERSION=$(node -p "require('./desktop/package.json').version")
TAG="v${VERSION}"

echo ">> Releasing version $VERSION (tag: $TAG)"

# Commit + tag.
if ! git rev-parse "$TAG" >/dev/null 2>&1; then
  git add -A
  git commit -m "chore(release): $VERSION" || true
  git tag "$TAG"
  git push origin main "$TAG"
fi

# Build + publish.
# Use build-all.sh so the engine's node_modules are installed and its
# native modules are rebuilt against Electron's ABI before packaging.
# (build-all.sh sources scripts/build-common.sh which handles both.)
echo ">> Preparing build environment (installing deps + rebuilding native modules)..."
# shellcheck source=build-common.sh
source "${SCRIPT_DIR}/build-common.sh"
prepare_build_environment "$REPO_ROOT"

cd desktop
echo ">> Publishing to GitHub Releases..."
npx electron-builder --win nsis msi --linux deb rpm AppImage --mac dmg --publish always

echo ""
echo ">> Release $TAG published."
echo "   https://github.com/Elvinoacer/gtss_growth_automation/releases/tag/$TAG"
