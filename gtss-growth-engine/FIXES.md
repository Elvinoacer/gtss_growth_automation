# LinkedIn DM Automation Fix — 2026-06-30

## Symptom

When the automation encountered a LinkedIn profile that requires Premium to
message, the run aborted with:

```
[10:54:13] WARN  LinkedIn Premium required to message this profile
[10:54:14] ERROR Unexpected error: EACCES: permission denied, mkdir '/var/log/gtss/automation'
[10:54:14] STATE Executor error: EACCES: permission denied, mkdir '/var/log/gtss/automation'
[10:54:14] ERROR Executor error: EACCES: permission denied, mkdir '/var/log/gtss/automation'
```

The next 35 runnable actions were never attempted.

## Root Cause

`AUTOMATION_ARTIFACTS_DIR` was set to `/var/log/gtss/automation` — a path
the non-root process cannot create. That alone shouldn't be fatal, but
several code paths called `fs.mkdirSync(dir, { recursive: true })` WITHOUT
a try/catch, and one of them was inside a `finally` block.

The cascade was:

1. `sendDirectMessage` correctly detected `premium_required` and prepared
   to `return { outcome: "premium_required", ... }`.
2. The function's `finally` block ran `diag.flush(profileUrl)`.
3. `flush()` (in `src/automation/linkedinDiagnostics.js`) called
   `fs.mkdirSync('/var/log/gtss/automation', { recursive: true })` —
   **outside any try/catch**.
4. The throw escaped the `finally` and **replaced the original
   `premium_required` return value** with an EACCES exception.
5. The executor's inner `catch` block caught it, then called
   `captureFailureArtifact()` to take a failure screenshot.
6. `captureFailureArtifact` → `artifactPath` → `getArtifactsDir` →
   another unwrapped `fs.mkdirSync` on the same path → threw EACCES
   again, **escaping the catch block**.
7. The exception hit the outer executor `catch` (line 1321) which
   emitted `Executor error: ...` and **aborted the entire run**.

So the bug was NOT "Premium account stops the automation" — that part
was already handled correctly by the executor (premium_required is in
the `NON_RETRYABLE_OUTCOMES` set, the fingerprint is released, and the
loop continues). The bug was the unwritable artifacts directory causing
a cascade that aborted the run on the very first Premium-blocked profile.

## Fixes Applied

### 1. `src/automation/linkedinDiagnostics.js`
- New `resolveArtifactsDir()` helper that tries the configured dir, then
  falls back to `./artifacts/automation` under the process cwd.
- `flush()` is now fully wrapped — mkdir failures are logged and the
  function returns null. The original `premium_required` outcome is no
  longer masked.
- `capture()` screenshot path now uses the same resolver.

### 2. `src/automation/browserBase.js`
- `getArtifactsDir()` now falls back to `./artifacts/automation` if the
  configured dir is unwritable, instead of throwing.
- `getLocksDir()` is now also wrapped — same pattern.
- `captureFailureArtifact()` now wraps the `artifactPath()` call in a
  try/catch so a screenshot failure can never escape.

### 3. `src/automation/executor.js`
- The inner `catch` block (action loop) now wraps `captureFailureArtifact`
  in its own try/catch. If the screenshot fails for any reason, the
  original automation error is still recorded and the loop continues.
- The `if (outcomeObj.outcome === "failed")` branch also wraps its
  `captureFailureArtifact` call.

### 4. `src/automation/instagram.js`
- `getInstagramDebugDir()` now falls back to
  `./artifacts/automation/instagram-debug` if the configured dir is
  unwritable.

### 5. `src/automation/geminiWeb.js`
- Replaced the `ARTIFACTS_DIR` constant with a `getArtifactsDir()`
  function that tries the configured dir, then falls back to
  `./artifacts/automation`. All three call sites updated.

### 6. `test/linkedinDiagnosticsFlush.test.js` (new)
- Regression test that sets `AUTOMATION_ARTIFACTS_DIR` to an unwritable
  path, calls `diag.flush()`, and verifies it does not throw and does
  not mask the original `premium_required` outcome.

## Recommendations for your env

You have two options:

### Option A (recommended): keep debug logs in a writable location

Change your `.env`:

