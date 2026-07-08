# GTSS Growth Engine

Local-first social-media growth and outreach automation for SMEs. Runs entirely
on your computer — your data never leaves your machine.

This repository contains:

- **`gtss-growth-engine/`** — the Node.js + Express + Playwright backend that
  does lead discovery, qualification, message generation, and outreach.
- **`desktop/`** — the Electron desktop launcher that wraps the server in a
  consumer-grade graphical experience. No terminal required after installation.
- **`install.sh`** / **`install.ps1`** — universal installers (curl | bash on
  macOS/Linux, PowerShell on Windows).
- **`scripts/`** — build and release scripts for native installers
  (.exe, .msi, .deb, .rpm, .AppImage, .dmg).

For non-technical users, the recommended path is the native installer — see
[Distribution](#distribution) below. Developers can clone this repo and run
the Electron app directly.

---

## Quick start (non-technical users)

1. Download the installer for your platform from the
   [Releases page](https://github.com/Elvinoacer/gtss_growth_automation/releases):
   - **Windows:** `GTSS-Growth-Engine-Setup-x64.exe`
   - **macOS:** `GTSS-Growth-Engine-x64.dmg` (Intel) or
     `GTSS-Growth-Engine-arm64.dmg` (Apple Silicon)
   - **Linux:** `GTSS-Growth-Engine-x64.AppImage` (or `.deb` / `.rpm`)
2. Run the installer.
3. Launch **GTSS Growth Engine** from your Start Menu / Applications folder /
   AppImage.
4. The first-launch wizard walks you through setting a passphrase and a Gemini
   API key. After that, click **Start** — the app opens in your default
   browser.

You never need to touch a terminal.

---

## Quick start (developers)

```bash
# 1. Clone and install the backend.
git clone https://github.com/Elvinoacer/gtss_growth_automation.git
cd gtss_growth_automation/gtss-growth-engine
npm install
npx playwright install chromium
npm run setup  # generates .env with a default passphrase

# 2. Install the desktop wrapper.
cd ../desktop
npm install

# 3. Run the Electron app in dev mode.
npm run dev
```

The first time you launch, the onboarding wizard will prompt you to set a real
passphrase and a Gemini API key.

---

## Distribution

### One-time installation methods

| Method | Audience | Command |
|--------|----------|---------|
| Native installer (.exe / .dmg / .deb / .AppImage / .rpm) | **Non-technical users** (recommended) | Download from [Releases](https://github.com/Elvinoacer/gtss_growth_automation/releases) |
| `curl` installer (macOS / Linux) | Power users | `curl -fsSL https://gtss.dev/install.sh \| bash` |
| PowerShell installer (Windows) | Power users | `iwr -UseBasicParsing https://gtss.dev/install.ps1 \| iex` |
| `npm install -g gtss-growth-desktop` | Developers | Installs CLI; on first run, downloads the native installer |

The `curl` and PowerShell installers detect your OS and download the right
native installer from GitHub Releases. If that fails (e.g., GitHub is
unreachable or no installer exists for your platform), they fall back to
`npm install -g` — which requires Node.js to be installed.

### Building native installers

```bash
# Build for the current platform (run on each target OS in CI).
scripts/build-all.sh

# Or build a specific platform:
scripts/build-windows.sh    # must run on Windows
scripts/build-linux.sh      # must run on Linux
scripts/build-macos.sh      # must run on macOS

# Publish a new release to GitHub Releases:
GH_TOKEN=ghp_xxx scripts/release.sh 1.2.3
```

All six installer formats are configured in
[`desktop/electron-builder.yml`](desktop/electron-builder.yml):

- **Windows:** NSIS `.exe` + MSI (per-user, no admin required)
- **Linux:** `.deb` + `.rpm` + `.AppImage`
- **macOS:** `.dmg` (Intel + Apple Silicon)

Auto-update is wired up via `electron-updater`. After the first launch, the app
silently checks for new releases on every start and prompts the user to install
when one is available.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Electron desktop app (desktop/)                                 │
│                                                                  │
│  ┌─────────────────┐   IPC   ┌──────────────────────────────┐   │
│  │  Renderer (UI)  │◄──────►│  Main process                │   │
│  │  - Control panel│         │  - ServerManager             │   │
│  │  - Onboarding   │         │  - CdpManager                │   │
│  │  - Logs viewer  │         │  - Lifecycle orchestrator    │   │
│  │  - Settings     │         │  - FirstRun wizard           │   │
│  └─────────────────┘         │  - AutoUpdater               │   │
│                              └────────────┬─────────────────┘   │
└───────────────────────────────────────────┼──────────────────────┘
                                            │ spawn
                                            ▼
                              ┌──────────────────────────┐
                              │  gtss-growth-engine/     │
                              │  (Node.js + Express)     │
                              │  ┌────────────────────┐  │
                              │  │ HTTP API + Web UI  │  │  ◄── user opens
                              │  │  on localhost:3000 │  │      in default browser
                              │  └────────────────────┘  │
                              │  ┌────────────────────┐  │
                              │  │ Background jobs    │  │
                              │  │  (cron, pipelines) │  │
                              │  └────────────────────┘  │
                              │  ┌────────────────────┐  │
                              │  │ Playwright (CDP)   │──┼──► Chrome with
                              │  │  → localhost:9222  │  │    --remote-debugging-port
                              │  └────────────────────┘  │
                              └──────────────────────────┘
```

The Electron app spawns the Node.js server as a child process using
`ELECTRON_RUN_AS_NODE=1`, so the bundled Electron binary doubles as the
Node.js runtime — no separate Node.js install is needed on the user's
machine. `better-sqlite3` is rebuilt against Electron's ABI at build time
via `electron-builder install-app-deps`.

### Data location

All mutable state lives in `userData` (per platform):

- **Windows:** `%APPDATA%\GTSS Growth Engine\engine-data\`
- **macOS:** `~/Library/Application Support/GTSS Growth Engine/engine-data/`
- **Linux:** `~/.config/GTSS Growth Engine/engine-data/`

That includes the SQLite database, sessions, browser profiles, automation
artifacts, and the `.env` file with the user's secrets. The app survives
updates without losing data.

---

## Documentation

- [System requirements spec](docs.md) — the original product spec.
- [Engine checklist](gtss-growth-engine/CHECKLIST.md) — end-to-end verification
  checklist for the backend.
- [Distribution guide](DISTRIBUTION.md) — release process, signing, notarization.
- [Desktop app README](desktop/README.md) — Electron-specific dev docs.

---

## License

ISC. See `gtss-growth-engine/package.json`.
