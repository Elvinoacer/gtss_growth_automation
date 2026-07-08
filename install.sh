#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# GTSS Growth Engine — universal installer (curl | bash)
#
# Usage:
#   curl -fsSL https://gtss.dev/install.sh | bash
#   curl -fsSL https://gtss.dev/install.sh | bash -s -- --dev   # npm fallback
#
# This script:
#   1. Detects the OS and architecture.
#   2. Downloads the appropriate native installer from GitHub Releases
#      (.exe / .deb / .rpm / .AppImage / .dmg).
#   3. Runs the installer (or tells the user how to run it for .deb / .rpm).
#   4. If GitHub is unreachable or no native installer exists for the platform,
#      falls back to: npm install -g gtss-growth-desktop  (requires Node.js).
#   5. If npm isn't installed either, prints a helpful error.
#
# The script NEVER modifies the user's PATH without telling them, and NEVER
# runs sudo without prompting first.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ─── Config ──────────────────────────────────────────────────────────────────

GITHUB_OWNER="Elvinoacer"
GITHUB_REPO="gtss_growth_automation"
NPM_PACKAGE="gtss-growth-desktop"

# ANSI colors — disabled if not a TTY.
if [ -t 1 ]; then
  BOLD="\033[1m"
  DIM="\033[2m"
  GREEN="\033[32m"
  YELLOW="\033[33m"
  BLUE="\033[34m"
  RED="\033[31m"
  RESET="\033[0m"
else
  BOLD=""; DIM=""; GREEN=""; YELLOW=""; BLUE=""; RED=""; RESET=""
fi

log()  { printf "${BOLD}${BLUE}[gtss]${RESET} %s\n" "$*"; }
ok()   { printf "${BOLD}${GREEN}[gtss]${RESET} %s\n" "$*"; }
warn() { printf "${BOLD}${YELLOW}[gtss]${RESET} %s\n" "$*" >&2; }
err()  { printf "${BOLD}${RED}[gtss]${RESET} %s\n" "$*" >&2; }

# ─── Parse args ──────────────────────────────────────────────────────────────

FORCE_NPM=0
for arg in "$@"; do
  case "$arg" in
    --dev|--npm) FORCE_NPM=1 ;;
    --help|-h)
      cat <<EOF
GTSS Growth Engine installer

Usage: curl -fsSL https://gtss.dev/install.sh | bash [options]

Options:
  --dev, --npm   Skip native installer, use npm install -g instead.
  --help, -h     Show this help.

Without options, the script downloads and runs the appropriate native
installer (.exe / .deb / .rpm / .AppImage / .dmg) for your platform.
EOF
      exit 0
      ;;
  esac
done

# ─── OS / arch detection ─────────────────────────────────────────────────────

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Linux*)  PLATFORM="linux";;
  Darwin*) PLATFORM="macos";;
  MINGW*|MSYS*|CYGWIN*|Windows*)
    # On Windows under Git Bash / MSYS, hand off to the PowerShell installer.
    PLATFORM="windows";;
  *) err "Unsupported OS: $OS"; exit 1;;
esac

case "$ARCH" in
  x86_64|amd64)  ARCH_NORM="x64";;
  arm64|aarch64) ARCH_NORM="arm64";;
  *) err "Unsupported architecture: $ARCH"; exit 1;;
esac

log "Detected: ${PLATFORM}/${ARCH_NORM}"

# On Windows, defer to the PowerShell installer.
if [ "$PLATFORM" = "windows" ]; then
  if command -v powershell.exe >/dev/null 2>&1; then
    log "Handing off to PowerShell installer for Windows..."
    powershell.exe -ExecutionPolicy Bypass -NoProfile -Command \
      "iwr -UseBasicParsing https://gtss.dev/install.ps1 | iex"
    exit $?
  else
    err "On Windows, please run the PowerShell installer directly:"
    err "  iwr -UseBasicParsing https://gtss.dev/install.ps1 | iex"
    exit 1
  fi
fi

# ─── Native installer path ───────────────────────────────────────────────────

fetch_latest_release() {
  local url="https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -H "User-Agent: gtss-installer" -H "Accept: application/vnd.github+json" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- --header="User-Agent: gtss-installer" --header="Accept: application/vnd.github+json" "$url"
  else
    err "Neither curl nor wget is installed. Please install one and retry."
    return 1
  fi
}