```env
AUTOMATION_ARTIFACTS_DIR=./artifacts/automation
```

This is the default and works for any non-root process. Diagnostics
snapshots and failure screenshots will be written under the project
directory.

### Option B: keep /var/log but pre-create the directory

If you really want logs in `/var/log/gtss/automation`:

```bash
sudo mkdir -p /var/log/gtss/automation
sudo chown -R $USER:$USER /var/log/gtss
```

With the fix applied, the automation will ALSO auto-fall back to
`./artifacts/automation` if `/var/log/gtss/automation` is still
unwritable at runtime — so the run will never abort because of a
filesystem permission issue again.

---

# LinkedIn DM Typing & Wrong-Recipient & Stray-Tab Fix — 2026-06-30 (round 2)

## Symptoms

1. **"Type like human" fails**: LinkedIn messaging inbox opens, cursor
   focuses on the message area, but the typed text never lands in the
   composer. The send falls back to Enter / Control+Enter which also fail.

2. **Wrong-recipient paste (CRITICAL)**: When sending to Mike, the editor
   gets pasted a message that starts with "Hi Letrise," — i.e. the
   PREVIOUS recipient's message is being pasted into the current
   recipient's composer. This is the worst possible bug for an outreach
   tool because it sends the wrong name to the wrong person.

3. **Stray `/job-posting` new tab**: Periodically a new tab opens to a
   URL like `https://www.linkedin.com/hiring/jobs/job-posting/...` or
   `https://www.linkedin.com/talent/job-posting-redirect/...`. This
   derails the automation flow and pollutes the shared CDP context.

## Root Causes

### Wrong-recipient paste — stale OS clipboard + LinkedIn draft persistence

The DM typing pipeline was:

1. `page.keyboard.insertText(value)` — primary path (atomic CDP command).
2. `pasteTextViaClipboard()` — fallback. Writes `value` to the OS clipboard
   via `navigator.clipboard.writeText()`, then presses `Meta+V` to paste.
3. `setEditorTextWithDomEvents()` — last-resort DOM mutation.

In CDP-attached background-tab sessions, `navigator.clipboard.writeText()`
can resolve successfully WITHOUT actually updating the OS clipboard
(`document.hasFocus()` may be patched to `true` but the real OS focus
may not have transferred). The next `Meta+V` then pastes whatever the
OS clipboard ACTUALLY contains — which is the PREVIOUS recipient's
message ("Hi Letrise..."). This is the source of the wrong-recipient
paste.

Compounding factor: LinkedIn persists DM drafts server-side. If Letrise's
send failed and left "Hi Letrise..." in the composer, Mike's composer
opens WITH "Hi Letrise..." already populated. The old `typeLikeHuman`
only cleared the draft IF `getEditableText()` returned non-empty AND used
a single `Meta+A+Delete` that could be defeated by focus landing on a
sibling field (search box, recipient input).

### "Type like human" fails

The `page.keyboard.insertText()` primary path is silent on failure —
when React's composer rejects it (e.g. because the editor lost focus
mid-typing, or React's controlled-component state was out of sync),
there's no error, just no text. The clipboard fallback then runs into
the stale-clipboard problem above. There was no per-character typing
fallback that would dispatch real keydown/keypress/keyup events.

### Stray `/job-posting` tab

LinkedIn's own JS auto-redirects/spawns tabs to
`/talent/job-posting-redirect/` when a Premium upsell dialog is dismissed
or left open. The repo had a polling-based `closeStrayTabs()` that ran
after each DM, but:

- `scripts/launch-chrome.sh` passed `--disable-popup-blocking`, allowing
  every popup to open.
- No `context.on('page', ...)` interceptor existed, so popups that opened
  BETWEEN cleanup runs (during cooldown delays, or while a Premium dialog
  auto-dismissed) survived until the next iteration.
- `dismissPremiumDialog` used `click({ force: true })` which could be
  intercepted by the fixed nav bar (landing on the "Hire with AI"
  `target="_blank"` anchor) and never recovered from a post-dismissal
  redirect.

## Fixes Applied

### `src/automation/linkedin.js`

