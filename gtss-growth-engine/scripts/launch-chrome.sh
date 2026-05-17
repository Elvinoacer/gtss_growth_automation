#!/bin/bash
# Launch Chrome with remote debugging for GTSS automation
# Uses a separate user-data-dir (required by Chrome for remote debugging)
# but copies your existing Chrome profile so you stay logged into LinkedIn.

PORT="${CDP_PORT:-9222}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
CDP_PROFILE_DIR="$PROJECT_DIR/chrome-cdp-profile"
SOURCE_PROFILE="$HOME/.config/google-chrome"

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

google-chrome-stable \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$CDP_PROFILE_DIR" \
  --no-first-run \
  --disable-default-apps \
  --disable-popup-blocking \
  --start-maximized \
  "$@"
