#!/bin/bash
# Launch Chrome with remote debugging for GTSS automation.
#
# Uses a separate user-data-dir (required by Chrome for remote debugging) but
# copies your existing Chrome profile so you stay logged into LinkedIn.
#
# ─── Try-first-then-clone pattern (inviolable across the project) ──────────
#
# The project NEVER runs two CDP Chromes side-by-side. Before we spawn or
# clone anything, this script:
#
#   1. PROBES the CDP port ($PORT). If a Chrome is already listening there
#      (e.g., the desktop launcher already started one, or this script was
#      run twice, or the user launched Chrome manually with the right
#      flags), we print a friendly note and EXIT 0 — no spawn, no clone.
#      The same Chrome that's already up becomes the project's automation
#      target. This is the "try first" half.
#
#   2. Otherwise, we check whether the CDP profile dir already has a
#      populated Default/Cookies. If yes, reuse it (sessions from previous
#      launches are preserved). If no, clone from the user's real Chrome
#      profile. This is the "clone if missing" half.
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

# ─── Step 1: Try first — is a CDP Chrome already alive on $PORT? ──────────
#
# We probe with curl (preferred) and fall back to a raw TCP connect via
# bash /dev/tcp. If anything answers on /json/version, we know a Chrome is
# already up — print a friendly note and exit 0 so the caller (typically
# the desktop launcher or a developer running this script) can just adopt
# that Chrome.
probe_cdp() {
  local port="$1"
  if command -v curl >/dev/null 2>&1; then
    if curl -s --max-time 1 "http://127.0.0.1:${port}/json/version" >/dev/null 2>&1; then
      return 0
    fi
    return 1
  fi
  # Bash fallback — open a TCP socket to the port. If it succeeds, the
  # port is open (something is listening).
  (echo > "/dev/tcp/127.0.0.1/${port}") >/dev/null 2>&1
}

if probe_cdp "$PORT"; then
  echo "✓ A Chrome with remote debugging is already running on port ${PORT}."
  echo "  Reusing it — no new browser spawned, no profile clone needed."
  echo "  This is the project's inviolable try-first-then-clone pattern:"
  echo "  the same Chrome is shared across the web app, the automation"
  echo "  layer, and this script. To force a fresh launch, close that"
  echo "  Chrome first (or change CDP_PORT)."
  exit 0
fi

# ─── Step 2: Clone if missing — populate the CDP profile dir on first run ──
# First-time setup: copy the Default profile for cookies/logins.
if [ ! -d "$CDP_PROFILE_DIR/Default" ] || [ ! -f "$CDP_PROFILE_DIR/Default/Cookies" ]; then
  echo "📋 First-time setup: copying your Chrome profile..."
  mkdir -p "$CDP_PROFILE_DIR"

  if [ -d "$SOURCE_PROFILE/Default" ]; then
    # Copy only what's needed for session cookies (not the full multi-GB cache)
    cp -r "$SOURCE_PROFILE/Default" "$CDP_PROFILE_DIR/Default" 2>/dev/null
    cp "$SOURCE_PROFILE/Local State" "$CDP_PROFILE_DIR/Local State" 2>/dev/null

    # Remove heavy cache dirs to save space
    rm -rf "$CDP_PROFILE_DIR/Default/Cache" \
           "$CDP_PROFILE_DIR/Default/Code Cache" \
           "$CDP_PROFILE_DIR/Default/Service Worker/CacheStorage" \
           "$CDP_PROFILE_DIR/Default/GPUCache" 2>/dev/null

    echo "✓ Profile copied to $CDP_PROFILE_DIR"
  else
    echo "⚠ No source Chrome profile found at $SOURCE_PROFILE — starting with a fresh profile."
    echo "  You'll need to log into LinkedIn/X/Facebook/Instagram manually."
  fi
  echo ""
else
  echo "✓ CDP profile already initialized — reusing existing sessions."
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
