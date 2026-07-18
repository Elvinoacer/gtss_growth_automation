# GTSS Growth Engine — Desktop App

Minimal Electron launcher for the gtss-growth-engine backend.

**Design philosophy:** the web app at `localhost:3000` IS the application.
This launcher is a small companion that does only what the web app can't do
for itself: start/stop the Node.js server, surface status, show logs, and
auto-update. All settings, platform logins, dashboards, and automation
live in the web app — this window intentionally does NOT duplicate them.

## Layout

```
desktop/
├── main/                    # Electron main process (Node.js)
│   ├── main.js              # Entry point — creates windows, tray, IPC
│   ├── server-manager.js    # Spawns + supervises gtss-growth-engine
│   ├── cdp-manager/         # Cross-platform port of launch-chrome.sh
│   │   └── index.js
│   ├── lifecycle.js         # High-level start/stop orchestration
│   ├── log-stream.js        # In-memory log ring buffer
│   ├── first-run.js         # Onboarding wizard logic
│   ├── auto-updater.js      # electron-updater wrapper
│   ├── env-bootstrap.js     # Generates .env, ENCRYPTION_KEY, dirs
│   ├── secure-write.js      # Owner-only file writes (POSIX + Windows ACL)
│   ├── bridge-server/       # Localhost-only HTTP bridge for the web app
│   └── ipc-handlers/        # Bridges renderer ↔ main
│       └── index.js
├── preload/
│   └── preload.js           # Security boundary — exposes window.gtss.*
├── renderer/                # UI (HTML/CSS/JS, no framework)
│   ├── index.html           # Control center
│   ├── onboarding.html      # First-run wizard
│   ├── styles.css           # Shared styles
│   ├── onboarding.css       # Onboarding-specific styles
│   ├── renderer.js          # Control center logic
│   └── onboarding.js        # Onboarding logic
├── cli/
│   └── gtss-growth.js       # npm global bin (developer install path)
├── build/                   # Icons + macOS entitlements
├── electron-builder.yml     # Build config for all 6 installer formats
├── package.json             # Electron + dev dependencies
└── README.md                # This file
```

## Dev workflow

```bash
cd desktop
npm install           # installs electron, electron-builder, electron-updater
npm run rebuild       # rebuilds better-sqlite3 for Electron's ABI
npm run dev           # launches Electron with --dev flag (opens DevTools)
```

The dev mode loads the server from `../gtss-growth-engine/` (sibling folder).
The server must have its own `node_modules` installed:

```bash
cd ../gtss-growth-engine
npm install
npx playwright install chromium
```

## How the server is launched

`ServerManager.start()` **always** spawns the server under Electron's
bundled Node.js via `ELECTRON_RUN_AS_NODE=1` — never the system `node` on
PATH. This is intentional:

1. **End users do not have Node.js installed.** Native installers
   (`.deb` / `.exe` / `.dmg`) ship the full engine; requiring a system
   Node would break every non-developer install.
2. **Native modules are rebuilt for Electron's ABI.** Build scripts run
   `electron-rebuild` against `gtss-growth-engine/node_modules/` so
   `better-sqlite3` / `sharp` load under Electron's `NODE_MODULE_VERSION`.
   Spawning with a system Node would throw `NODE_MODULE_VERSION mismatch`.
3. **One deterministic runtime** eliminates "works on my machine" version
   skew across user machines.

If a power user wants to run the server under their own Node (e.g. for
`node --inspect` debugging), they can clone the repo and run `npm start`
inside `gtss-growth-engine/` directly.

The child's `cwd` is the gtss-growth-engine source root (read-only when
packaged), so all of the server's `path.join(__dirname, "..", "public")`
references resolve to the bundled static frontend. Writable state
(uploads, media, DB, sessions, `.env`) is pointed into `userData` via env
vars — see `EnvBootstrap.getRuntimeEnvOverrides()`.

