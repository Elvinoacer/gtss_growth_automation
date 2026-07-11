#!/bin/bash
# Launch Chrome with remote debugging for GTSS automation.
#
# Uses a separate user-data-dir (required by Chrome for remote debugging) but
# copies the session-bearing files (Cookies, Login Data, Local State, Web
# Data, Preferences, TransportSecurity, Favicons, History) from your existing
# Chrome profile so you stay logged into LinkedIn / X / Instagram / Facebook /
# Google — WITHOUT copying the multi-GB caches (IndexedDB, Local Storage,
# Sessions, Media Cache, Service Worker tree, etc.) that caused the previous
# "GTSS Growth Engine is not responding" main-thread freeze.
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
#      populated Default/Cookies (or Default/Login Data). If yes, reuse it
#      (sessions from previous launches are preserved). If no, clone ONLY
#      the session-bearing files from the user's real Chrome profile. This
#      is the "clone if missing" half — fast (<1s) because we skip
#      IndexedDB/LocalStorage/Sessions/Storage/ServiceWorker/MediaCache
#      entirely.
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
#
# First-time setup: copy ONLY the session-bearing files (Cookies, Login Data,
# Local State, Web Data, Preferences, etc.) — NOT the full multi-GB Default
# dir. IndexedDB, Local Storage, Sessions, Media Cache, Service Worker tree,
# and other heavy caches are skipped entirely; Chrome will recreate them as
# the user browses. Total clone time drops from 10–60s (multi-GB) to <1s
# (a few MB), eliminating the "clicking Start hangs the app" symptom.
if [ ! -d "$CDP_PROFILE_DIR/Default" ] || \
   { [ ! -f "$CDP_PROFILE_DIR/Default/Cookies" ] && [ ! -f "$CDP_PROFILE_DIR/Default/Login Data" ]; }; then
  echo "📋 First-time setup: copying session files (cookies + logins) from your Chrome..."
  mkdir -p "$CDP_PROFILE_DIR/Default"

  # Resolve the source profile dir name: usually "Default", but multi-account
  # Chrome installs use "Profile 1", "Profile 2", etc.
  SOURCE_PROFILE_DIR=""
  if [ -d "$SOURCE_PROFILE/Default" ]; then
    SOURCE_PROFILE_DIR="$SOURCE_PROFILE/Default"
  else
    # Fall back to the first "Profile *" dir we find.
    for d in "$SOURCE_PROFILE"/Profile*; do
      if [ -d "$d" ]; then
        SOURCE_PROFILE_DIR="$d"
        break
      fi
    done
  fi

  if [ -n "$SOURCE_PROFILE_DIR" ] && [ -d "$SOURCE_PROFILE_DIR" ]; then
    # Session-bearing files we copy (relative to the source profile dir).
    # Each is normally <8MB; together they preserve LinkedIn/X/Instagram/
    # Facebook/Google logins without the multi-GB cache mass.
    #
    # We also copy the SQLite -journal sidecars when present (tiny, <100KB)
    # to avoid leaving Chrome's SQLite stores in a torn state.
    SESSION_FILES=(
      "Cookies"
      "Cookies-journal"
      "Login Data"
      "Login Data-journal"
      "Login Data For Account"
      "Login Data For Account-journal"
      "Web Data"
      "Web Data-journal"
      "Preferences"
      "Secure Preferences"
      "TransportSecurity"
      "TransportSecurity-journal"
      "Favicons"
      "Favicons-journal"
      "History"
      "History-journal"
      "Top Sites"
      "Top Sites-journal"
      "Network/Cookies"
      "Network/Network Persistent State"
    )

    copied=0
    skipped=0
    for name in "${SESSION_FILES[@]}"; do
      src="$SOURCE_PROFILE_DIR/$name"
      dest="$CDP_PROFILE_DIR/Default/$name"
      if [ -f "$src" ]; then
        # 8MB size cap — defense in depth (these files are normally <1MB).
        size=$(stat -c%s "$src" 2>/dev/null || stat -f%z "$src" 2>/dev/null || echo 0)
        if [ "$size" -gt 8388608 ]; then
          skipped=$((skipped + 1))
          continue
        fi
        # Atomic copy: write to .tmp then rename — a crash mid-copy never
        # leaves a half-written Cookies/Login Data file. mkdir -p first so
        # the Network/ subdirectory exists for "Network/Cookies".
        mkdir -p "$(dirname "$dest")"
        if cp -p "$src" "$dest.tmp.$$" 2>/dev/null && \
           mv -f "$dest.tmp.$$" "$dest" 2>/dev/null; then
          copied=$((copied + 1))
        else
          rm -f "$dest.tmp.$$" 2>/dev/null
          skipped=$((skipped + 1))
        fi
      fi
    done

    # Copy "Local State" from the TOP LEVEL of the source user-data dir
    # (not inside Default/). Required to decrypt encrypted cookies / login
    # data on Windows and macOS (carries the os_crypt.encrypted_key blob,
    # bound to the OS keyring — same user, same machine, decryption works).
    #
    # ─── Profile-picker fix ───────────────────────────────────────────────
    # Local State also carries profile.info_cache — the list Chrome reads
    # to populate the "Who's using Chrome?" picker. Copying it verbatim
    # from a real Chrome with multiple profiles (common) carries every one
    # of those entries into $CDP_PROFILE_DIR, so Chrome shows the picker on
    # every launch even though only one Default/ dir actually exists here.
    # After copying, we rewrite info_cache down to a single "Default" entry
    # (python3, if available) so the copied file matches what's really on
    # disk. os_crypt and everything else in the file is left untouched. If
    # python3 isn't on PATH we skip the rewrite silently — the
    # --profile-directory=Default flag passed to Chrome below is a second,
    # independent defense against the picker either way.
    if [ -f "$SOURCE_PROFILE/Local State" ]; then
      cp -p "$SOURCE_PROFILE/Local State" "$CDP_PROFILE_DIR/Local State" 2>/dev/null && copied=$((copied + 1))
      if [ -f "$CDP_PROFILE_DIR/Local State" ] && command -v python3 >/dev/null 2>&1; then
        python3 - "$CDP_PROFILE_DIR/Local State" <<'PYEOF' 2>/dev/null
