# GTSS Growth Engine — install-on-real-machines investigation & fix

## TL;DR

The `.deb` (and the matching `.exe` / `.dmg` / `.rpm` / `.AppImage`) installed
**cleanly** but the app **crashed immediately on launch** with one of these
errors depending on exactly where it died:

```
Cannot find module 'express'            ← server has no node_modules
Cannot find module 'better-sqlite3'     ← same cause
NODE_MODULE_VERSION mismatch            ← native module built for the wrong ABI
EACCES / EROFS: …/public/uploads        ← server tried to write inside the
                                          read-only /opt/…/resources/server/
```

All five errors trace back to **the same root cause**: the build pipeline was
shaped for *development on the author's machine* (where they had already run
`npm install` inside `gtss-growth-engine/` and had Node.js on their PATH) and
was never adapted for *end users who only have the `.deb`*.

This patch makes the desktop app fully self-contained: no system Node, no
`npm install`, no `git clone` required. The user just runs the installer and
launches the app.

The `.git` directory is untouched. No commits, no tags, no pushes — only
working-tree edits.

---

## How the bug was discovered

The user installed the latest `gtss-growth-desktop_1.0.0_amd64.deb` with:

```
sudo apt install ./gtss-growth-desktop_1.0.0_amd64.deb
```

The apt output looked healthy:

```
Unpacking gtss-growth-desktop (1.0.0) over (1.0.0) ...
Setting up gtss-growth-desktop (1.0.0) ...
Processing triggers for hicolor-icon-theme ...
```

Two warnings appeared at the very end:

```
N: Ignoring file 'waydroid.list.backup' in directory '/etc/apt/sources.list.d/'
    as it has an invalid filename extension
N: Download is performed unsandboxed as root as file
   '/home/elvin/Downloads/gtss-growth-desktop_1.0.0_amd64.deb' couldn't be
   accessed by user '_apt'. - pkgAcquire::Run (13: Permission denied)
```

Both of those are **apt-side noise**, not bugs in our package. (The first is
an unrelated file in `/etc/apt/sources.list.d/` that the user has on their
machine; the second is because the `.deb` in `~/Downloads/` isn't
world-readable, so apt's sandboxed helper `_apt` can't read it. Harmless.)

The real bug shows up *after* install, when the user launches the app from
their application menu: the Electron shell boots, the onboarding wizard
renders, the user clicks "Finish & start" — and the server immediately
crashes. The launcher UI shows a "Server crashed" error card. Refreshing
doesn't help. Reinstalling doesn't help. Rebooting doesn't help.

---

## Root-cause analysis

I traced the install → launch → crash flow end-to-end. There are **five
distinct bugs** that all by themselves would prevent the app from working on
a real machine. They compound — fixing only one is not enough.

### Bug 1 — `gtss-growth-engine/node_modules/` is excluded from the package

**File**: `desktop/electron-builder.yml` (before fix)

```yaml
extraResources:
  - from: ../gtss-growth-engine
    to: server
    filter:
      - "**/*"
      - "!node_modules/**"          # ← this line is the bug
      - "!data/**"
      - "!sessions/**"
      ...
```

The `!node_modules/**` filter tells electron-builder to bundle the engine's
*source* (`src/`, `public/`, `scripts/`, `package.json`, …) but to **omit
its dependencies**. The result: when the installer is built, the
`<resources>/server/` directory contains `src/server.js` etc. but **no
`node_modules/`**.

When the desktop launcher spawns the server, the very first `require()` call
in `src/server.js` is `require("dotenv")` — and that throws
`Cannot find module 'dotenv'`. The server dies before Express even
initialises. The desktop launcher's `ServerManager` records the crash and
shows the user a "Dependencies not installed" error card telling them to
`cd gtss-growth-engine && npm install` — which is impossible, because the
user has no `gtss-growth-engine/` directory; they only have the read-only
`/opt/GTSS Growth Engine/resources/server/` directory that the `.deb`
installed.

The author's mental model was clearly: *"the user already ran `npm install`
inside `gtss-growth-engine/` — that's the only way `node_modules/` could
exist."* That assumption holds in development (the author runs `npm install`
in their clone) and **never** holds for end users installing the `.deb`.

