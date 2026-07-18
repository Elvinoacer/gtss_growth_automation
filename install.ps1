# ─────────────────────────────────────────────────────────────────────────────
# GTSS Growth Engine — Windows installer (PowerShell)
#
# Usage (from PowerShell):
#   iwr -UseBasicParsing https://gtss.dev/install.ps1 | iex
#
# Or save and run:
#   .\install.ps1
#
# Behaviour:
#   1. Detects Windows architecture.
#   2. Downloads the latest NSIS .exe (or .msi) from GitHub Releases.
#   3. Runs the installer silently with /S (per-user, no admin required).
#   4. If the download fails, falls back to: npm install -g gtss-growth-desktop
#   5. If npm isn't installed, prints a helpful error with a direct download
#      link.
# ─────────────────────────────────────────────────────────────────────────────

#Requires -Version 5.1

[CmdletBinding()]
param(
  [switch]$Dev,
  [switch]$Help
)

$ErrorActionPreference = "Stop"

$script:GitHubOwner = "Elvinoacer"
$script:GitHubRepo  = "gtss_growth_automation"
$script:NpmPackage  = "gtss-growth-desktop"

function Write-GtssLog  { param([string]$Msg) Write-Host "[gtss] $Msg" -ForegroundColor Cyan }
function Write-GtssOk   { param([string]$Msg) Write-Host "[gtss] $Msg" -ForegroundColor Green }
function Write-GtssWarn { param([string]$Msg) Write-Host "[gtss] $Msg" -ForegroundColor Yellow }
function Write-GtssErr  { param([string]$Msg) Write-Host "[gtss] $Msg" -ForegroundColor Red }

if ($Help) {
  Write-Host "GTSS Growth Engine — Windows installer"
  Write-Host ""
  Write-Host "Usage: iwr -UseBasicParsing https://gtss.dev/install.ps1 | iex"
  Write-Host ""
  Write-Host "Options:"
  Write-Host "  -Dev   Skip native installer, use npm install -g instead."
  Write-Host "  -Help  Show this help."
  exit 0
}

Write-Host "GTSS Growth Engine — Windows Installer" -ForegroundColor White
Write-Host ""

# ─── Detect arch ─────────────────────────────────────────────────────────────

$arch = if ([Environment]::Is64BitOperatingSystem) {
  if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
} else { "x86" }

Write-GtssLog "Detected: Windows/$arch"

# ─── Fetch latest release from GitHub ────────────────────────────────────────

function Get-LatestRelease {
  try {
    $headers = @{ "User-Agent" = "gtss-installer"; "Accept" = "application/vnd.github+json" }
    return Invoke-RestMethod -Uri "https://api.github.com/repos/$script:GitHubOwner/$script:GitHubRepo/releases/latest" -Headers $headers -TimeoutSec 15
  } catch {
    Write-GtssWarn "Could not reach GitHub: $($_.Exception.Message)"
    return $null
  }
}

function Select-Asset {
  param($Assets)
  # Prefer NSIS .exe matching arch, then any .exe, then .msi matching arch, then any .msi.
  $candidates = @(
    $Assets | Where-Object { $_.name -match "Setup.*$arch.*\.exe$" }
    $Assets | Where-Object { $_.name -match "\.exe$" -and $_.name -notmatch "blockmap$" }
    $Assets | Where-Object { $_.name -match "$arch.*\.msi$" }
    $Assets | Where-Object { $_.name -match "\.msi$" }
  ) | Select-Object -First 1
  return $candidates
}

function Install-Native {
  if ($Dev) { return $false }

  Write-GtssLog "Fetching latest release info from GitHub..."
  $release = Get-LatestRelease
  if (-not $release -or -not $release.assets) {
    Write-GtssWarn "No release info available. Falling back to npm."
    return $false
  }

  $asset = Select-Asset $release.assets
  if (-not $asset) {
    Write-GtssWarn "No Windows installer available for $arch. Falling back to npm."
    return $false
  }

  $sizeMB = [math]::Round($asset.size / 1024 / 1024, 1)
  Write-GtssLog "Found installer: $($asset.name) ($sizeMB MB)"

  $tmpDir = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "gtss-install-$(Get-Random)")
  New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
  $dest = Join-Path $tmpDir $asset.name

  Write-GtssLog "Downloading to $dest..."
  try {
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $dest -UseBasicParsing
  } catch {
    Write-GtssWarn "Download failed: $($_.Exception.Message)"
    return $false
  }

  Write-GtssLog "Running installer..."
  if ($asset.name -match "\.msi$") {
    # MSI: msiexec /i <file> /qb   (quiet, basic UI)
    Start-Process msiexec.exe -ArgumentList "/i `"$dest`" /qb" -Wait
  } else {
    # NSIS: /S = silent. Per-user install (no UAC) comes from
    # electron-builder.yml `perMachine: false`, not from a /peruser flag
    # (electron-builder's NSIS template does not recognize /peruser).
    Start-Process -FilePath $dest -ArgumentList "/S" -Wait
  }

  Write-GtssOk "Installer completed. GTSS Growth Engine is in your Start Menu."
  Write-GtssLog "Launch it from: Start → GTSS Growth Engine"
  return $true
}

# ─── npm fallback ────────────────────────────────────────────────────────────

function Install-Npm {
  Write-GtssLog "Falling back to npm install."

  $npm = Get-Command npm -ErrorAction SilentlyContinue
  if (-not $npm) {
    Write-GtssErr "npm is not installed."
    Write-GtssErr ""
    Write-GtssErr "To install GTSS Growth Engine on Windows, you need EITHER:"
    Write-GtssErr "  - The native installer (download from https://github.com/$script:GitHubOwner/$script:GitHubRepo/releases)"
    Write-GtssErr "  - Node.js + npm (https://nodejs.org/)"
    exit 1
  }

  Write-GtssLog "Installing $script:NpmPackage globally..."
  & npm install -g $script:NpmPackage
  if ($LASTEXITCODE -ne 0) {
    Write-GtssErr "npm install failed."
    exit 1
  }

  Write-GtssOk "Installed. Launch with: gtss-growth"
  Write-GtssLog "The first launch will download Electron (~80 MB) — this is normal."
}

# ─── Run ────────────────────────────────────────────────────────────────────

if (Install-Native) {
  Write-Host ""
  Write-Host "All done!" -ForegroundColor Green
} else {
  Install-Npm
}
