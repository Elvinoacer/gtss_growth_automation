#!/bin/bash
# Launch Chrome with remote debugging for GTSS automation.
#
# Uses a separate user-data-dir (required by Chrome for remote debugging) but
# copies your existing Chrome profile so you stay logged into LinkedIn.
#
# The user-data-dir is taken from $CDP_PROFILE_DIR if set; otherwise it
# defaults to <repo>/chrome-cdp-profile. The desktop launcher sets
# CDP_PROFILE_DIR=<userData>/chrome-cdp-profile so the profile lives in a
# writable directory that survives app updates (the bundled <resources>/
# server/ directory is read-only when the app is installed from a .deb /
# .dmg / .exe).

PORT="${CDP_PORT:-9222}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
CDP_PROFILE_DIR="${CDP_PROFILE_DIR:-$PROJECT_DIR/chrome-cdp-profile}"
SOURCE_PROFILE="${CHROME_USER_DATA_DIR:-$HOME/.config/google-chrome}"

# First-time setup: copy the Default profile for cookies/logins
if [ ! -d "$CDP_PROFILE_DIR/Default" ]; then
  echo "📋 First-time setup: copying your Chrome profile..."
  mkdir -p "$CDP_PROFILE_DIR"

  # Copy only what's needed for session cookies (not the full multi-GB cache)
  cp -r "$SOURCE_PROFILE/Default" "$CDP_PROFILE_DIR/Default" 2>/dev/null
  cp "$SOURCE_PROFILE/Local State" "$CDP_PROFILE_DIR/Local State" 2>/dev/null

  # Remove heavy cache dirs to save space
  rm -rf "$CDP_PROFILE_DIR/Default/Cache" \
         "$CDP_PROFILE_DIR/Default/Code Cache" \
         "$CDP_PROFILE_DIR/Default/Service Worker/CacheStorage" \
         "$CDP_PROFILE_DIR/Default/GPUCache" 2>/dev/null

  echo "✓ Profile copied to $CDP_PROFILE_DIR"
  echo ""
fi

echo "🚀 Launching Chrome with remote debugging on port $PORT..."
echo "   Profile: $CDP_PROFILE_DIR"
echo "   LinkedIn will see your REAL Chrome — no bot detection."
echo ""
echo "   ⚠️  Close any other Chrome windows FIRST."
echo "   ⚠️  Keep this terminal open while automation runs."
echo "   Press Ctrl+C to stop Chrome."
echo ""

# Pick the first Chrome binary available on this system. The desktop
# launcher's CdpManager locates Chrome via a more thorough search (see
# locateChrome() in desktop/main/cdp-manager.js); this script is the
# engine's fallback and is intentionally simpler.
CHROME_BIN=""
for candidate in google-chrome-stable google-chrome chromium-browser chromium; do
  if command -v "$candidate" >/dev/null 2>&1; then
    CHROME_BIN="$candidate"
    break
  fi
done
if [ -z "$CHROME_BIN" ]; then
  echo "ERROR: Google Chrome / Chromium not found. Install it from:" >&2
  echo "  https://www.google.com/chrome/" >&2
  exit 1
fi

"$CHROME_BIN" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$CDP_PROFILE_DIR" \
  --no-first-run \
  --disable-default-apps \
  --start-maximized \
  "$@"
