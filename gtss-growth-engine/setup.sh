#!/usr/bin/env bash
# Thin wrapper around the cross-platform Node setup script.
# Prefer: npm run setup
set -euo pipefail
cd "$(dirname "$0")"
exec node scripts/setup.js "$@"