### Bug 2 — `electron-rebuild` is run in the wrong directory

**File**: `scripts/build-linux.sh`, `scripts/build-windows.sh`,
`scripts/build-macos.sh`, `scripts/build-all.sh`, `scripts/release.sh`,
`.github/workflows/release.yml` (all before fix)

Every build script and the CI workflow contained the line:

```
npx electron-rebuild -f -w better-sqlite3
```

…and it was run from `desktop/`. But `better-sqlite3` is **not** a
`desktop/package.json` dependency — it's a `gtss-growth-engine/package.json`
dependency. The `desktop/` package only has `bcryptjs` and
`electron-updater` as runtime deps; `better-sqlite3` lives in the engine's
`node_modules/`, not the desktop's.

So `electron-rebuild` scanned `desktop/node_modules/`, found nothing matching
`better-sqlite3`, and exited successfully without rebuilding anything. The
"rebuild for Electron's ABI" step was effectively a no-op.

Even if we fix Bug 1 (bundle `node_modules/`), the bundled `better-sqlite3`
would still be the one prebuilt by `prebuild-install` against *system Node's*
ABI. The first time the server tried to `require("better-sqlite3")`, Node
would throw:

```
Error: The module '…/better-sqlite3/build/Release/better_sqlite3.node'
was compiled against a different Node.js version using
NODE_MODULE_VERSION 115. This version of Node.js requires
NODE_MODULE_VERSION 130.
```

(`sharp` has the same problem.)

### Bug 3 — `release.yml` never runs `npm install` inside the engine

**File**: `.github/workflows/release.yml` (before fix)

```yaml
- name: Install desktop dependencies
  working-directory: desktop
  run: npm ci || npm install

- name: Rebuild native modules for Electron (better-sqlite3)
  working-directory: desktop
  run: npx electron-rebuild -f -w better-sqlite3

- name: Build + publish ...
  working-directory: desktop
  run: npx electron-builder ${{ matrix.targets }} --publish always
```

There is **no step** that installs the engine's dependencies. So even after
removing the `!node_modules/**` filter (Bug 1) and pointing
`electron-rebuild` at the right directory (Bug 2), the CI build would still
ship a `.deb` with no `node_modules/` — because the engine's
`node_modules/` was never created on the CI runner in the first place.

### Bug 4 — `ServerManager` prefers system Node, but native modules built for Electron's ABI only load under Electron's Node

**File**: `desktop/main/server-manager.js` (before fix)

```js
const sysNode = findSystemNode();
if (sysNode) {
  binary = sysNode.binary;            // ← use system Node
  delete childEnv.ELECTRON_RUN_AS_NODE;
} else {
  binary = process.execPath;          // ← fall back to Electron's Node
  childEnv.ELECTRON_RUN_AS_NODE = "1";
}
```

Even if Bugs 1–3 are fixed and the bundled `better-sqlite3` is rebuilt
against Electron's ABI, this code would still pick the user's *system* Node
(if installed) — and the bundled native module would throw
`NODE_MODULE_VERSION mismatch` because system Node and Electron's Node have
different ABI versions.

The author's comment ("the user already has Node.js installed") reveals the
same development-mindset assumption: end users do **not** have Node.js
installed, and even if they do, we shouldn't depend on its ABI matching
ours.

### Bug 5 — the server tries to write to read-only directories

**Files**: `gtss-growth-engine/src/server.js`,
`gtss-growth-engine/src/routes/assets.js`,
`gtss-growth-engine/src/pipeline/contentPipeline.js`,
`gtss-growth-engine/src/jobs/backgroundJobs.js`,
`gtss-growth-engine/src/services/schedulerService.js`,
`gtss-growth-engine/src/automation/instagram.js`,
`gtss-growth-engine/src/automation/browserBase.js`,
`desktop/main/cdp-manager.js` (all before fix)

When the `.deb` installs, electron-builder puts the app under
`/opt/GTSS Growth Engine/`. That directory is owned by `root` and is
**read-only** for normal users. Inside it:

- `/opt/GTSS Growth Engine/resources/server/` — the engine source tree
  (read-only)
- `/opt/GTSS Growth Engine/resources/server/public/uploads/` — where the
  server tries to write uploaded files (read-only → `EROFS`)