pick_asset_url() {
  local release_json="$1"
  # We rely on python3 or jq for JSON parsing.
  if command -v jq >/dev/null 2>&1; then
    local assets
    assets=$(echo "$release_json" | jq -r '.assets[] | "\(.name)\t\(.browser_download_url)\t\(.size)"')
  elif command -v python3 >/dev/null 2>&1; then
    assets=$(echo "$release_json" | python3 -c '
import json, sys
data = json.load(sys.stdin)
for a in data.get("assets", []):
    print(f"{a[\"name\"]}\t{a[\"browser_download_url\"]}\t{a[\"size\"]}")
')
  else
    err "Need either jq or python3 to parse the release list. Install one and retry."
    return 1
  fi

  local pattern=""
  case "$PLATFORM" in
    macos)
      # Prefer .dmg matching arch, then any .dmg.
      pattern="${ARCH_NORM}.*\\.dmg$|\\.dmg$"
      ;;
    linux)
      # Prefer AppImage, then .deb, then .rpm — match arch first.
      pattern="${ARCH_NORM}.*\\.AppImage$|\\.AppImage$|${ARCH_NORM}.*\\.deb$|\\.deb$|${ARCH_NORM}.*\\.rpm$|\\.rpm$"
      ;;
  esac

  echo "$assets" | while IFS=$'\t' read -r name url size; do
    if echo "$name" | grep -qE "$pattern"; then
      echo "$name|$url|$size"
      return 0
    fi
  done
  return 1
}

download() {
  local url="$1"
  local dest="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fSL --progress-bar -o "$dest" "$url"
  else
    wget --show-progress -O "$dest" "$url"
  fi
}

run_native_installer() {
  if [ "$FORCE_NPM" = "1" ]; then
    return 1
  fi

  log "Fetching latest release info from GitHub..."
  local release_json
  if ! release_json=$(fetch_latest_release); then
    warn "Could not reach GitHub. Falling back to npm."
    return 1
  fi

  local picked
  if ! picked=$(pick_asset_url "$release_json"); then
    warn "No native installer available for ${PLATFORM}/${ARCH_NORM}. Falling back to npm."
    return 1
  fi

  local name url size
  IFS='|' read -r name url size <<<"$picked"
  log "Found installer: ${name} ($(( size / 1024 / 1024 )) MB)"

  local tmpdir
  tmpdir="$(mktemp -d)"
  local dest="${tmpdir}/${name}"
  trap 'rm -rf "$tmpdir"' EXIT

  log "Downloading to ${dest}..."
  if ! download "$url" "$dest"; then
    warn "Download failed. Falling back to npm."
    return 1
  fi

  # Run the installer.
  case "$PLATFORM" in
    macos)
      log "Opening ${name}..."
      open "$dest"
      ok "Installer launched. Drag GTSS Growth Engine to your Applications folder."
      ;;
    linux)
      case "$name" in
        *.AppImage)
          chmod +x "$dest"
          log "Launching AppImage..."
          nohup "$dest" >/dev/null 2>&1 &
          ok "GTSS Growth Engine launched. It's also saved at ${dest}."
          ok "To install permanently, move it to ~/Applications or /opt:"
          ok "  mkdir -p ~/Applications && mv '${dest}' ~/Applications/"
          ;;
        *.deb)
          # Make the downloaded .deb world-readable before invoking apt /
          # dpkg. Otherwise apt prints a noisy warning:
          #   "N: Download is performed unsandboxed as root as file
          #    '...' couldn't be accessed by user '_apt'. - pkgAcquire::Run
          #    (13: Permission denied)"
          # The warning is harmless functionally, but it makes the install
          # look broken to a non-technical user. Chmodding the file to 0644
          # before apt reads it silences the warning.
          chmod 0644 "$dest" 2>/dev/null || true
          if [ "$(id -u)" = "0" ]; then
            apt-get install -y "$dest"
          else
            warn "Installing .deb requires sudo. Running:"
            sudo apt-get install -y "$dest"
          fi
          ok "Installed. Find GTSS Growth Engine in your Applications menu."
          ;;
        *.rpm)
          if [ "$(id -u)" = "0" ]; then
            rpm -i "$dest"
          else
            warn "Installing .rpm requires sudo. Running:"
            sudo rpm -i "$dest"
          fi
          ok "Installed. Find GTSS Growth Engine in your Applications menu."
          ;;
      esac
      ;;
  esac
  return 0
}

# ─── npm fallback ────────────────────────────────────────────────────────────

run_npm_fallback() {
  log "Falling back to npm install."

  if ! command -v npm >/dev/null 2>&1; then
    err "npm is not installed."
    err ""
    err "To install GTSS Growth Engine, you need EITHER:"
    err "  - A native installer (download from https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases)"
    err "  - Node.js + npm (https://nodejs.org/)"
    err ""
    err "If you can't install either, ask the person who sent you this link for a"
    err "direct download of the installer file for ${PLATFORM}/${ARCH_NORM}."
    exit 1
  fi

  log "Installing ${NPM_PACKAGE} globally..."
  if ! npm install -g "$NPM_PACKAGE"; then
    err "npm install failed."
    exit 1
  fi

  ok "Installed. Launch with: gtss-growth"
  log "The first launch will download Electron (~80 MB) — this is normal."
}

# ─── Run ────────────────────────────────────────────────────────────────────

printf "\n${BOLD}GTSS Growth Engine — Installer${RESET}\n\n"

if run_native_installer; then
  printf "\n${BOLD}${GREEN}All done!${RESET}\n"
else
  run_npm_fallback
fi