1. **`pasteTextViaClipboard` — clipboard read-back verification**
   - Write `""` first to flush stale content.
   - Write `value`.
   - READ THE CLIPBOARD BACK via `navigator.clipboard.readText()`.
   - Only if `readBack === value` do we press `Meta+V`.
   - Otherwise we skip `Meta+V` entirely (would have pasted stale content)
     and fall straight through to the synthetic paste fallback, which
     uses `value` directly. This is the primary fix for the
     "Hi Letrise → Mike" bug.

2. **New `forceClearDmDraft(page, locator, { maxAttempts: 3 })` helper**
   - Activates the editor (trusted click + focus).
   - Reads current text.
   - If non-empty, performs `Meta+A → Delete` (strategy A), then
     DOM-level `selectAll + delete` (strategy B), then hard
     `innerHTML = ""` + React `input` event (strategy C).
   - Returns `true` only when the editor is verifiably empty.

3. **`typeLikeHuman` — uses `forceClearDmDraft` + adds per-character typing fallback**
   - Step 2 now calls `forceClearDmDraft` and ABORTS typing if the
     draft couldn't be cleared (better to fail than send wrong draft).
   - New Step 4: per-character `page.keyboard.type(char)` with 15-55 ms
     human-like jitter, with `Shift+Enter` for newlines. This dispatches
     real keydown/keypress/keyup events that React handles natively —
     no clipboard involvement, no stale content risk. This is the
     "type like human" the user expected.
   - Clipboard fallback (Step 5) and DOM-events fallback (Step 6)
     remain as last resorts.

4. **`sendDirectMessage` post-typing anti-wrong-recipient guard**
   - After typing, scan the editor text for ANY greeting name
     (e.g. "Hi X," "Hey Y," "Hello Z,").
   - If the editor contains a greeting to a DIFFERENT name than the
     intended recipient's, ABORT the send and force-clear the editor.
   - This is the last line of defense before the Send button is clicked.

5. **`dismissPremiumDialog` — redirect recovery**
   - Records the page URL BEFORE dismissing.
   - Uses DOM-level `el.click()` instead of `click({ force: true })` to
     avoid coordinate-based nav interception.
   - After dismissal, if the URL changed to a non-`/in/` page,
     navigates back to the original URL.

### `src/automation/browserBase.js`

6. **New `installStrayTabInterceptor(context, platform)`**
   - Registers a `context.on('page', ...)` handler that fires the
     MOMENT a new tab/popup is created.
   - Waits briefly for the popup's URL to settle (popups often start at
     `about:blank` and navigate within ~500 ms).
   - If the URL matches a stray pattern, closes the popup immediately.
   - Idempotent: calling twice on the same context replaces the
     previous handler (tagged on `context.__gtssStrayTabHandler`).

7. **New `isStrayTabUrl(url)` helper** — shared URL classifier used by
   both `closeStrayTabs` and `installStrayTabInterceptor`.

8. **`createBrowser` (CDP path)** — calls `installStrayTabInterceptor`
   right after `closeStrayTabs`, so the context has both proactive
   (event-driven) and reactive (polling) coverage.

### `scripts/launch-chrome.sh`

9. **Removed `--disable-popup-blocking`** — this flag was allowing every
   `window.open()` call from LinkedIn's React to succeed. Without it,
   Chrome's default popup blocker suppresses popups that aren't
   triggered by user gesture, which is exactly what we want for
   automation.

## Tests Added

New file: `test/linkedinDmTypingSafeguards.test.js` (9 tests, all pass):

1. `forceClearDmDraft` clears a stale "Hi Letrise" draft.
2. `forceClearDmDraft` returns true when editor is already empty.
3. `typeLikeHuman` clears stale draft and types the new (correct)
   message — verifies "Hi Letrise" is NOT in the editor after typing
   Mike's message.
4. `typeLikeHuman` rejects empty text.
5. `isStrayTabUrl` correctly classifies known stray and non-stray URLs.
6. `installStrayTabInterceptor` closes a popup navigating to
   `/talent/job-posting-redirect`.
7. `installStrayTabInterceptor` does NOT close a popup navigating to
   a `/in/` profile URL.
8. `installStrayTabInterceptor` is idempotent.
9. `closeStrayTabs` closes `/job-posting` tabs and preserves the
   `/in/` profile tab.

## Defense-in-Depth Summary

