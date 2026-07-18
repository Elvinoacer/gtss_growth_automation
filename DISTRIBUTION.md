# Distribution Guide

This document describes how to build, sign, and publish GTSS Growth Engine
installers for all supported platforms.

## Prerequisites

- Node.js 20+ and npm
- For Windows builds: a Windows host (CI runner or local). electron-builder
  can't cross-compile Windows .exe / .msi from Linux without Wine (which is
  unreliable).
- For macOS builds: a macOS host. Notarization requires an Apple Developer ID
  ($99/year).
- For Linux builds: a Linux host. Building .rpm requires `rpmbuild`.

## Build matrix

| Target | Format | Build host | Output |
|--------|--------|-----------|--------|
| Windows x64 | NSIS `.exe` | Windows | `GTSS-Growth-Engine-Setup-<ver>-x64.exe` |
| Windows x64 | MSI | Windows | `GTSS-Growth-Engine-<ver>-x64.msi` |
| Linux x64 | `.deb` | Linux | `GTSS-Growth-Engine-<ver>-amd64.deb` |
| Linux x64 | `.rpm` | Linux | `GTSS-Growth-Engine-<ver>-x86_64.rpm` |
| Linux x64 | AppImage | Linux | `GTSS-Growth-Engine-<ver>-x64.AppImage` |
| macOS x64 | `.dmg` | macOS | `GTSS-Growth-Engine-<ver>-x64.dmg` |
| macOS arm64 | `.dmg` | macOS | `GTSS-Growth-Engine-<ver>-arm64.dmg` |

## One-shot release

```bash
# Set GH_TOKEN to a personal access token with `repo` scope.
export GH_TOKEN=ghp_xxxxxxxxxxxx

# Build everything + publish to GitHub Releases.
scripts/release.sh 1.2.3
```

This will:
1. Bump the version in `desktop/package.json`.
2. Tag the repo as `v1.2.3` and push.
3. Build all installer formats (must be run on each target OS in CI).
4. Upload artifacts to the `v1.2.3` GitHub Release.
5. Auto-update feeds (`electron-updater`'s `latest.yml` / `latest-mac.yml` /
   `latest-linux.yml`) are uploaded alongside the artifacts.

> **Note:** In production, the build + publish step is performed by the
> `.github/workflows/release.yml` GitHub Actions matrix (one job per OS), not
> by this script locally — electron-builder cannot cross-compile Windows
> `.exe` from Linux or macOS `.dmg` from Windows reliably.

## Per-platform builds

```bash
scripts/build-windows.sh    # Windows-only
scripts/build-linux.sh      # Linux-only
scripts/build-macos.sh      # macOS-only
scripts/build-all.sh        # Current platform
scripts/build-all.sh --all  # All platforms (cross-compile, unreliable)
```

> **Windows note:** `scripts/build-*.sh` are bash scripts. On a Windows host
> run them from **Git Bash** or **WSL**. CI already forces `shell: bash` in
> `.github/workflows/release.yml`, so tagged releases do not need this.

### Linux desktop notes (Wayland / tray)

The app is designed to keep running in the system tray after the window is
closed. On some Linux desktop environments (especially minimal or
Wayland-only sessions without a tray implementation), the tray icon may not
appear. If the window disappears and you cannot reopen it:

1. Look for a tray / status-area icon for **GTSS Growth Engine**.
2. If none is present, stop the process and relaunch from your applications
   menu: `killall gtss-growth-desktop` (or `killall "GTSS Growth Engine"`),
   then open the app again.

## Code signing

### Windows

To sign the .exe and .msi with an EV / OV cert:

1. Get a code-signing certificate (DigiCert, Sectigo, etc.).
2. Export it as a `.pfx` file.
3. Set env vars:
   ```bash
   export CSC_LINK=file:///path/to/cert.pfx
   export CSC_KEY_PASSWORD=your_cert_password
   ```
4. Run the build — electron-builder signs automatically.

Without signing, Windows SmartScreen will warn users on first launch. This
is expected for an open-source project without a paid cert.

### macOS

To notarize the .dmg (so Gatekeeper doesn't warn users):

1. Enroll in the Apple Developer Program.
2. Create an App-Specific Password for your Apple ID.
3. Set env vars:
   ```bash
   export APPLE_ID=you@example.com
   export APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx
   export APPLE_TEAM_ID=XXXXXXXXXX
   export CSC_LINK=file:///path/to/DeveloperIDApplication.p12
   export CSC_KEY_PASSWORD=your_p12_password
   export NOTARIZE_TEAM_ID=$APPLE_TEAM_ID
   ```
4. Run `scripts/build-macos.sh`.

Without notarization, macOS users will need to right-click → Open the first
time, or run `xattr -dr com.apple.quarantine /Applications/GTSS\ Growth\ Engine.app`.

### Linux

No signing is required for .deb / .rpm / AppImage. AppImage recommends GPG
signing for the `.zsync` update file — see the AppImage docs if you want to
enable AppImageUpdate.

## Auto-update configuration

The app checks for updates automatically on launch via `electron-updater`.
The update feed is configured in `desktop/electron-builder.yml`:

```yaml
publish:
  - provider: github
    owner: Elvinoacer
    repo: gtss_growth_automation
    releaseType: release
```

To switch to a self-hosted update feed (e.g., S3), change the `provider` and
add the corresponding credentials. See the
[electron-updater docs](https://www.electron.build/auto-update).

## CI / CD

A typical GitHub Actions workflow for releases:

```yaml
# .github/workflows/release.yml
name: Release
on:
  push:
    tags: ['v*']
jobs:
  release:
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest, macos-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: cd desktop && npm install
      - run: cd desktop && npx electron-rebuild -f -w better-sqlite3
      - run: cd desktop && npx electron-builder --publish always
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          # macOS notarization:
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_APP_SPECIFIC_PASSWORD: ${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
          CSC_LINK: ${{ secrets.CSC_LINK }}
          CSC_KEY_PASSWORD: ${{ secrets.CSC_KEY_PASSWORD }}
```

Each platform builds and uploads its artifacts to the same GitHub Release
(defined by the git tag).

## Verifying a release

After publishing:

1. Visit the release page on GitHub.
2. Download each artifact and confirm it installs cleanly on a fresh VM.
3. Confirm the `latest.yml`, `latest-mac.yml`, `latest-linux.yml` files are
   present — these are what `electron-updater` reads.
4. Test the auto-update path by installing an older version on a test machine
   and confirming it picks up the new release within ~30 seconds of launch.