import json, sys
path = sys.argv[1]
with open(path, "r", encoding="utf-8") as f:
    state = json.load(f)
profile = state.setdefault("profile", {})
existing_default = (profile.get("info_cache") or {}).get("Default")
profile["info_cache"] = {"Default": existing_default or {"name": "Default"}}
profile["last_used"] = "Default"
profile["last_active_profiles"] = ["Default"]
if isinstance(profile.get("profiles_order"), list):
    profile["profiles_order"] = ["Default"]
tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(state, f)
import os
os.replace(tmp, path)
PYEOF
      fi
    fi

    echo "✓ Copied $copied session file(s) to $CDP_PROFILE_DIR"
    if [ "$skipped" -gt 0 ]; then
      echo "  ($skipped file(s) skipped — see messages above if any)"
    fi

    # Verify we ended up with at least one session-bearing file. If not,
    # the user's source profile is likely locked (their real Chrome is
    # running). Tell them to close it and re-run.
    if [ ! -f "$CDP_PROFILE_DIR/Default/Cookies" ] && [ ! -f "$CDP_PROFILE_DIR/Default/Login Data" ]; then
      echo ""
      echo "⚠  No Cookies or Login Data file could be copied."
      echo "   If your real Chrome is currently running, close it and re-run"
      echo "   this script so the (locked) SQLite files can be copied cleanly."
      echo "   The CDP Chrome will start with a fresh profile in the meantime."
    fi
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
  --profile-directory=Default \
  --no-first-run \
  --disable-default-apps \
  --start-maximized \
  "$@"