**Env injection:** `ServerManager` loads `DATA_ROOT/.env` (the file
onboarding generated) and injects every key into the child's process env.
It also sets `DOTENV_CONFIG_PATH` and `GTSS_ENV_PATH` to that same path so
runtime writes from settings routes (passphrase change, pipeline flags)
hit the writable file, not the read-only bundled tree. Process env vars
take precedence over dotenv-loaded vars, so our `ENCRYPTION_KEY`,
`PASSPHRASE_HASH`, `GEMINI_API_KEY`, etc. always win. We also force
`DB_PATH`, `SESSION_DIR`, `UPLOADS_DIR`, `MEDIA_DIR`, `CDP_PROFILE_DIR`,
`PROFILES_DIR`, and related path keys into `DATA_ROOT`.

**Crash diagnostics:** when the server exits with a non-zero code,
`ServerManager` scans the last 200 stderr lines for known error signatures
(ABI mismatch, port in use, missing module, missing config) and produces a
friendly `lastDiagnostic` object the UI renders as an error card with a
"Try again" button and a "Copy logs for support" button.

## How CDP Chrome is launched

`CdpManager` is a cross-platform port of
[`gtss-growth-engine/scripts/launch-chrome.sh`](../gtss-growth-engine/scripts/launch-chrome.sh).
It:

1. Locates the user's installed Google Chrome (Windows / macOS / Linux).
2. On first launch: copies their `Default` profile (minus cache dirs) into
   `<userData>/chrome-cdp-profile/` — so they stay logged into LinkedIn, X,
   Facebook, Instagram.
3. Spawns Chrome with `--remote-debugging-port=9222 --user-data-dir=<that dir>`.
4. Waits for the CDP port to accept connections.
5. Writes `CDP_ENDPOINT=http://127.0.0.1:9222` and `BROWSER_MODE=cdp` into
   the .env so the server connects to the running Chrome.

If Chrome is not installed, the manager logs an error and the server falls
back to `BROWSER_MODE=persistent` (Playwright launches its own Chromium).
We intentionally do NOT bundle Chrome — it would balloon the installer size
and violate Google's distribution terms.

## IPC channels

The renderer talks to the main process exclusively through `window.gtss.*`,
exposed by `preload/preload.js`. Each method maps 1:1 to an
`ipcMain.handle` channel in `main/ipc-handlers/`.

| Channel | Purpose |
|---------|---------|
| `lifecycle:start` / `stop` / `restart` / `status` | High-level orchestration |
| `server:start` / `stop` / `status` | Server-only controls |
| `cdp:start` / `stop` / `status` | CDP-only controls |
| `app:open-in-browser` | Open the app URL in the default browser |
| `logs:snapshot` / `clear` + `logs:line` (event) | Log streaming |
| `onboarding:status` / `complete` / `open-login` | First-run wizard |
| `settings:get` / `update` / `reset-passphrase` | Read/write .env |
| `updater:status` / `check` / `download` / `install` + `updater:state` (event) | Auto-update |
| `open:data-folder` / `open:logs-folder` | Open in OS file explorer |

## Security

- `contextIsolation: true` — the renderer cannot touch Node directly.
- `nodeIntegration: false` — no `require` in the renderer.
- `sandbox: true` — additional Chromium sandboxing.
- The preload script is the only thing that can call `ipcRenderer`, and it
  exposes a tightly-whitelisted `window.gtss` API.
- All user secrets (passphrase hash, Gemini key, Gmail creds) live in the
  `.env` file inside `userData`. On POSIX they are written with `0o600`
  permissions; on Windows, `secure-write.js` additionally runs `icacls` to
  strip inherited ACLs and grant only the current user full control. Secrets
  never enter the renderer, never get logged, and never get sent over IPC.
- The main Express server and the bridge server both bind to `127.0.0.1`
  only — nothing is exposed on the LAN.

## Building installers

From this directory:

```bash
npx electron-builder --win nsis msi          # Windows
npx electron-builder --linux deb rpm AppImage # Linux
npx electron-builder --mac dmg                # macOS
```

Or use the top-level helper scripts (bash — on Windows use Git Bash or WSL;
CI already forces `shell: bash`):

```bash
../scripts/build-windows.sh
../scripts/build-linux.sh
../scripts/build-macos.sh
```

Output goes to `desktop/dist/`. See [`DISTRIBUTION.md`](../DISTRIBUTION.md)
for the full release process.