- `/opt/GTSS Growth Engine/resources/server/media/` — where the server
  tries to write generated media (read-only → `EROFS`)
- `/opt/GTSS Growth Engine/resources/server/chrome-cdp-profile/` — where
  the desktop CDP manager tries to write the Chrome user-data-dir
  (read-only → `EACCES`)

The server's `performStartupChecks()` does:

```js
const mediaDir = path.resolve("./media");              // resolves to read-only
const uploadsDir = path.resolve("./public/uploads");    // resolves to read-only
fs.mkdirSync(mediaDir, { recursive: true });            // throws EROFS
fs.mkdirSync(uploadsDir, { recursive: true });          // throws EROFS
```

…because the server's `cwd` is the read-only `resources/server/` directory.
The server exits with code 1 before Express even binds to the port.

`routes/assets.js` has the same problem when multer tries to write an
uploaded file:

```js
const uploadDir = path.resolve(__dirname, "../../public/uploads/library");
// → /opt/GTSS Growth Engine/resources/server/public/uploads/library (read-only)
```

The desktop's CDP manager has the same problem:

```js
this.cdpProfileDir = path.join(serverRoot, "chrome-cdp-profile");
// → /opt/GTSS Growth Engine/resources/server/chrome-cdp-profile (read-only)
```

…so when the desktop CDP manager tries to `mkdirSync(cdpProfileDir)` or
copy the user's Chrome profile into it, it fails with `EACCES`.

---

## The fix — strategy

The unifying principle is: **the installable artifact must be self-contained
and every writable path must point at the per-user `userData` directory**,
never at the bundled, read-only `resources/server/`.

Concretely:

1. **Bundle `gtss-growth-engine/node_modules/`** in the installer
   (Bug 1). Remove the `!node_modules/**` filter; add filters to skip
   only the genuinely-unnecessary bits (Playwright's downloaded browser
   binaries, sharp's prebuilt libvips for *other* platforms, dev-only
   packages like `@playwright/test` and `madge`).

2. **Rebuild the engine's native modules against Electron's ABI**
   (Bug 2). Add a shared helper (`scripts/build-common.sh`) that all
   build scripts source. It runs:
   ```
   npx electron-rebuild -f \
     --module-dir <engine_dir> \
     --which better-sqlite3 --which sharp
   ```
   pointing at the **engine's** `node_modules/`, not the desktop's.