The wrong-recipient bug now has FOUR independent guards:

| # | Guard | Location | Triggers when |
|---|-------|----------|---------------|
| 1 | Pre-flight identity check (leadName vs profile h1) | `sendDirectMessage` step 0a (Check A) | leadName provided |
| 2 | Pre-flight content check (greeting name vs profile h1) | `sendDirectMessage` step 0a (Check B) | message has greeting + profile name detected |
| 3 | `forceClearDmDraft` before typing | `typeLikeHuman` step 2 | ALWAYS — editor must be empty before typing |
| 4 | Post-typing anti-wrong-recipient scan | `sendDirectMessage` step 6a.1 | message has greeting |

The stray-tab bug now has THREE independent guards:

| # | Guard | Location | Triggers when |
|---|-------|----------|---------------|
| 1 | `--disable-popup-blocking` removed | `launch-chrome.sh` | Always (Chrome default popup blocker active) |
| 2 | Proactive `context.on('page')` interceptor | `installStrayTabInterceptor` in `createBrowser` | On every new tab creation |
| 3 | Reactive `closeStrayTabs` poll | `executor.js`, `dmQueue.js`, `connectionQueue.js` | After every DM/connection action |


---

# Launcher + Pipeline State Recovery — 2026-07-06

## Symptoms

1. **Desktop launcher opens the web URL too early.** Clicking Start in the
   Electron launcher immediately opened `http://localhost:3000` in CDP Chrome
   BEFORE the Node.js server had bound to the port. The user saw a
   "This site can't be reached / Connection refused" page on every launch
   until they manually refreshed.

2. **A second DevTools window popped up on `npm run dev`.** This was
   distracting when the developer just wanted a hot-reload of the renderer.

3. **Pipelines got stuck on "Running" forever.** When a runner died
   silently (unhandled rejection inside a long browser automation step,
   OOM kill, sync crash, etc.) without ever calling
   `markExecutionFailed` / `markExecutionCompleted`, the execution row
   stayed `running` in DB and `ACTIVE_EXECUTIONS` kept the pipeline
   locked forever. The user-facing buttons made it worse:
   - **Retry Failed Step** returned `400 "No failed stage found. Specify
     'stage' in the request body."` because the dead runner never recorded
     a `failed_stage`.
   - **Resume from Checkpoint** returned `409 "Another execution is
     already running."` because `pipelineState.getActiveExecution(id)`
     still returned the dead execution.
   - **Stop** did nothing because the runner wasn't there to read the
     abort flag.

## Root Causes

- `lifecycle.startAll()` started CDP Chrome WITH the web app URL as a
  launch argument, then started the server afterwards. There was no
  ordering guarantee, so Chrome always won the race.
- `main.js` unconditionally called `mainWindow.webContents.openDevTools`
  whenever `--dev` was passed.
- `pipelineStateService` had no escape hatch for stuck executions. The
  only cleanup was `recoverOnStartup()`, which only fires on server boot.
- `routes/pipelines.js` `retry-stage` endpoint refused to proceed when
  no `stage` was passed and the execution had no recorded `failed_stage`.
- `routes/pipelines.js` `resume-from-checkpoint` endpoint refused to
  proceed whenever `getActiveExecution(id)` returned truthy, regardless
  of whether the active execution was actually making progress.

## Fixes

### Desktop launcher

- **`desktop/main/lifecycle.js`** — Reordered `startAll()`: the server is
  started FIRST and we block on `ServerManager.waitForPort()` before
  launching CDP Chrome. Chrome is launched WITHOUT a URL argument; the
  web app URL is opened in a new tab via the CDP HTTP API only AFTER both
  Chrome and the server are ready.
- **`desktop/main/server-manager.js`** — `waitForPort()` now accepts an
  optional `onProgress` callback that emits a "Still waiting for port N
  (Xs elapsed)..." log every 5s. The launcher UI shows this in the Logs
  tab so a long boot (e.g., DB migration) doesn't look silently hung.
- **`desktop/main/main.js`** — DevTools is now opt-in. It only auto-opens
  on `--dev` if the env var `OPEN_DEVTOOLS_ON_START=1` (or `true`/`yes`/`on`)
  is set. The standard Electron keyboard shortcut Ctrl/Cmd+Shift+I still
  works regardless.
- **`desktop/main/ipc-handlers.js`** + **`desktop/preload/preload.js`** —
  New IPC channel `lifecycle:open-devtools` (exposed as
  `window.gtss.lifecycle.openDevtools()`) opens DevTools on demand in a
  detached window.
- **`desktop/renderer/index.html`** + **`desktop/renderer/renderer.js`** —
  New "Open DevTools" button in the Advanced controls section. The Stop
  button is now enabled during the `starting` state so the user can
  cancel a slow boot instead of waiting for the 30s port timeout.
  Updated the "starting" status meta text to point users at the Logs tab
  for live progress.

### Pipeline state recovery

- **`gtss-growth-engine/src/services/pipelineStateService.js`** — New
  `forceClearExecution(pipelineId, reason)` function. It:
  1. Marks the active execution row as `failed` with a clear
     `error_message` recording that it was force-cleared.
  2. Clears `ACTIVE_EXECUTIONS` / `ABORT_FLAGS` / `PAUSE_FLAGS` for the
     pipeline.
  3. Resets the schedule-level `current_state` to `idle` and
     `current_execution_id` to NULL.
  4. Sweeps the DB for any orphaned `running`/`paused`/etc. executions
     even if the in-memory map is already empty (covers the case where
     the server restarted without running `recoverOnStartup`).
  5. Broadcasts a `pipeline:status` event so the UI flips back to
     "failed" / "idle" immediately.
- **`gtss-growth-engine/src/routes/pipelines.js`**:
  - **New endpoint** `POST /api/pipelines/:id/force-clear` — calls
    `forceClearExecution`. Body: `{ reason?: string }`.
  - **`POST /api/pipelines/:id/retry-stage`** — when no `stage` is
    provided AND the execution has no recorded `failed_stage`, defaults
    to the FIRST stage of the pipeline (i.e., start over). Removes the
    previous "specify stage in the reset body" dead-end.
  - **`POST /api/pipelines/:id/resume-from-checkpoint`** — accepts
    `{ force: true }` in the body. If a stuck execution is found, it is
    force-cleared before the resume proceeds. Without `force: true`, the
    endpoint returns a 409 with `hint: 'force_clear'` and instructions
    pointing the user at the force-clear endpoint.
  - **`POST /api/pipelines/:id/restart`** — now force-clears the
    execution if the graceful `requestStop()` doesn't take effect within
    the 600ms grace period. Previously a stuck execution would block
    restart forever; now restart is always able to recover.
- **`gtss-growth-engine/public/js/pipelines.js`**:
  - New `forceClearPipeline(id)` function calls the new endpoint.
  - "Force Clear" button added to:
    1. The failed-state banner (next to Retry Failed Step / Resume from
       Checkpoint).
    2. A new "stuck running" warning banner that appears whenever the
       pipeline is in `running` state.
    3. The execution detail modal.
  - `resumeFromCheckpoint()` now sends `{ force: true }` by default so
    the user doesn't have to deal with the 409 error first.
  - In the execution detail modal, when the execution has no
    `failed_stage`, the "Retry Failed Step" button is replaced with a
    "Retry from Start" button that passes an empty stage (the server
    defaults to the first stage).

## How to verify

1. Start the desktop launcher (`npm run dev` in `desktop/`). The web app
   tab should open in CDP Chrome only AFTER the server is ready — no
   more "Connection refused" page.
2. No DevTools window opens by default. To get it back, either:
   - Set `OPEN_DEVTOOLS_ON_START=1` in your shell, OR
   - Click "Open DevTools" in the launcher's Advanced controls section.
3. To reproduce the stuck-pipeline scenario: kill the server while a
   pipeline is running, restart, and the pipeline will still show
   "Running" (the runner is dead but the DB row wasn't cleaned up).
   Click "Force Clear" — the pipeline flips to "Failed" / "Idle" and you
   can immediately Run / Retry / Resume.
4. The "Retry Failed Step" button no longer errors out when
   `failed_stage` is empty — it falls back to the first stage of the
   pipeline.
5. The "Resume from Checkpoint" button no longer errors out when there's
   a stuck execution — it force-clears the stuck state first.