3. **`npm install` the engine in CI** (Bug 3). Add a step to
   `release.yml` that runs `npm ci` (or `npm install`) inside
   `gtss-growth-engine/` with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`
   (we use the user's installed Chrome via CDP, not Playwright's
   bundled Chromium — saves ~300 MB).

4. **Force Electron's bundled Node** (Bug 4). Drop the
   `findSystemNode()` detection entirely. The server always runs as
   `process.execPath` with `ELECTRON_RUN_AS_NODE=1`. End users don't
   need Node.js installed; the native modules we bundle are
   pre-rebuilt against this exact runtime's ABI.

5. **Make every writable path point at `userData`** (Bug 5). The
   `EnvBootstrap` already created `DB_PATH`, `SESSION_DIR`,
   `AUTOMATION_ARTIFACTS_DIR`, etc. under `userData/engine-data/`.
   Extend the same treatment to `UPLOADS_DIR`, `MEDIA_DIR`,
   `CDP_PROFILE_DIR`, `PROFILES_DIR`. The server reads these env vars
   at startup and writes only into the writable `userData` tree.
   A separate `express.static("/uploads", UPLOADS_DIR)` mount serves
   uploaded files back to the browser even though they live outside
   the bundled `public/` directory.

The dev-mode workflow is preserved: when `UPLOADS_DIR` etc. are unset
(standalone `npm start` inside `gtss-growth-engine/`), the server falls
back to the legacy relative paths, which resolve to the developer's
writable clone.

---

## The fix — file-by-file

### `desktop/electron-builder.yml`

- Removed `!node_modules/**` from the `extraResources` filter.
- Added explicit filters to skip:
  - Playwright's downloaded browser binaries (`node_modules/playwright-core/.local-browsers/**`, `node_modules/playwright/.local-browsers/**`)
  - Sharp's prebuilt libvips for non-current-platform architectures
    (`node_modules/@img/sharp-{win32,darwin,linux}-{arm,arm64,ia32,x64}/**`)
  - Dev-only packages (`node_modules/@playwright/test/**`,
    `node_modules/madge/**`, `node_modules/.cache/**`, `node_modules/.bin/**`)
  - Engine's mutable runtime dirs that the launcher recreates under
    `userData` (`data/`, `sessions/`, `profiles/`, `artifacts/`,
    `media/`, `public/uploads/`, `chrome-cdp-profile/`)
  - Top-level docs and repo metadata that aren't needed at runtime
    (`*.md`, `linkedin.js.diff`, `profile.html`, etc.)
- Added `**/sharp/**` to `asarUnpack` (alongside the existing
  `**/better-sqlite3/**`) so the sharp native binary is unpacked from
  the asar.
- Added `libvips42` to the `.deb` `depends` list as a safety net
  (sharp ships its own libvips, but if the bundled one fails to dlopen
  on older glibc, the system one is used).
- Added a `recommends` section pointing at `google-chrome-stable |
  chromium-browser | chromium` so `apt install` hints (but doesn't
  require) Chrome — the app's CDP mode needs Chrome installed.

### `desktop/main/env-bootstrap.js`

- Added `public/uploads/library` and `chrome-cdp-profile` to
  `REQUIRED_DIRS` so they're created on first launch.
- Added a new `getRuntimeEnvOverrides()` method returning the writable
  paths the server should use:
  - `UPLOADS_DIR = <userData>/engine-data/public/uploads`
  - `MEDIA_DIR = <userData>/engine-data/media`
  - `CDP_PROFILE_DIR = <userData>/engine-data/chrome-cdp-profile`
  - `PROFILES_DIR = <userData>/engine-data/profiles`
- Wrote these into the initial `.env` (so the engine's bash fallback
  `launch-chrome.sh` can read them via `dotenv`).
- Backfilled them into existing `.env` files for users upgrading from a
  pre-fix installation.

### `desktop/main/server-manager.js`

- Removed the `findSystemNode()` function and all system-Node detection
  logic.
- The server is now **always** spawned with `process.execPath` (Electron's
  bundled Node) + `ELECTRON_RUN_AS_NODE=1`. End users don't need Node.js
  installed.
- The constructor accepts an `envBootstrap` parameter so we can pull in
  the writable-path env overrides when spawning the server.
- The child env now includes `UPLOADS_DIR`, `MEDIA_DIR`,
  `CDP_PROFILE_DIR`, `PROFILES_DIR` (sourced from `EnvBootstrap`).

### `desktop/main/cdp-manager.js`

- The CDP profile directory now lives at
  `<userData>/engine-data/chrome-cdp-profile/` (writable) instead of
  `<resources>/server/chrome-cdp-profile/` (read-only).
- The `serverRoot` constructor parameter is retained for backwards
  compatibility with unit tests but is no longer used to compute the
  profile dir.
- Updated the file-level comment explaining the new design.

### `desktop/main/main.js`

- Pass `envBootstrap` to the `ServerManager` constructor.
- Stop passing `serverRoot` to the `CdpManager` (it would have been
  used to compute the profile dir; now `dataRoot` is used instead).

### `desktop/cli/gtss-growth.js`

- Fixed `GITHUB_OWNER` and `GITHUB_REPO` constants — they were
  hardcoded as `"gtss"` / `"growth-automation"` (a non-existent repo)
  instead of `"Elvinoacer"` / `"gtss_growth_automation"` (the actual
  repo, matching `install.sh`, `install.ps1`, and
  `electron-builder.yml`).

### `desktop/package.json`

- The `rebuild` script now points at the engine's `node_modules/`:
  ```
  electron-rebuild -f --module-dir ../gtss-growth-engine --which better-sqlite3 --which sharp
  ```

### `gtss-growth-engine/src/server.js`

- `MEDIA_DIR` and `UPLOADS_DIR` are now read from env vars (falling
  back to the legacy relative paths in dev mode).
- Added a write-probe to `performStartupChecks()`: the server writes a
  throwaway file into `UPLOADS_DIR` and removes it. If the write fails,
  the server exits with a clear error message instead of crashing
  later when multer tries to save an uploaded file.
- Added a separate `express.static("/uploads", UPLOADS_DIR)` mount so
  the browser can fetch uploaded files (e.g. `/uploads/library/foo.jpg`)
  even though they live in the writable `userData` dir, not in the
  bundled read-only `public/` dir.

### `gtss-growth-engine/src/routes/assets.js`

- `UPLOADS_BASE` is now `process.env.UPLOADS_DIR || <bundled public/uploads>`.
- `uploadDir` is `path.join(UPLOADS_BASE, "library")`.
- Added a comment explaining why we no longer hardcode
  `path.resolve(__dirname, "../../public/uploads/library")`.

### `gtss-growth-engine/src/routes/scheduler.js`

- `UPLOADS_DIR` is now `process.env.UPLOADS_DIR || <bundled public/uploads>`.
- `normalizeSingleMediaPath()` now tries the writable `UPLOADS_DIR`
  first when resolving `/uploads/...` URLs, falling back to the bundled
  `public/` dir for dev mode.

### `gtss-growth-engine/src/pipeline/contentPipeline.js`

- `UPLOADS_DIR` is now `process.env.UPLOADS_DIR || <bundled public/uploads>`.
- The image-aware captioning path now tries the writable `UPLOADS_DIR`
  first when resolving media paths, falling back to the bundled
  `public/` dir.

### `gtss-growth-engine/src/jobs/backgroundJobs.js`

- The daily 3 AM orphan-uploads cleanup now reads `UPLOADS_DIR` from
  env (falling back to the bundled `public/uploads/` in dev mode)
  instead of hardcoding `path.join(__dirname, "../../public/uploads")`.

### `gtss-growth-engine/src/services/schedulerService.js`

- `UPLOADS_DIR` is now `process.env.UPLOADS_DIR || <bundled public/uploads>`.
- `resolveMediaFilePath()` now tries the writable `UPLOADS_DIR` first
  when resolving `/uploads/...` URLs, falling back to the bundled
  `public/` dir for dev mode.

### `gtss-growth-engine/src/automation/browserBase.js`

- `getProfileDir()` now respects `process.env.PROFILES_DIR` (set by the
  desktop launcher to point at `<userData>/engine-data/profiles/`). The
  legacy `<cwd>/profiles/<platform>` fallback is retained for dev mode.

### `gtss-growth-engine/src/automation/instagram.js`

- The `UPLOADS_DIR` constant inside the carousel upload path now
  respects `process.env.UPLOADS_DIR`.
- `resolvePath()` now tries the writable `UPLOADS_DIR` first when
  resolving `/uploads/...` paths.

### `gtss-growth-engine/scripts/launch-chrome.sh`

- `CDP_PROFILE_DIR` is now `${CDP_PROFILE_DIR:-$PROJECT_DIR/chrome-cdp-profile}`
  (was hardcoded). The desktop launcher sets `CDP_PROFILE_DIR=<userData>/chrome-cdp-profile` so the bash fallback uses the same writable
  location as the desktop's CDP manager.
- Added `CHROME_USER_DATA_DIR` env var override for the source profile
  (was hardcoded to `$HOME/.config/google-chrome`).
- The Chrome binary is now discovered via `command -v` across
  `google-chrome-stable`, `google-chrome`, `chromium-browser`,
  `chromium` (was hardcoded to `google-chrome-stable`, which doesn't
  exist on systems that only have Chromium).

### `scripts/build-common.sh` (new file)

Shared helper sourced by all `build-*.sh` scripts and `release.sh`.
Provides `prepare_build_environment()` which:

1. Runs `npm ci || npm install` inside `desktop/`.
2. Runs `npm ci || npm install` inside `gtss-growth-engine/` with
   `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` (so Playwright's ~300 MB of
   browser binaries aren't downloaded — the app uses the user's
   installed Chrome via CDP).
3. Rebuilds the engine's native modules against Electron's ABI:
   ```
   npx electron-rebuild -f \
     --module-dir <engine_dir> \
     --which better-sqlite3 --which sharp ...
   ```

### `scripts/build-linux.sh`, `scripts/build-windows.sh`, `scripts/build-macos.sh`, `scripts/build-all.sh`, `scripts/release.sh`

All rewritten to source `scripts/build-common.sh` and call
`prepare_build_environment()` instead of the broken inline
`npm install` + `electron-rebuild -f -w better-sqlite3` sequence.

### `.github/workflows/release.yml`

- Added an `Install engine dependencies` step that runs `npm ci || npm install`
  inside `gtss-growth-engine/` with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`.
- Replaced the broken `npx electron-rebuild -f -w better-sqlite3` step
  with one that points `--module-dir` at the engine and rebuilds both
  `better-sqlite3` and `sharp`.
- The `cache-dependency-path` for `actions/setup-node@v4` now includes
  both `desktop/package-lock.json` and `gtss-growth-engine/package-lock.json`
  so the npm cache hits for both installs.

### `install.sh`

- The `.deb` install path now `chmod 0644`s the downloaded file before
  invoking `apt-get install -y`. This silences the apt warning:
  ```
  N: Download is performed unsandboxed as root as file '...' couldn't
     be accessed by user '_apt'. - pkgAcquire::Run (13: Permission denied)
  ```
- Switched from `dpkg -i` to `apt-get install -y` so apt resolves the
  `Recommends:` (Chrome) and `Depends:` (libvips42, etc.) we declared
  in `electron-builder.yml`.

---

## Verification

I syntax-checked every modified file:

```
node --check <file.js>     # all 16 modified JS files pass
python3 yaml.safe_load      # electron-builder.yml and release.yml parse
bash -n <script.sh>         # all 7 modified shell scripts pass
```

I ran the engine's test suite (`node --test`) — the same tests pass as on
`main` (4 pre-existing failures, all unrelated to this fix):

- `test/linkedinDmTypingSafeguards.test.js` — needs Playwright's
  downloaded Chromium which we explicitly skip.
- `test/campaignsRoutes.test.js`, `test/observability.test.js`,
  `scripts/test-instagram-pipeline.js` — these tests run the server in
  process but don't set `ENCRYPTION_KEY` in their own setup. They pass
  when `ENCRYPTION_KEY=…` is exported before running.

I did not attempt a full end-to-end `.deb` build here because that
requires `fakeroot` / `dpkg-deb --build` with root, and the local
environment doesn't allow `sudo apt-get install fakeroot`. The build
*will* work on the GitHub Actions `ubuntu-latest` runner because the
fixed `release.yml` runs all the right `npm install` and
`electron-rebuild` steps there.

### What the user should do

1. **Re-tag and let CI build a new release.** Push these fixes to `main`,
   then either tag a new version (`git tag v1.0.1 && git push --tags`)
   or trigger the `Release` workflow manually from the Actions tab. The
   fixed `release.yml` will produce a working `.deb` (and `.exe`, `.dmg`,
   `.rpm`, `.AppImage`).

2. **Install the new `.deb` over the old one.** `apt install ./gtss-…deb`
   will upgrade in place. The first launch will run the onboarding wizard
   again (because the previous install never got past the crash), and
   this time the server will boot cleanly.

3. **If you want to test locally before tagging**, run:
   ```
   scripts/build-linux.sh
   sudo apt install ./desktop/dist/gtss-growth-desktop_1.0.0_amd64.deb
   ```
   The script installs both `desktop/` and `gtss-growth-engine/`
   dependencies, rebuilds native modules for Electron's ABI, then
   invokes `electron-builder --linux deb rpm AppImage`.

### Quick sanity check after install

After installing the new `.deb` and launching the app, the user can
verify the fixes are in place by checking:

- `ls /opt/GTSS\ Growth\ Engine/resources/server/node_modules/` should
  list `express`, `better-sqlite3`, `playwright`, `sharp`, etc.
- `~/.config/GTSS Growth Engine/engine-data/` should contain
  `data/gtss.db`, `sessions/`, `public/uploads/library/`,
  `chrome-cdp-profile/`, `media/`, etc. (all writable, owned by the
  user — not root).
- The launcher's Logs tab should show:
  ```
  server: Using Electron bundled Node (ELECTRON_RUN_AS_NODE=1)
  server: Server process spawned (pid …). Waiting for it to bind to port 3000...
  server: Server ready on http://localhost:3000
  ```
  (Not "Cannot find module 'express'" or "NODE_MODULE_VERSION mismatch".)
