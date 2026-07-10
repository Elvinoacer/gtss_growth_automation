# Changes — gtss_growth_automation

This document summarises the edits made to the project in this pass. The
`.git` directory is untouched.

## A. CDP Chrome — try-first-then-clone pattern (inviolable, project-wide)

**Problem:** The project's intended Chrome-handling pattern was "try if we
have one [CDP endpoint / CDP profile]; if not, clone" — but this was only
partially implemented and inconsistently applied. The desktop launcher's
`CdpManager.start()` would spawn a new Chrome even when one was already
alive on the CDP port (e.g., when the user had run
`./scripts/launch-chrome.sh` first, or a previous desktop session had left
Chrome running). The bash `launch-chrome.sh` script would likewise spawn
a second Chrome without checking. And the onboarding wizard was launching
Chrome during the setup phase — which fails when the user has no Chrome
profile yet, and causes confusion by asking for platform sign-ins before
the server is even up.

**Fix — strengthened the pattern across every Chrome entry point:**

### `desktop/main/cdp-manager.js`

1. New `_tryAttachExisting(progress)` method, called at the very start of
   `start()`. It hits `GET /json/version` on the configured CDP port. If
   a Chrome answers, we **adopt it**: state flips to `"running"`,
   `chromePath` is captured from the response, and `start()` returns
   immediately — no spawn, no profile clone. We do NOT own the child
   process in this case (so `stop()` won't kill it — that's intentional;
   the user owns that Chrome).

2. New `_getCdpVersionInfo()` HTTP helper used by `_tryAttachExisting()`.

3. `stop()` updated to handle the attached case: when `this.child` is
   null but state is `"running"`, we log "Detaching from external Chrome…"
   and flip state to `"stopped"` — we never kill a Chrome we didn't
   spawn.

4. File-level comment rewritten to document the inviolable pattern.

### `gtss-growth-engine/scripts/launch-chrome.sh`

1. New `probe_cdp()` shell function — uses `curl` (preferred) with a
   bash `/dev/tcp` fallback to check whether anything is listening on
   `$PORT`.

2. If a CDP endpoint is already alive, the script prints a friendly note
   and exits 0 — no spawn, no clone. This makes `launch-chrome.sh` safe
   to call when the desktop launcher is already running (or vice versa).

3. The "clone if missing" check now requires BOTH `Default/` dir AND
   `Default/Cookies` file — previously it only checked the dir, which
   would short-circuit on an empty `Default/` left over from a crashed
   mid-copy.

4. Adds a fallback message when no source Chrome profile exists (so the
   user knows they'll need to log in manually rather than wondering why
   sessions are blank).

### `desktop/main/lifecycle.js`

1. `startAll()` now surfaces a distinct lifecycle log line for the
   attach case ("Reusing existing Chrome — no new browser spawned, no
   profile clone needed.") so the launcher UI's progress checklist can
   short-circuit the clone stage visually.

2. File-level comment expanded to document the pattern.

## B. Chrome launch removed from onboarding (setup) phase

**Problem:** Onboarding step 3 ("Sign in to your accounts") launched CDP
Chrome during the **setup** phase and asked the user to sign in to
Google/Gemini, LinkedIn, Facebook, X, and Instagram. This caused problems
when the user had no Chrome profile yet (or the profile was locked
because their real Chrome was open), and it duplicated the
session-management UX that already lives in the web app's Settings →
Platform Sessions.

**Fix — moved platform sign-in to the post-Start "missing sessions"
modal:**

### `desktop/renderer/onboarding.html`

1. Removed step 3 ("Sign in to your accounts") entirely — the
   `sessions-status-bar`, `sessions-progress` strip, `sessions-grid`,
   and `sessions-hint` are all gone.

2. Renumbered the Done step from step 4 → step 3. The stepper now shows
   3 steps (Passphrase → AI Key → Done) instead of 4.

3. The Done step's copy now explains that platform sign-in happens
   AFTER Finish — the launcher pops a modal automatically when sessions
   are missing.

### `desktop/renderer/onboarding.js`

1. Removed all session-management logic: `SESSION_PLATFORMS`,
   `sessionState`, `sessionPollTimer`, `sessionsAutoLaunched`,
   `renderSessionsGrid()`, `updateSessionsContinueButton()`,
   `autoStartCdpForSessions()`, `startCdpForSessions()`,
   `startSessionPolling()`, `stopSessionPolling()`,
   `pollSessionsOnce()`, the `PROGRESS_STAGES` strip, and all the
   `sessions-launch-chrome` / `sessions-reopen-tabs` / `sessions-refresh`
   / `onboard-step3-back` / `onboard-step3-skip` / `onboard-step3-next`
   handlers.

2. `totalSteps` reduced from 4 → 3.

3. `onboard-step2-next` now goes directly to step 3 (Done) instead of
   step 3 (Sign in) → step 4 (Done).

4. The finish-progress log listener now recognises the "Reusing existing
   Chrome" message and short-circuits the clone stage in the progress
   checklist (so the user doesn't see a stuck "Cloning browser profile…"
   step when we actually attached).

### `desktop/main/ipc-handlers.js`

1. `cdp:start-standalone` retained for backwards compat but its
   docstring updated to reflect that onboarding no longer calls it. With
   the strengthened pattern, it also attaches to an existing CDP
   endpoint before spawning — so it never creates a second Chrome.

### `desktop/preload/preload.js`

1. `startStandalone` API docstring updated to reflect that onboarding
   no longer uses it.

## C. Post-Start "missing sessions" modal — auto-pop

**Problem:** The launcher had a passive health-card banner that required
the user to click "Sign in…" to open the modal. Per project
requirements, the modal should AUTOMATICALLY pop up after the user clicks
Start (post-onboarding), once the web app URL has loaded in the CDP
Chrome, if any of LinkedIn, X, Instagram, Facebook, or Google/Gemini
sessions are missing.

**Fix — auto-open the modal after Start:**

### `desktop/renderer/renderer.js`

1. The Start button handler now schedules a 6-second post-Start check
   (gives the server + CDP + web-app-tab time to come up).

2. After the check, if ANY platform in `MODAL_SESSION_PLATFORMS` is
   missing AND the user hasn't dismissed the modal for this run, the
   modal is **automatically opened** (instead of just showing the
   passive health-card banner). A warning toast also fires listing the
   missing platforms.

3. The background polling (every 10s) continues after the modal is
   dismissed so the health card stays fresh.

4. Re-running Start cancels any pending auto-modal timer and resets the
   dismissed flag — so the modal can re-pop if sessions are still
   missing after the new launch.

### `desktop/renderer/index.html`

1. The modal's HTML comment now documents that it auto-pops after Start.

2. The modal intro text now references "Settings → Platform Sessions"
   so the user knows where to manage sessions later from the web app.

3. The Gemini note clarified: Gemini will not operate in a copied CDP
   profile without an active Google login — making the "why" of the
   Google requirement explicit.

## D. What was NOT changed

- The web app's `/settings → Platform Sessions` page is untouched. It
  still uses the engine's Playwright-based `authenticatePlatform()` flow
  for users who prefer to re-authenticate or clear individual platform
  sessions from inside the web app.
- The `.git` directory is fully intact and untouched. `git status` on
  the unpacked project shows the working tree changes against the
  existing `26f05b0` HEAD, with no rewrite of history.
- The onboarding-sessions.css stylesheet is retained because the modal
  in `renderer.js` reuses the same `.session-card` / `.session-logo` /
  `.session-check` classes.

---

## 0. Pipeline control buttons — robust & consistent across all pipelines

**Problem:** The 7 pipeline control buttons (Start, Restart, Pause, Stop,
Retry Failed Step, Resume from Checkpoint, Force Clear) were not working
effectively. Symptoms included: buttons appearing to do nothing, state
getting stuck on "Running" forever, the user having to click multiple
buttons in sequence (Force Clear → then Retry → then Resume) to recover
from a stuck run, and inconsistent behavior across the 3 pipelines
(outreach, content, dm_check).

**Root causes identified & fixed:**

### Backend — `src/services/pipelineStateService.js`

1. **New `isExecutionProgressing(pipelineId, staleMs)` helper** — returns
   true when the active execution's DB row was updated recently (within
   `staleMs`, default 60s). Used by Run/Restart/Retry/Resume to decide
   whether to auto-clear a stuck execution (when not progressing) or
   refuse with a clear error (when genuinely working). This is the
   middle ground between "always refuse" (the original bug) and "always
   auto-clear" (which can interrupt real work).

2. **New `hasStuckDbRow(pipelineId)` helper** — returns true if the DB
   has any rows in a transient state (running/paused/resuming/stopping/
   retrying) for this pipeline. Used by Restart to decide whether a
   preemptive sweep is needed.

3. **`forceClearExecution` improvements:**
   - Sets `ABORT_FLAG` BEFORE killing jobRegistry jobs, so cooperative
     runners get a chance to throw on their next `throwIfAborted` check.
   - New `keepPauseIntent` option — when true, preserves the schedule-
     level pause flag (used by the Stop endpoint, where the user's
     intent is "stop the current run" not "unpause the schedule").
   - Releases the content pipeline DB lock (`content_pipeline_lock`)
     so the content pipeline can be re-run after a stuck state.

4. **`requestResume` fix** — removed the racy `setTimeout` that
   transitioned from `resuming` to `running` after 500ms. The runner's
   own `awaitResume` loop handles the transition. The previous code
   could leave the execution stuck in `resuming` if the runner had
   already finished its current stage before the timer fired.

5. **`canStart` fix** — a disabled schedule (`enabled=0`) no longer
   blocks manual runs. The cron scheduler won't fire for disabled
   pipelines, but the user can still click Run/Restart to trigger a
   one-off manual run. This was the original "buttons don't work"
   complaint — Run was greyed out for disabled pipelines.

### Backend — `src/jobs/pipelineScheduler.js`

6. **New `runExistingExecution(pipelineId, executionId, trigger, limits, options)`
   public API** — re-runs an EXISTING execution (used by retry-stage
   and resume-from-checkpoint) without creating a new
   `pipeline_executions` row. Replaces the previous private-API dance
   of calling `__getRunner` + `__setActive` directly from the routes.
   Handles the `__setActive` call and the RUNNING transition
   internally.

7. **`runPipelineWithLifecycle` improvement** — uses the new
   `isExecutionProgressing` heuristic to decide whether to auto-clear
   a stuck execution or refuse with a clear error. Previously it
   always auto-cleared, which could interrupt a runner that was just
   slow but actually working.

8. **`dm_check` runner now registers with `jobRegistry`** — gives
   force-clear / stop real "teeth" for the dm_check pipeline. Without
   this, a stuck Instagram scan could only be killed by restarting the
   server. Now the abort signal propagates via the jobRegistry's
   AbortController.

### Backend — `src/routes/pipelines.js`

9. **`POST /:id/run`** — refuses with a clear 409 error when the
   active execution is genuinely progressing (instead of auto-clearing
   it). Auto-clears only when the execution is stuck (no progress for
   >60s). Returns a `hint` field so the frontend can show a one-click
   recovery button.

10. **`POST /:id/restart`** — increased the stop grace period from
    600ms to 1.5s so cooperative runners have more time to notice the
    abort flag. Uses `hasStuckDbRow` to decide whether a preemptive
    sweep is needed (instead of always force-clearing).

11. **`POST /:id/pause`** — improved response messages and state
    tracking. Sets `current_state = 'paused'` on the schedule row.

12. **`POST /:id/resume`** — no longer overwrites `last_status` with
    the non-existent 'resumed' state. Either keeps the existing
    `last_status` (schedule-level resume) or lets the runner's
    `transitionExecution` handle it (active-execution resume).

13. **`POST /:id/stop`** — improved response messages and state
    tracking. Clears `current_execution_id` and sets `current_state =
    'idle'` on the schedule row.

14. **`POST /:id/retry-stage`** — rewritten to use the public
    `runExistingExecution` helper instead of the private `__getRunner`
    + `__setActive` dance. Now accepts 'stopped' executions (not just
    'failed') for retry. Returns clear 409 errors with `hint` fields
    when the execution is currently running/paused or when another
    execution is making progress.

15. **`POST /:id/resume-from-checkpoint`** — rewritten to use the
    public `runExistingExecution` helper. Returns clear 409 errors
    when the target execution is already the active execution, when
    another execution is progressing, or when there's nothing to
    resume.

16. **`POST /:id/force-clear`** — now accepts `keep_pause_intent` in
    the body to preserve the pause flag (used when the user's intent
    is "stop the current run" not "unpause the schedule"). Releases
    the content pipeline DB lock.

17. **`buildRuntimeState`** — `can_run` no longer requires
    `enabled=true` (manual runs are allowed on disabled schedules).
    `can_pause` no longer requires `enabled=true` (pause is always
    available so the user can pause a long-running execution that
    started before the schedule was disabled).

### Backend — `src/pipeline/pipelineRunner.js`

18. **Catch block now ALWAYS calls `markExecutionFailed`** — the
    previous code only marked failed if `err.failedStage` was set,
    which left the execution stuck in `running` state when the runner
    threw without a `failedStage` (e.g., an abort signal thrown by
    `throwIfAborted`). `markExecutionFailed` is a no-op if the
    execution is already STOPPED, so this is safe.

### Frontend — `public/js/pipelines.js`

19. **`withActionFeedback`** — no longer reloads pipelines on error
    (the state hasn't changed, so reloading just flickers the UI).
    Only reloads on success. On error, patches the card back to its
    pre-optimistic state.

20. **Split `pausePipeline` into `pausePipeline` + `resumePipeline`**
    — the previous `pausePipeline(id, paused, btn)` signature was
    confusing (the `paused` parameter was the action, not the state).
    The new functions are clearer and the call sites have been
    updated.

21. **`showPipelineActionError`** — now reads the `hint` field from
    the backend error response and renders a one-click recovery
    button. For example, if the error hint is `another_running`, the
    banner shows a "Force Clear & Retry" button that the user can
    click to recover in one step.

22. **`resumeFromCheckpoint`** — removed the `confirm()` dialog. This
    is a non-destructive recovery action, and the confirm dialog was
    part of the original "buttons don't work" complaint (the user
    would click, see a dialog, click OK, and then nothing visible
    would happen because the action was async).

23. **`restartPipeline`** — only shows the `confirm()` dialog when
    there's an active execution that would be killed. If the pipeline
    is idle, restart is equivalent to Run Now — no need to confirm.

### Frontend — `public/js/app.js`

24. **`fetchJSON`** — now attaches the full response body and `hint`
    field to the thrown error, so callers can inspect structured error
    fields. The previous code discarded everything except the message
    string. Also handles non-JSON responses gracefully (instead of
    crashing on `JSON.parse`).

### Tests — `test/pipelineControls.test.js` (new file)

25. **12 unit tests** covering the state machine transitions that the
    7 control buttons depend on:
    - `forceClearExecution` marks stuck DB rows as failed
    - `forceClearExecution` clears the pause flag by default
    - `forceClearExecution` preserves the pause flag with
      `keepPauseIntent: true`
    - `forceClearExecution` releases the content pipeline DB lock
    - `canStart` allows manual runs on disabled schedules
    - `canStart` refuses when paused (unless `force: true`)
    - `hasStuckDbRow` detects transient-state rows
    - `isExecutionProgressing` returns true for recently-updated rows
    - `requestResume` clears the pause flag at the schedule level
    - `requestStop` sweeps stuck DB rows when no in-memory runner
    - `createExecution` refuses when an active execution exists
    - `markExecutionFailed` does not overwrite a STOPPED state

    All 12 tests pass. The tests mock the database and socket layer so
    they can run without `better-sqlite3` installed.

**Files modified:**
- `gtss-growth-engine/src/services/pipelineStateService.js`
- `gtss-growth-engine/src/jobs/pipelineScheduler.js`
- `gtss-growth-engine/src/routes/pipelines.js`
- `gtss-growth-engine/src/pipeline/pipelineRunner.js`
- `gtss-growth-engine/public/js/pipelines.js`
- `gtss-growth-engine/public/js/app.js`

**Files added:**
- `gtss-growth-engine/test/pipelineControls.test.js`

**How to verify:**

```bash
cd gtss-growth-engine
node --test test/pipelineControls.test.js
# Expected: 12 tests, 12 pass, 0 fail
```

The same robust pattern is now applied consistently across all 3
pipelines (outreach, content, dm_check):
- All 3 register with `jobRegistry` so force-clear/stop have real teeth.
- All 3 use the same `runPipelineWithLifecycle` / `runExistingExecution`
  helpers for state management.
- All 3 respect the schedule-level pause flag and the in-memory
  ABORT_FLAGS / PAUSE_FLAGS.
- All 3 are covered by the same 7 control endpoints in
  `routes/pipelines.js`.

## 1. Pipelines page UI — real-time status & better controls

**Files:**
- `gtss-growth-engine/public/js/pipelines.js`
- `gtss-growth-engine/public/css/style.css`
- `gtss-growth-engine/src/services/pipelineStateService.js`

**What changed:**
- Action buttons (Start / Stop / Pause / Resume) now live-update their
  labels and disabled state in real time as the pipeline state changes —
  no more waiting for a full page re-render after clicking Start.
- Added an `optimisticStateForAction` helper that flips the cached
  pipeline state immediately when the user clicks an action button, so
  the UI reflects the click before the server even responds.
- Button labels are now dynamic: "▶ Start" → "● Running…" → "⟳ Stopping…".
  The Stop button is enabled for all running-like states (running,
  stopping, resuming, retrying), not just `running`.
- Added a `pipeline-card--running` CSS class with a subtle pulse animation
  on the card border so the user can see at a glance which pipeline is
  currently active.
- The `patchPipelineCardInPlace` function now also patches the
  `action-buttons` slot (previously it deliberately skipped this, which
  was the single biggest UX complaint).
- Backend bug fixes:
  - `requestStop` now also clears the schedule-level pause flag when
    sweeping a stuck DB row (previously a paused-then-stuck pipeline
    couldn't be re-Run without Force Clear).
  - `markExecutionFailed` no longer overwrites an explicit `stopping` /
    `stopped` state with `failed` — once stopped, stay stopped.

## 2. Caption generation — fixed placeholder leak & per-platform captions

**Files:**
- `gtss-growth-engine/src/services/schedulerService.js`
- `gtss-growth-engine/src/pipeline/contentPipeline.js`
- `gtss-growth-engine/src/routes/scheduler.js`
- `gtss-growth-engine/src/db/schema.sql`, `src/db/database.js`
- `gtss-growth-engine/public/js/scheduler.js`

**What changed:**
- `generateCaption` no longer returns the
  `${topic} — [Edit this caption before posting]` stub on failure.
  Instead it returns a structured `{ text, source, model, ok, error }`
  object. The content pipeline checks `ok` and aborts the run on failure
  rather than silently posting a placeholder.
- `normalizePlainPostText` (used by X, Instagram, Facebook) now strips
  markdown link/image syntax (`[text](url)`, `![alt](url)`) the same way
  LinkedIn's `normalizeLinkedInText` does. Previously AI-generated
  captions with markdown links leaked through as literal `[link](link)`
  text on these platforms.
- Added a new `captions_json` column to the `posts` table. The content
  pipeline now persists ALL per-platform captions (one per platform)
  instead of only the primary platform's caption. The publisher reads
  `captions[platform]` from this column and uses the platform-specific
  caption — so an Instagram caption no longer gets truncated to 280
  chars on X; X uses its own X-tailored caption.
- The manual caption API endpoint (`/api/scheduler/generate-caption`)
  now returns a 503 with a clear error when generation fails, instead
  of returning the placeholder stub.
- The scheduler page shows distinct toasts for AI success, web fallback,
  and failure.

## 3. Message generation — AI vs Template choice

**Files:**
- `gtss-growth-engine/src/services/messageService.js`
- `gtss-growth-engine/src/config/pipelineConfig.js`
- `gtss-growth-engine/src/routes/settings.js`
- `gtss-growth-engine/public/pages/message-generator.html`
- `gtss-growth-engine/public/js/messages.js`

**What changed:**
- Added a new `messageGenerationSource()` config helper that reads the
  `message_generation_source` setting (DB) or `MESSAGE_GENERATION_SOURCE`
  env var. Default: `'ai'` (per the user's instruction to prioritise AI
  for the full lead-discovery pipeline).
- Added a new `generateViaAI(lead)` function that builds a per-platform
  prompt using the lead's profile + product context, calls
  `callGeminiText` (API key first, Gemini Web fallback), and inserts A/B
  variants stamped `generated_by='ai'`. On any AI failure it falls back
  to `generateFromTemplate` so the pipeline never deadlocks.
- `generateMessages` now dispatches to `generateViaAI` or
  `generateFromTemplate` based on the setting. The previous code
  unconditionally called `generateFromTemplate` regardless of the mode —
  the AI branch was dead code.
- `runMessageStage` now reports both `source` and `mode` in its progress
  messages so the user can see which path is active.
- Added a "Message Source" toggle (AI / Template) to the
  message-generator settings slide-out. The choice is persisted via
  `PATCH /api/settings` and the backend reads it on every generate call.
- Added `message_generation_source` to the settings PATCH allowlist.
- Pre-flight guard: if neither `GEMINI_API_KEY` nor any CDP endpoint is
  configured, `generateViaAI` short-circuits to the template path so the
  pipeline keeps moving and tests don't hang.

## 4 & 5. Asset grouping, multi-image posts, video, labeling

**Files:**
- `gtss-growth-engine/src/db/schema.sql`, `src/db/database.js`
- `gtss-growth-engine/src/services/assetRotationService.js`
- `gtss-growth-engine/src/routes/assets.js`
- `gtss-growth-engine/src/pipeline/contentPipeline.js`
- `gtss-growth-engine/src/services/schedulerService.js`
- `gtss-growth-engine/public/pages/asset-library.html`
- `gtss-growth-engine/public/js/asset-library.js`

**What changed:**
- New `asset_groups` table: `id, name, label, post_type, times_used,
  last_used_at, created_at`. `post_type` is `carousel` | `video` |
  `single`.
- Added `group_id` and `position` columns to `asset_library` so each
  asset can belong to one group with an explicit ordering.
- New service functions:
  - `pickNextAssetGroup({ postType, tags })` — returns the next
    least-used group with its ordered asset list.
  - `markAssetGroupUsed(groupId, postId)` — bumps `times_used` for the
    group and every asset in it.
- New API endpoints under `/api/assets/groups`:
  - `GET /api/assets/groups` — list all groups with their assets.
  - `POST /api/assets/groups` — create a new group.
  - `PATCH /api/assets/groups/:id` — rename / relabel / change post_type.
  - `DELETE /api/assets/groups/:id` — delete the group (assets stay,
    just ungrouped).
  - `POST /api/assets/groups/:id/assets` — bulk-assign an ordered list
    of asset ids to a group.
- The asset upload endpoint now accepts an optional `group_id` so the
  user can upload straight into an existing group.
- The content pipeline now:
  - Prefers groups when the asset source is `library` — if a group
    exists, it picks the next group and uses ALL its assets as
    `media_paths` for a multi-image post.
  - Falls back to single-asset rotation when no groups exist.
  - Writes `media_paths` (JSON array) to the post row even for
    single-asset posts, so the publisher always has a consistent
    array to work with.
- The publisher (`publishPost`) now:
  - Auto-promotes Instagram posts to `carousel` when `media_paths` has
    more than 1 image (previously only triggered when `ig_post_type`
    was explicitly set to `carousel`).
  - Detects video files in `media_paths` and routes to the
    appropriate post type.
- The asset-library page has a new "Asset Groups" section with:
  - Create-group form (name, label, post_type).
  - Per-group card showing all assets in position order with remove
    buttons.
  - Rename / delete group buttons.
  - Per-asset dropdown to assign it to a group (or unassign).
- Video upload was already supported at the API level; the UI now
  renders videos with `<video>` tags inside group thumbnails too.

## 6. Image-aware captions via Gemini Web

**Files:**
- `gtss-growth-engine/src/automation/geminiWeb.js`
- `gtss-growth-engine/src/services/schedulerService.js`
- `gtss-growth-engine/src/pipeline/contentPipeline.js`

**What changed:**
- New `generateImageAwareCaptionViaGeminiWeb(imagePath, prompt, emit)`
  function in `geminiWeb.js`. It navigates to `gemini.google.com/app`,
  clicks the "Add photos" toolbar button (trying several aria-labels
  for resilience), drives the hidden `<input type="file">` with
  Playwright's `setInputFiles`, waits for the upload preview, then
  types the prompt and submits. Returns `{ text }`.
- `generateCaption` now accepts an optional `options.imagePath`. When
  provided, it FIRST tries the image-aware Gemini Web path so the
  caption can actually match what's in the image. On any failure it
  falls through to the text-only Gemini API path (which itself falls
  back to text-only Gemini Web). The image-aware path is best-effort.
- The content pipeline resolves the on-disk image path (for library
  uploads and AI-generated files under `/uploads`) and passes it to
  `generateCaption` so image-aware captioning kicks in automatically
  when an image is available.

## 7. LinkedIn long-text typing — chunked typing + char limit

**Files:**
- `gtss-growth-engine/src/automation/linkedin.js`
- `gtss-growth-engine/src/services/schedulerService.js`

**What changed:**
- New `typeInChunks(page, locator, text, { chunkSize, settleMs })`
  helper in `linkedin.js`. Splits long text into ~500-char chunks at
  whitespace boundaries, calls `keyboard.insertText(chunk)` per chunk,
  re-locates the editor between chunks (in case React re-rendered it),
  and verifies the cumulative text after each chunk. This is the
  missing middle ground between "atomic single shot" (which silently
  truncates long text) and "per-character loop" (which takes minutes
  for 3000+ chars).
- `typeLikeHuman` now tries the chunked path (Step 3b) between the
  atomic insertText (Step 3) and the per-character fallback (Step 4)
  when the text is longer than 600 chars.
- `typeTextWithFallback` (used for LinkedIn POST composer) now uses a
  single `editor.type(text, { delay })` call instead of a per-character
  loop. This cuts typing time from 60-240s down to ~10s for a 3000-char
  post, with the same React-compatibility guarantees.
- `normalizeLinkedInText` now enforces the 3000-char LinkedIn limit
  with a word-boundary-aware truncation + ellipsis. Previously an
  oversized AI-generated body would silently disable LinkedIn's Post
  button (it flips red and unclickable above 3000) and the publish step
  would time out at the click.
- Exported `typeInChunks` via `__private` so it can be unit-tested.

## D. Authentication in the default browser, real setup progress, and startup-hang fix

This pass addresses three UX observations from testing:

1. Authentication was happening inside Electron (in the CDP Chrome the
   launcher spawned) instead of in the user's default web browser.
2. Clicking **Finish & start** in onboarding immediately redirected to
   the launcher without showing what was happening during startup.
3. Clicking **Start** sometimes appeared to hang the app.

### 1. Authentication in the user's default browser (not inside Electron)

**Problem:** The web app URL (`http://localhost:3000`) was opened as a
tab *inside* the CDP Chrome that Electron spawned. Platform sign-in (the
"Missing sessions" modal) likewise opened LinkedIn/X/Facebook/Instagram/
Google login pages inside that same CDP Chrome. That tied authentication
to an Electron-controlled browser — which felt embedded, didn't carry
Google's trusted-device state, and contributed to the startup hang (see
fix 3 below).

**Fix — moved every auth surface to `shell.openExternal`:**

- `desktop/main/lifecycle.js` — `startAll()` and `openWebApp()` now
  open the web app URL in the user's default browser via
  `shell.openExternal`, never inside CDP Chrome. The CDP Chrome still
  runs for automation — it just doesn't host the web app UI anymore.
- `desktop/main/ipc-handlers.js` — new `app:open-external` IPC channel
  that validates the URL is `http(s)` and then calls
  `shell.openExternal`. Used by the missing-sessions modal.
- `desktop/preload/preload.js` — new `openExternal(url)` method on the
  `window.gtss` API; the legacy `cdp.openUrlInCdp` is retained but no
  longer used by the auth flow.
- `desktop/renderer/renderer.js` — the "Open ↗" buttons in the
  missing-sessions modal now call `window.gtss.openExternal(url)`
  instead of `window.gtss.cdp.openUrlInCdp(url)`. The "All set" button
  is no longer gated on live session detection (fresh sign-ins in the
  default browser don't reach the CDP Chrome until the next profile
  clone — gating would trap the user in the modal).
- `desktop/renderer/index.html` + `onboarding.html` — updated all
  user-facing copy to reflect "opens in your default browser".

**Trade-off the user should know:** cookies set during a fresh sign-in
inside the default browser don't transfer to the CDP Chrome until the
next profile clone runs (on next launcher start or on "Restart CDP").
If the user's default browser is Chrome (the common case), this is
automatic on the next launch. The modal's intro text explains this.

### 2. Real setup-progress screen before navigating to the launcher

**Problem:** `onOnboardingComplete` was fire-and-forget — it closed the
onboarding window, opened the launcher, and *then* started the server in
the background. The user saw a brief flash of "background tasks" and was
immediately redirected, with no visibility into what was happening.

**Fix — keep the onboarding window open and stream structured progress
events until startup finishes:**

- `desktop/main/lifecycle.js` — `startAll({ onProgress })` now accepts a
  structured progress callback. Each call emits a stable stage
  identifier (`start`, `server`, `browser`, `clone`, `endpoint`,
  `open-webapp`, `ready`) plus error variants (`server:error`,
  `browser:error`, `open-webapp:error`). Replaces the previous
  regex-based log scraping.
- `desktop/main/main.js` — `onOnboardingComplete(sendProgress)` is now
  async and awaited. It runs `lifecycle.startAll` with the progress
  callback, waits for it to finish, briefly shows the "Done!" state
  (~800ms), and only *then* swaps the onboarding window for the
  launcher. If startup fails, the onboarding window stays open and the
  error is surfaced in-place so the user can retry.
- `desktop/main/ipc-handlers.js` — `onboarding:complete` now awaits
  `onOnboardingComplete`, streaming `onboarding:progress` events to the
  onboarding window's `webContents` during the startup.
- `desktop/preload/preload.js` — new `onboarding.onProgress(cb)` API
  for subscribing to progress events.
- `desktop/renderer/onboarding.js` — replaced the regex log scraper
  with a proper event listener that updates a 6-step checklist
  (server / browser / clone / endpoint / open-webapp / ready). Each
  step shows pending (○), active (●), done (✓), or error (✗). Skipped
  stages (e.g., "clone" when attaching to an existing Chrome) auto-tick
  to ✓ when a later stage arrives.
- `desktop/renderer/onboarding.html` + `onboarding.css` — new progress
  UI with title, subtitle ("This only happens once…"), and a
  dedicated error banner element below the checklist.

### 3. Startup-hang investigation and fix

**Root cause:** `copyDirSelective` in `desktop/main/cdp-manager.js`
was a *synchronous* recursive directory copy. On first launch (or any
launch where the CDP profile needed cloning), it would copy 10,000+
files from the user's real Chrome profile into the CDP profile dir —
blocking the Electron main thread for 10-60 seconds. During that
window, no IPC could be processed, no UI could update, no log lines
could stream. From the user's perspective, clicking **Start** "hung"
the app. The embedded-auth flow made the symptom worse because the
CDP Chrome was also the auth surface — so the user couldn't even tell
whether the hang was auth-related or startup-related.

**Fix — made the profile clone async with periodic event-loop yields:**

- `desktop/main/cdp-manager.js` — `copyDirSelective` and
  `_copyDirInner` are now `async` functions. Every 50 files copied,
  they `await new Promise(r => setImmediate(r))` — yielding ~1ms to
  let the main thread process IPC, update the UI, and stream log
  lines. Overhead is negligible (~1ms per 50 files vs. ~1ms per file
  copy) but the UI stays responsive throughout the clone.
- `ensureCdpProfile` now `await`s `copyDirSelective` (it was already
  `async` but called the sync version).
- Combined with fix 1 (auth moved to the default browser), the CDP
  Chrome is no longer on the critical path for the user's auth flow —
  so even if the clone is slow, the user can already be signing into
  the web app in their default browser while the clone runs in the
  background.

**Verification:** `node scripts/validate-js.js` reports 13/13 desktop
JS files pass syntax check. No engine (`gtss-growth-engine/`) files
were modified.

### 4. Profile-clone freeze — selective async atomic copy

**Problem:** Even after fix 3 above, users on Windows still saw the
"GTSS Growth Engine is not responding" dialog during the "Setting things
up..." phase of onboarding. The previous fix made `copyDirSelective`
`async` and added `setImmediate` yields every 50 files, but kept
`fs.copyFileSync` per file — which is itself blocking I/O. Each large
file copy (5–50MB IndexedDB blobs, LevelDB MANIFEST files, etc.) blocked
the Electron main thread for tens-to-hundreds of milliseconds. Over
5,000–50,000 files, that added up to a 10–60+ second main-thread freeze.

The strip list (`PROFILE_STRIP_DIRS`) was also too narrow: it stripped
`Cache`, `Code Cache`, `GPUCache`, `Service Worker/CacheStorage`,
`Service Worker/ScriptCache`, `GrShaderCache`, `ShaderCache`,
`Downloads`, `Crashpad`, `component_crx_cache` — but did NOT strip the
actual heavy hitters: `IndexedDB`, `Local Storage`, `Sessions`,
`Media Cache`, `Storage`, the `Service Worker` parent tree, etc. Those
typically make up 90%+ of a Chrome profile's size (500MB–5GB).

**Fix — selective async atomic clone:**

- `desktop/main/cdp-manager.js` — replaced the "copy entire `Default/`
  dir minus a strip list" approach with a whitelist of session-bearing
  files only:
    - `Cookies`, `Cookies-journal` (session cookies — SQLite)
    - `Login Data`, `Login Data-journal`, `Login Data For Account` (saved
      logins — SQLite, encrypted via `Local State` + OS keyring)
    - `Web Data`, `Web Data-journal` (autofill, payment methods — SQLite)
    - `Preferences`, `Secure Preferences` (JSON)
    - `TransportSecurity` (HSTS — SQLite)
    - `Favicons`, `Favicons-journal`, `History`, `History-journal`,
      `Top Sites`, `Top Sites-journal` (small UX-improving SQLite)
    - `Network/Cookies`, `Network/Network Persistent State` (newer
      Chrome layouts)
    - `Local State` (top-level; carries the `os_crypt.encrypted_key`
      blob needed to decrypt the above on Windows/macOS — same user +
      same machine preserves decryption)
  Each file is normally <8MB; total clone drops from 10–60+ seconds
  (multi-GB) to <1 second (a few MB).
- All file I/O switched from `fs.*Sync` to `fs.promises.*` (`fsp.*`),
  which runs on libuv's thread pool — never the main thread. No more
  per-file blocking.
- Each file copied atomically: write to `<dest>.tmp.<pid>` then rename
  in the destination dir (same-dir rename is atomic on POSIX and on
  NTFS). A crash mid-copy or a Windows "force quit" never leaves a
  half-written Cookies/Login Data file that would short-circuit the
  `profileLooksPopulated` check on the next launch. This closes the
  regression the previous fix was trying to address.
- Files copied in parallel batches of 4 (`CLONE_CONCURRENCY`) for speed.
- 8MB per-file size cap (`SESSION_FILE_MAX_BYTES`) as defense in depth.
- The expanded `PROFILE_STRIP_DIRS` (now includes `IndexedDB`,
  `Local Storage`, `Session Storage`, `Storage`, `Sessions`, `Service
  Worker`, `Media Cache`, `blob_storage`, `File System`, `SyncData`,
  `optimization_guide*`, `webrtc_event_logs`, etc.) is retained for
  the rare fallback `copyDirAsync` path — only used when the source
  profile has NO session files (e.g., a fresh Chrome install that has
  never had any logins). The fallback path's `fs.copyFileSync` was
  also replaced with `fsp.copyFile`, and the `setImmediate` yield
  cadence tightened from every 50 files to every 16.
- `gtss-growth-engine/scripts/launch-chrome.sh` — mirrored the same
  selective-copy logic. Replaced `cp -r "$SOURCE_PROFILE/Default"`
  with a per-file atomic `cp` loop over the same `SESSION_FILES`
  whitelist, with the same 8MB cap and the same `Local State` top-level
  copy. Bash uses `cp -p` to a `.tmp.$$` then `mv -f` for atomicity.

**Why cloning IS still necessary:** Chrome forbids
`--remote-debugging-port` against the user's default profile dir, AND
the user's real Chrome holds exclusive SQLite locks on the Cookies /
Login Data files when running. So we MUST copy the session-bearing
files to a separate `chrome-cdp-profile/` dir. But we no longer copy
the multi-GB caches — only the small files that actually carry login
state.

**Verification:** `node scripts/validate-js.js` reports 13/13 desktop
JS files pass syntax check. A standalone functional test of the new
helpers (`atomicCopyFile`, `cloneSessionFiles`) was run end-to-end
against a fake Chrome profile tree containing real session files plus
20MB IndexedDB blobs — all 14 assertions pass: session files copied
correctly, heavy dirs skipped, subdir `Network/Cookies` created on
demand, atomic rename leaves no `.tmp` leftovers, and a simulated
crash-leftover `.tmp` file is overwritten cleanly on the next run.
`bash -n launch-chrome.sh` passes. `.git/` directory untouched.

---

## H. Setup UX + Posting Pipeline fixes (review pass)

These edits address the two issues called out in the latest review:

1. **First-launch setup UX is clunky** — the clone step had no
   background handling, no actionable UI when Chrome was locked, and
   no persistent "setup health" indicator after onboarding.
2. **Content-posting pipeline opens a browser tab for a platform and
   it "automatically closes" shortly after** — caused by `finally
   { closeBrowserContext(...) }` running after every attempt in the
   retry loop, not just at the end.

### Setup UX (FIX 1a–1d)

**FIX 1a — Surface "Chrome is locked" as an actionable UI state.**
`desktop/main/cdp-manager.js` `ensureCdpProfile()` already detected the
condition (Cookies/Login Data missing from the destination after the
clone) but only emitted a `cdp:stderr` log line. Now it emits a new
`clone:warning` stage with a self-contained, user-facing message. The
onboarding Finish screen listens for the `:warning` suffix and shows a
yellow callout with a **Restart Chrome** button — instead of a buried
log line.

**FIX 1b — Make onboarding clearly state isolated-browser fallback.**
`desktop/main/lifecycle.js` `startAll()` now emits a dedicated
`browser:warning` stage when CDP fails and we fall back to
`BROWSER_MODE=persistent`. The onboarding Finish screen surfaces this
in the same yellow callout so the user knows automation will run
without their cloned logins — they'll need to sign in to each platform
manually.

**FIX 1c — Per-platform Skip in the sessions modal.**
`desktop/renderer/renderer.js` `renderSessionsModalGrid()` now renders
a per-card "Skip" button. A skipped platform is excluded from the
"missing sessions" count in the health card, won't re-trigger the
auto-open modal on subsequent Start clicks, and is auto-unskipped when
polling detects a session for it. The skip state is in-memory only —
deliberately not persisted across launcher restarts, so a fresh launch
gets a fresh opportunity to detect sessions.

**FIX 1d — Persistent connection-health badge.**
`desktop/renderer/index.html` adds a new `#sessions-health-badge`
button in the topbar showing "X/N platforms connected". Green when all
(or all required) are connected, yellow when some are missing, red
when none are connected. Clicking opens the missing-sessions modal.
`updateSessionsHealthBadge()` is called from `pollModalSessionsOnce()`
and on Start click, so it stays live.

**Supporting changes:**
- `desktop/main/ipc-handlers.js`: new `cdp:restart` IPC handler that
  wraps `cdpManager.restart()` (which now forwards `onProgress` to
  `start()` so the Finish screen's Restart Chrome button gets live
  clone-stage progress).
- `desktop/preload/preload.js`: exposes `window.gtss.cdp.restart`.
- `desktop/renderer/onboarding.html` + `onboarding.css`: warning
  callout markup + yellow styling.
- `desktop/renderer/styles.css`: styles for the badge, the skipped
  card state, and the per-card Skip button.

### Posting Pipeline (FIX 2a–2d)

**FIX 2a — Don't close on failure inside the retry loop.**
`gtss-growth-engine/src/services/schedulerService.js` `publishPost()`
previously declared `browserState` inside the per-attempt `try` and
called `closeBrowserContext(...)` in the per-attempt `finally` — so
every attempt (success OR failure) opened and closed a tab. If all 3
attempts failed quickly, the user saw the tab open and close three
times in ~15 seconds.

Now `browserState` is hoisted to the platform-loop scope. The retry
loop **reuses the same tab across attempts** (only recreating it if
the previous page died mid-attempt). The tab is closed **once** in an
outer `finally` after the loop. This eliminates the open→close→wait→
open→close flicker.

**FIX 2b — Extend LinkedIn's tab-reuse pattern to X and Facebook.**
`gtss-growth-engine/src/automation/browserBase.js` `createBrowser()`
previously only reused an existing tab when `platform === "linkedin"`.
Now it computes a `platformDomain` (`linkedin.com` / `x.com` /
`facebook.com` / `instagram.com`) and reuses any existing tab on that
domain. (Instagram is also covered here for completeness, though in
practice Instagram goes through `createInstagramBrowser` which already
had its own tab-reuse logic.)

**FIX 2c — Short visible delay before closing on success.**
`browserBase.js` `closeBrowser()` now waits 2.5 seconds before closing
the tab when `options.success === true` (CDP / `shouldClosePageOnly`
branch only). This lets the user glance over and visually confirm
"yes, that actually posted" instead of having the tab yanked away the
instant the "✓ Posted to X" event fires. The delay is skipped on
failure (so retries aren't slowed) and can be disabled via
`DEBUG_NO_CLOSE_DELAY=1` for tests/headless runs.

**FIX 2d — Differentiate close reasons in the log line.**
`browserBase.js` `closeBrowser()` previously always logged
`"Closed automation tab for {platform} (Chrome stays open)"`. Now it
logs:
- `"...after successful post (Chrome stays open)"` — success
- `"...after failed attempt (n/3) (Chrome stays open)"` — failure
- `"...after failed attempt (reason: page-closed-mid-attempt)..."` — page died

`closeBrowserContext()` accepts new optional `options.success`,
`options.attempt`, and `options.reason` fields and threads them
through. Existing 2-arg callers (geminiWeb.js, instagramWarmupJob.js,
etc.) continue to work — they get the old "after failed attempt" log
line with no attempt number.

### Cleanup (FIX 3)

`scheduledPoster.js`'s local `postToInstagram()` and `postToPlatform()`
are NOT used by the cron flow (the cron job calls
`schedulerService.publishPost()` directly, which handles all four
platforms). They're retained because `test/instagramPoster.test.js`
exercises `postToInstagram` directly to verify `ig_post_type` dispatch.
Both are now marked `@deprecated` with JSDoc explaining the situation
and pointing future contributors to `schedulerService.publishPost`.

### Verification

- `node --check` passes on every modified JS file:
  `cdp-manager.js`, `lifecycle.js`, `ipc-handlers.js`, `preload.js`,
  `renderer.js`, `onboarding.js`, `browserBase.js`,
  `schedulerService.js`, `scheduledPoster.js`.
- Backward-compat preserved: `closeBrowserContext(platform, browserState)`
  still works (the new `options` arg defaults to `{}`).
- `.git/` directory untouched.

---

## L. Login-session browser visibility & Gemini platform support

**Problem:** Three intertwined issues reported by the operator:

1. **"Sometimes the browser shows, sometimes it doesn't"** — when a login
   session is initiated from the dashboard's sign-in modal, the automation
   browser tab sometimes opens visibly (user can log in) and sometimes
   opens invisibly inside a headless background Chrome (user stares at a
   "Opening browser..." spinner until the 5-minute timeout). This is
   unpredictable and blocks the critical sign-in flow.

2. **Gemini shows "Unknown platform"** — clicking Login / Re-authenticate
   on the Google / Gemini card in the sign-in modal returns HTTP 404
   `{ error: "Unknown platform" }` because the platform catalog only
   contained platforms discovered from the DB, and on a fresh install
   neither `google` nor `gemini` had any DB rows yet.

3. **Login sessions navigated to /login URLs** — `authenticatePlatform`
   hard-coded login-page URLs (`/login`, `/i/flow/login`) instead of the
   platform home page. The operator's contract is: navigate to the home
   page and let the platform itself redirect to its login form (or to the
   feed if already authenticated). This avoids sending an already-logged-in
   user to a login page (which some platforms flag as suspicious) and
   avoids maintaining fragile per-platform login URLs.

**Root cause analysis:**

- **Issue 1** — `authenticatePlatform` called `createBrowser(platform,
  { headless: false })`. In CDP mode, `createBrowser` connects to the
  EXISTING shared Chrome via `connectOverCDP`. If that Chrome was started
  headless by the desktop launcher (because the user chose "Background"
  mode in Settings → Automation Browser, i.e. `CDP_VISIBLE_DEFAULT=false`),
  the login tab opens INSIDE the headless Chrome — invisible to the user.
  The server process can't restart CDP itself (it doesn't own the Chrome
  child process; only the Electron launcher's `CdpManager` does).

- **Issue 2** — `getPlatformKeys()` in `platformCatalog.js` discovered
  platforms exclusively from DB tables (`platform_sessions`, `daily_actions`,
  etc.) and from the `daily_limits` settings row. On a fresh install with
  zero rows, neither `google` nor `gemini` appeared, so the API route
  `/api/sessions/authenticate/:platform` rejected them with 404.

- **Issue 3** — `authenticatePlatform` used `https://www.${platform}.com/login`
  as the default, with special cases only for `linkedin` and `x`. Gemini
  has no `/login` page at all, and the operator's contract is to navigate
  to the home page regardless.

**Fix — four coordinated changes:**

### `gtss-growth-engine/src/services/platformCatalog.js`

- New `BUILT_IN_PLATFORMS` constant (`linkedin`, `x`, `facebook`,
  `instagram`, `google`, `gemini`). `getPlatformCatalog()` now seeds its
  ordered key list with these FIRST, before DB/limits discovery. This
  guarantees `isKnownPlatform('google')` / `isKnownPlatform('gemini')`
  return `true` from day one, so the API route accepts the very first
  Gemini login on a fresh install.
- `formatPlatformLabel` now has explicit cases for `google` ("Google /
  Gemini") and `gemini` ("Gemini") so the UI renders the right label.

### `gtss-growth-engine/src/automation/browserBase.js`

- **`normalizeHeadless` — login sessions are ALWAYS visible.** New
  `options.loginSession` flag short-circuits to `return false` before
  any env-var checks. This is the single, predictable contract: a
  user-initiated sign-in flow shows the browser window, period.

- **`normalizeHeadless` — pipelines respect the user's preference.** In
  addition to the legacy `ALLOW_HEADLESS_SOCIAL` escape hatch, we now
  also treat `CDP_VISIBLE_DEFAULT=false` (the user's "Background" choice
  in Settings → Automation Browser) as permission to run pipelines
  headless. This makes the user's Settings preference apply to
  persistent / standalone browser mode too, not just CDP mode. When
  NEITHER env var is set, the historical safety default is preserved
  (force visible for known social platforms).

- **`createBrowser` — login-session visibility guarantee in CDP mode.**
  When `options.loginSession === true` AND mode is `cdp`, we call the
  new `ensureCdpVisibleViaBridge()` helper BEFORE `connectOverCDP()`.
  This probes the desktop launcher's bridge (ports 9224–9227) and asks
  it to ensure the shared Chrome is running visibly. If the bridge
  confirms, we proceed with CDP mode — the login tab opens in a visible
  Chrome window. If the bridge is NOT reachable (standalone server, no
  launcher), we fall back to PERSISTENT mode with `headless:false`, which
  launches a fresh visible Chrome window. Either way, the login window
  is ALWAYS shown — eliminating the "sometimes shows, sometimes doesn't"
  abnormality.

- **New helpers `findBridgeBase()` and `ensureCdpVisibleViaBridge()`** —
  localhost-only HTTP probes of the bridge. Cached after the first probe
  so repeated login sessions in the same process don't re-probe. Uses
  lazy `require("http")` so the module remains importable in test
  environments.

### `gtss-growth-engine/src/automation/executor.js`

- **`authenticatePlatform` — passes `loginSession: true`** to
  `createBrowser()`. This is the single flag that triggers the visibility
  guarantee above.

- **`authenticatePlatform` — navigates to the HOME page, not /login.**
  New `getLoginSessionHomeUrl(platform)` helper returns:
  - linkedin → `https://www.linkedin.com/`
  - x → `https://x.com/`
  - facebook → `https://www.facebook.com/`
  - instagram → `https://www.instagram.com/`
  - google / gemini → `https://gemini.google.com/`
  The platform itself redirects to its login form if unauthenticated,
  and to the feed if already signed in. `page.goto()` now uses
  `waitUntil: "domcontentloaded"` with a 60s timeout and a `.catch()`
  so a slow redirect never blocks the login-wait loop.

- **`isManualAuthComplete` — handles google / gemini.** Returns `true`
  when the URL is on `gemini.google.com` (the post-login landing page)
  and `false` while the URL is still on `accounts.google.com` (the
  Google sign-in flow in progress).

### `desktop/main/bridge-server.js`

- **New endpoint `POST /api/bridge/cdp/ensure-visible`** — the counterpart
  to `ensureCdpVisibleViaBridge()` on the server side. It:
  - Starts CDP visibly if not running.
  - Restarts CDP visibly if running headless (`startedVisible === false`).
  - No-ops if already running visibly.
  Returns `{ ok, cdpState, cdpEndpoint }`. On failure returns
  `{ ok: false, error }` so the server-side caller can fall back to a
  visible persistent browser. Endpoint documented in the file's top-of-
  file endpoint table.

### Tests updated

- `test/browserBase.test.js`:
  - Existing "headless is disabled for social platforms" test now
    snapshots/deletes `CDP_VISIBLE_DEFAULT` so it's hermetic.
  - New test: `loginSession always forces a visible browser regardless
    of headless preference` — verifies the login-session contract under
    every combination of `ALLOW_HEADLESS_SOCIAL`, `CDP_VISIBLE_DEFAULT`,
    and `options.allowHeadlessSocial`.
  - New test: `pipelines respect CDP_VISIBLE_DEFAULT=false as user's
    background preference` — verifies the user's Settings choice is
    honored for non-login runs.

- `test/authenticatePlatform.test.js`:
  - New test: `manual auth detection accepts Gemini/Google post-login
    urls` — verifies `isManualAuthComplete` returns `true` for
    `gemini.google.com` URLs and `false` for `accounts.google.com` URLs,
    for both the `google` and `gemini` platform keys.
  - New test: `manual auth detection accepts LinkedIn and X post-login
    urls` — fills the coverage gap for the two platforms that were
    previously untested.

### Verification

- `node --test test/authenticatePlatform.test.js` — 3/3 pass.
- `node --test test/browserBase.test.js` — 8/8 pass (5 original + 3 new).
- `node --test test/platformAdapter.test.js test/platformPolicies.test.js
  test/pipelineGeneralization.test.js` — 5/5 pass (no regressions from
  the `platformCatalog.js` changes).
- Manual smoke check: `getPlatformKeys()` now returns
  `[linkedin, x, facebook, instagram, google, gemini]` on a fresh DB.
- Manual smoke check: `normalizeHeadless` returns `false` for login
  sessions under every env-var combination.
- `.git/` directory untouched.

## N. Mass-Follow Pipeline + TikTok Platform

**Problem:** The engine had no first-class pipeline for bulk-following
accounts across social platforms. The closest existing thing —
`src/campaign/connectionQueue.js` — only followed leads already attached to
a campaign, so the user could not point the engine at an arbitrary list of
handles/URLs and say "follow all of these, slowly, across platforms."
Additionally, TikTok was not a supported platform at all: no automation
module, no entry in `BUILT_IN_PLATFORMS`, no policy profile, no rate-limit
block, and the `platformAdapter` rejected it as "Unsupported platform."

**Fix — introduced a new `mass_follow` pipeline and added TikTok as a
fully-supported platform, end-to-end (automation module → adapter →
catalog → policies → limits → DB seed → scheduler → routes → UI).**

### `gtss-growth-engine/src/automation/tiktok.js` (NEW)

1. New automation module mirroring `src/automation/x.js` shape: a
   `SELECTORS` map (each list ordered most-stable → most-fragile), helper
   functions (`firstVisible`, `getProfileHeader`, `firstVisibleOnProfile`,
   `pageContainsAny`, `detectActionWarning`, `checkAccountStatus`,
   `typeLikeHuman`, `verifyDmSent`), and three public functions:
   - `followUser(page, profileUrl, emit)` → `{ outcome: 'sent' | 'already_connected' | 'failed', reason, failCategory }`
   - `sendDirectMessage(page, profileUrl, message, emit)` → `{ outcome, reason, failCategory }`
   - `likeRecentPost(page, profileUrl, emit)` → `{ outcome, reason }`
2. `sendConnectionRequest` is aliased to `followUser` (same convention as
   `x.js`) so the existing `executor.js` connect/follow dispatch keeps
   working without a special case.
3. Outcomes use the same vocabulary the rest of the engine already speaks
   (`'sent'`, `'already_connected'`, `'failed'`, `'not_connected'`), and
   `failCategory` uses the same set (`'suspended'`, `'not_found'`,
   `'rate_limited'`) so `platformAdapter` can normalize them with no new
   branches.
4. TikTok-specific safety: DMs return `not_connected` (not `failed`) when
   the Message button is hidden — TikTok only allows DMs to mutual
   follows, so this is a soft-skip rather than a hard error.

### `gtss-growth-engine/src/campaign/platformAdapter.js`

1. Added `require("../automation/tiktok")`.
2. Extended the runtime allowlist in BOTH `runConnectionAction` AND
   `runDmAction` from `["linkedin", "instagram", "x", "facebook"]` to
   `["linkedin", "instagram", "x", "facebook", "tiktok"]`. Without this,
   the adapter returned `{ outcome: "failed", error: "Unsupported
   platform: tiktok" }` for every TikTok action.
3. Added a `if (normPlatform === "tiktok")` branch to both functions,
   dispatching to `tiktok.followUser` / `tiktok.sendDirectMessage` and
   normalizing the result into the standard
   `{ outcome, error, metadata, retryable }` shape with the same
   `suspended` / `not_found` / `rate_limited` metadata categories the
   other platforms already use.
4. Each branch ends with a `classifyAndNormalizeError` fallback so an
   unexpected outcome string never returns `undefined` (the same
   defensive pattern used for X and Facebook).

### `gtss-growth-engine/src/services/platformCatalog.js`

1. Added `"tiktok"` to `BUILT_IN_PLATFORMS` so it's recognized from day
   one, even before any DB row exists for it. Without this, the very
   first `/api/sessions/authenticate/tiktok` call would have been
   rejected as "Unknown platform" — the exact bug that previously blocked
   the first Gemini login (see the existing comment in this file).
2. Added `if (key === "tiktok") return "TikTok";` to
   `formatPlatformLabel` so the UI shows "TikTok" instead of "Tiktok".
3. The label fix propagates everywhere `formatPlatformLabel` is used:
   the sign-in modal, the Settings → Limits table, the Pipelines page
   platform checkboxes, and the new Mass-Follow target manager modal.

### `gtss-growth-engine/src/config/limits.js`

1. Added a `tiktok` block with daily `follows: 25`, `likes: 20`,
   `dms: 10` (conservative — TikTok is aggressive on follow-spam), and
   nested `hourly: { follows: 4, likes: 4, dms: 2 }`. These limits are
   consumed by both the mass-follow pipeline (via
   `getEffectiveDailyLimit` / `getEffectiveHourlyLimit`) and the existing
   `database.isWithinLimit` fallback.

### `gtss-growth-engine/src/config/platformPolicies.js`

1. Added a `tiktok` policy profile with
   `activeWindow: { startHour: 9, endHour: 22 }`,
   `delays: { actionMinSeconds: 40, actionMaxSeconds: 110,
   sessionPauseMinutes: 15 }`,
   `warmup: { enabled: true, startDailyCount: 3, dailyIncrement: 2,
   warmupDays: 14 }`, and
   `hourlyLimits: { follows: 4, likes: 4, dms: 2 }`.
2. Updated the file-header comment to list TikTok alongside the other
   platforms.

### `gtss-growth-engine/src/pipeline/massFollowPipeline.js` (NEW)

1. New pipeline runner mirroring `contentPipeline.js`'s shape. Three
   stages: `select_targets → follow → report`.
2. `select_targets` pulls a batch of pending `mass_follow_targets` rows,
   filtered by:
   - Supported platform (the pipeline config's `platforms` array).
   - Active window (skipped if `respect_active_window` is true and the
     platform's policy says we're outside the active window).
   - Daily limit (skipped if `daily_actions` count for the platform's
     `follows`/`connections` action is already at the configured ceiling).
   - Hourly limit (same, but rolling 1-hour window).
   - Retry eligibility (failed targets are only re-picked once their
     `next_retry_at` backoff window has elapsed).
   Per-platform caps distribute `max_follows_per_run` across the eligible
   platforms so no single platform starves the others. The chosen batch
   is saved as a checkpoint so `resume-from-checkpoint` re-runs only the
   follow stage against the same targets.
3. `follow` launches a browser per platform (reusing
   `browserBase.createBrowser` / `createInstagramBrowser`), then for
   each target: claims it atomically (`status='running'`), dispatches
   through `platformAdapter.runConnectionAction`, persists the outcome
   via `recordOutcome`, and sleeps a human-like
   `randomBetween(follow_interval_min_seconds, follow_interval_max_seconds)`
   before the next target. Honors `pipelineState.throwIfAborted` /
   `awaitResume` so Pause/Stop/Resume work mid-batch.
4. `report` writes a summary checkpoint (counts per platform / outcome)
   and a final pipeline log entry.
5. `recordOutcome` (exported as `_internal.recordOutcome` for tests)
   maps adapter outcomes to target lifecycle states:
   - `sent` → target `sent`, +1 daily_actions row, +1 touchpoint
   - `skipped` → target `skipped`, +1 daily_actions row (outcome='skipped')
   - `blocked` → target `failed` (permanent — suspended/restricted)
   - `session_required` → target `pending` (transient — re-auth needed)
   - `failed` → increment `retry_count`; if under `max_retries`,
     schedule exponential backoff (`2^retry` minutes) and keep
     `pending`; if at/over cap, mark terminal `failed`.
6. Public API: `runMassFollowPipeline(config)` wraps the actual run in
   `enqueuePipelineRun("mass_follow", ...)` so only one pipeline runs
   process-wide at a time (mirrors `contentPipeline.runContentPipeline`).
7. Exports `MASS_FOLLOW_STAGES`, `SUPPORTED_PLATFORMS`, and `_internal`
   for tests.

### `gtss-growth-engine/src/db/schema.sql`

1. Added a new `mass_follow_targets` table:
   - `id`, `platform`, `profile_url`, `handle`, `status`, `source`,
     `campaign_id` (FK → campaigns), `lead_id` (FK → leads),
     `error_message`, `retry_count`, `max_retries`, `next_retry_at`,
     `attempted_at`, `sent_at`, `created_at`, `updated_at`.
   - `UNIQUE(platform, profile_url)` for idempotent re-adds.
   - Indexes on `status`, `platform`, `campaign_id`, and
     `(status, next_retry_at)` for the queue queries.
2. Updated the `pipeline_schedules.id` and `pipeline_executions.pipeline_id`
   column comments to list `mass_follow` alongside the other pipeline ids.
3. Updated `pipeline_events.job_type` comment to include `mass_follow`.

### `gtss-growth-engine/src/db/database.js`

1. Added a 4th `INSERT OR IGNORE INTO pipeline_schedules` block in
   `seedDefaultPipelineSchedules` for the `mass_follow` pipeline:
   - `cron: '*/30 * * * *'` (every 30 minutes)
   - `enabled: 0` (off until the user adds targets)
   - `limits_json` defaults: all 5 platforms, `max_follows_per_run: 20`,
     `follow_interval_min_seconds: 40`, `follow_interval_max_seconds: 110`,
     `respect_active_window: true`, `skip_already_following: true`,
     `max_retries_per_target: 3`.
2. Added `pipeline_mass_follow_paused: "false"` to the default settings
   seed so the pause-flag lookup works before the user first opens the
   Pipelines page.

### `gtss-growth-engine/src/jobs/pipelineScheduler.js`

1. Required `runMassFollowPipeline` from the new pipeline module.
2. Added a `mass_follow` entry to the `RUNNERS` map. Soft-errors
   (`'No supported platforms configured'` and `'No eligible targets'`)
   are logged as info and don't flip the pipeline to `failed` — this
   matches the user's mental model that an empty target list is not a
   pipeline failure. Genuine errors propagate so `markExecutionFailed`
   fires.
3. Updated `runPipelineWithLifecycle`'s `totalSteps` computation to
   return `3` for `mass_follow` (matching the 3 stages).

### `gtss-growth-engine/src/routes/pipelines.js`

1. Added `ALLOWED_MASS_FOLLOW_PLATFORMS` set
   (`['instagram', 'linkedin', 'x', 'facebook', 'tiktok']`) — separate
   from the existing outreach/content sets so adding TikTok to
   mass-follow doesn't force TikTok into the outreach/content pipelines
   (where the user might not yet have a TikTok automation flow tested).
2. Added `mass_follow: ['select_targets', 'follow', 'report']` to
   `PIPELINE_STAGES` so the UI's stage-pill renderer works for the new
   pipeline.
3. Extended the numeric-limit validator in `normalizeLimits` to also
   validate `max_follows_per_run`, `follow_interval_min_seconds`,
   `follow_interval_max_seconds`, and `max_retries_per_target`.
4. Added a dedicated `if (id === 'mass_follow')` branch in
   `normalizeLimits` that:
   - Validates the `platforms` array against
     `ALLOWED_MASS_FOLLOW_PLATFORMS`.
   - Rejects configurations where
     `follow_interval_min_seconds > follow_interval_max_seconds`.
   - Coerces `respect_active_window` and `skip_already_following` from
     any reasonable input (`true`/`'true'`/`1`/`'1'`) to a real boolean.
5. Added a `mass_follow` branch to the legacy `GET /:id/history` route
   so the History modal works for the new pipeline.
6. Added five new endpoints under `/api/pipelines/mass-follow/targets`:
   - `GET    /targets` — list with `platform` / `status` filters +
     pagination, returns per-platform status summary.
   - `POST   /targets` — add one or many targets (single-object
     shorthand OR `{ targets: [...] }` array). Idempotent on
     `(platform, profile_url)`; re-adding a failed target resets it to
     `pending`.
   - `DELETE /targets/:id` — remove a single target.
   - `POST   /targets/:id/retry` — reset a single failed target back to
     `pending`.
   - `POST   /targets/clear` — bulk delete by filter (`platform` /
     `status` / `older_than_days`). Refuses to run with no filter as a
     footgun-prevention.
7. Added a `normalizeMassFollowTarget` validator used by the POST
   endpoint. Accepts full URLs and bare handles (`@acme`).

### `gtss-growth-engine/public/js/pipelines.js`

1. Added `mass_follow` to `PIPELINE_META` with `icon: '🟣'`,
   `color: '#a855f7'`, the three stages, and six `limitFields`:
   `max_follows_per_run`, `follow_interval_min_seconds`,
   `follow_interval_max_seconds`, `max_retries_per_target`,
   `respect_active_window`, `skip_already_following`. The render code
   is fully data-driven, so no new rendering code was needed — the card
   appears automatically.
2. Added `'tiktok'` to `ALL_PLATFORMS` so the platform-checkbox
   renderer shows it on every pipeline card that has `platformField:
   true`.
3. Updated `renderPlatformCheckboxes`'s fallback list for `mass_follow`
   so the checkboxes default to all 5 platforms selected.
4. Updated `savePipeline`'s platform-collection branch to include
   `mass_follow` (otherwise saving the mass-follow card would have
   sent an empty `platforms` array).
5. Added a `🎯 Manage Targets` button to `renderActionButtons` for any
   pipeline with `meta.isMassFollow === true`. The button is wired to
   `openMassFollowTargetsModal` in both click-binding sites.
6. Added a full target-manager modal (`openMassFollowTargetsModal`
   plus helpers `renderMassFollowTargetsModal`, `loadMassFollowTargets`,
   `renderMassFollowTable`, `renderMassFollowSummary`,
   `refreshMassFollowTable`, `massFollowStatusBadge`). The modal is
   intentionally step-by-step:
   - **Step 1** — pick a platform (radio buttons for IG / X / LinkedIn /
     Facebook / TikTok), paste handles/URLs (one per line), click Add.
     Bulk-add via the `targets: [...]` array endpoint; idempotent.
   - **Step 2** — review the targets in a filterable table
     (`platform` / `status` dropdowns). Per-row Retry (failed only) and
     Delete buttons. Bulk Clear button with a `confirm()` guard and an
     optional minimum-age prompt.
   - **Step 3** — Run Now button (hits the same
     `/api/pipelines/mass_follow/run` endpoint as the parent card's
     Run button) + a "Back to Pipelines" link.
   The modal closes on ✕, click-outside, or ESC.

### `gtss-growth-engine/public/pages/pipelines.html`

1. Updated the `<meta name="description">` to mention the Mass-Follow
   pipeline alongside the existing three.

### `gtss-growth-engine/test/platformPolicies.test.js`

1. Added TikTok to the assertions in T1 (daily limits) and T2 (hourly
   limits).
2. Added `'tiktok'` to the `platforms` array in T3 so the policy-shape
   loop also validates the new TikTok policy block.

### `gtss-growth-engine/test/massFollowPipeline.test.js` (NEW)

1. 16 tests using the modern `node:test` style with a hermetic
   in-memory SQLite DB (`process.env.DB_PATH = path.join(root, "gtss.db")`).
2. Coverage:
   - `MASS_FOLLOW_STAGES` and `SUPPORTED_PLATFORMS` constants.
   - `selectTargetsBatch` — pending rows, unsupported-platform skip,
     backoff-window respect.
   - `recordOutcome` — sent / skipped / retry-with-backoff /
     terminal-failed / session_required.
   - `runMassFollowPipelineNow` — empty-queue soft-success, no-platforms
     hard-error, full happy-path with stubbed adapter + stubbed
     `browserBase` (so no real browser is launched).
   - TikTok automation module export shape (matches `x.js`).
   - `platformAdapter.runConnectionAction` dispatches to
     `tiktok.followUser` (with the adapter's tiktok branch verified).
   - `platformCatalog.isKnownPlatform('tiktok')` and
     `formatPlatformLabel('tiktok') === 'TikTok'`.
3. Stubs are restored in `finally` blocks so test pollution can't leak
   into the rest of the suite.

### Validation

- `node --check` passes for every modified/new `.js` file (12 files).
- `node --test test/massFollowPipeline.test.js` — 16/16 pass.
- `node --test test/platformAdapter.test.js test/platformPolicies.test.js
  test/pipelineQueue.test.js test/pipelineGeneralization.test.js
  test/pipelineControls.test.js` — all pass (no regressions from the
  platform-catalog / adapter / scheduler / database changes).
- `node scripts/validate-js.js` — 14/14 desktop files OK (the existing
  validator only walks `desktop/`; the engine has no equivalent
  validator, but `node --test` is the engine's safety net).
- `.git/` directory untouched.

---

## Z. TikTok Mass-Follow Pipeline — search-driven, independently testable

**Problem:** The generic `mass_follow` pipeline operates on pre-populated
`mass_follow_targets` rows and follows each target by navigating to its
profile page. For TikTok specifically, this is wasteful: TikTok's
`/search/user` page renders user cards inline, each with its own Follow
button (`data-e2e="follow-back"`) — so we can follow N users from a single
page load instead of N page loads. The user asked for a TikTok-first
mass-follow pipeline that:
  1. Searches TikTok for users by a configurable query (e.g. "restaurant owners")
  2. Scrapes the search-results DOM (verified against the real TikTok markup)
  3. Follows users directly from the search page (no per-profile navigation)
  4. Honors a user-set follow limit per run
  5. Is independently testable (its own pipeline card, Run button, health metrics)

**Solution — a dedicated `tiktok_mass_follow` pipeline that runs alongside
the generic one, with zero changes to existing platform code:**

### New files

#### `gtss-growth-engine/src/automation/tiktokSearch.js`
New TikTok search-page automation module. Public API:
- `buildSearchUrl(query)` — encodes a query into `https://www.tiktok.com/search/user?q=…`
- `scrapeUserCards(page, opts)` — scrapes visible user cards from the
  search page. Each card yields `{ username, displayName, profileUrl,
  followers, likes, followState, cardIndex }`. De-duplicates by username
  across scroll passes. Parses K/M-suffixed stats ("12.1K" → 12100).
- `followUserCard(page, card, emit)` — re-locates a card's follow button
  by username (survives DOM re-renders), classifies its state, clicks it,
  verifies the state transition (Follow → Following / Requested), and
  detects TikTok action warnings (rate limit, temporary block).
- `searchAndFollow(page, query, opts, emit)` — high-level driver: navigate
  → scrape → follow up to `opts.limit` cards, with human-like delays,
  retries on transient failures, and a `shouldStop()` hook for Pause/Stop.

Selector strategy: every selector list is ordered most-stable → most-fragile.
The primary follow-button selector is `button[data-e2e="follow-back"]` —
TikTok's own test hook, which survives class-name rotations. Verified
against the real TikTok DOM (see `scripts/verify-dom-shape.js`): 20 user
cards, 20 follow-back buttons (18 "Follow" + 2 "Following"), 100% match.

#### `gtss-growth-engine/src/pipeline/tiktokMassFollowPipeline.js`
New pipeline module. Mirrors the lifecycle pattern of `massFollowPipeline.js`:
- 3 stages: `search` → `follow` → `report`
- Checkpoint support (resume-from-checkpoint re-runs only the follow stage
  against the cached card list)
- Pause/Stop/Resume honored via `pipelineState.throwIfAborted` / `awaitResume`
- Daily/hourly cap enforcement (clamps the per-run limit to remaining headroom)
- Active-window check (skips the run if TikTok is outside its configured
  9 AM–10 PM window, unless `respect_active_window: false`)
- Rate-limit detection (stops the run early if TikTok returns a
  "following too fast" / "action blocked" warning, so we don't burn the
  daily cap on guaranteed failures)
- Records each follow as a `daily_actions` row (for rate-limit counting)
  + an audit log entry (for the activity feed)

Config shape (from `limits_json`):
```
{
  search_query:               "restaurant owners",  // required
  max_follows_per_run:        20,                    // user-set limit
  follow_interval_min_seconds: 40,
  follow_interval_max_seconds: 110,
  max_scrolls:                3,                     // discovery scroll passes
  respect_active_window:      true
}
```

#### `gtss-growth-engine/scripts/migrate-tiktok-mass-follow.js`
One-shot migration that adds the `tiktok_mass_follow` pipeline schedule
row + the `pipeline_tiktok_mass_follow_paused` setting to existing
databases. Fresh databases get these for free via
`seedDefaultPipelineSchedules`. Idempotent (uses `INSERT OR IGNORE`).

Run with: `node scripts/migrate-tiktok-mass-follow.js`

#### `gtss-growth-engine/scripts/verify-dom-shape.js`
Dev tool that confirms `tiktokSearch.js` selectors still match the real
TikTok search DOM. Pass a path to a `people.html` export (or let it
auto-discover one in the project root). Reports: anchor count, button
count, button-label distribution (Follow vs Following), and whether the
selectors match.

Run with: `node scripts/verify-dom-shape.js [path/to/people.html]`

#### `gtss-growth-engine/test/tiktokSearch.test.js`
Unit tests for the pure helpers (`buildSearchUrl`, `usernameFromHref`,
`parseStatCount`, selector shape) + the `scrapeUserCards` function (fed
a minimal mocked Playwright page). Mirrors the test style of
`massFollowPipeline.test.js`. 9 tests covering:
- URL encoding (plain, unicode, special chars, empty)
- Username extraction (valid handles, non-profile hrefs, empty input)
- Stat parsing (plain, K, M, comma-separated, empty, unparseable)
- Selector ordering (followButton[0] must target `data-e2e="follow-back"`)
- Card scraping (display name, username, followers, likes, follow state)
- De-duplication across scroll passes
- K-suffixed follower counts (12.1K → 12100)

### Modified files

#### `gtss-growth-engine/src/jobs/pipelineScheduler.js`
- Imported `runTikTokMassFollowPipeline` from the new pipeline module.
- Registered a `tiktok_mass_follow` runner in the `RUNNERS` map. Soft-skips
  on "No search_query configured" or `summary.skipped` (active window /
  rate cap) so the pipeline doesn't flip to 'failed' just because the user
  hasn't configured a query yet or the run was outside the active window.
- Updated `totalSteps` calculation: `tiktok_mass_follow` has 3 stages
  (search, follow, report), matching `mass_follow`.

#### `gtss-growth-engine/src/routes/pipelines.js`
- Added `tiktok_mass_follow` to `PIPELINE_STAGES` (`['search', 'follow', 'report']`).
- Added `tiktok_mass_follow` block to `normalizeLimits()` — validates
  `search_query` (string, max 200 chars), `respect_active_window` (boolean),
  clamps `max_follows_per_run` to 1–200, and enforces
  `follow_interval_min_seconds ≤ follow_interval_max_seconds`.
- Added `max_scrolls` to the global numeric-field validation list.
- Added `search_query`-required guards to both the `POST /:id/run` and
  `POST /:id/restart` endpoints (returns 400 if the query is empty).
- Added `tiktok_mass_follow` branch to the `GET /:id/history` endpoint
  (returns recent `pipeline_executions` rows for the new pipeline).
- New endpoint: `POST /api/pipelines/tiktok-mass-follow/preview-search`
  Launches a TikTok browser, navigates to `/search/user?q=<query>`,
  scrapes the visible user cards, returns them as JSON. No follows are
  performed. Used by the "🔍 Preview Search" button in the UI to let the
  user sanity-check a query before committing a follow run.

#### `gtss-growth-engine/src/db/database.js`
- Seeded the `tiktok_mass_follow` pipeline schedule row in
  `seedDefaultPipelineSchedules()`. Default config:
  `{"search_query": "restaurant owners", "max_follows_per_run": 20,
   "follow_interval_min_seconds": 40, "follow_interval_max_seconds": 110,
   "max_scrolls": 3, "respect_active_window": true}`, disabled by default
  (cron `*/30 * * * *`).
- Added `pipeline_tiktok_mass_follow_paused: "false"` to the default
  settings map (so the pause flag exists from day one).

#### `gtss-growth-engine/public/js/pipelines.js`
- Added `tiktok_mass_follow` entry to `PIPELINE_META` with:
  - icon `⚫`, color `#fe2c55` (TikTok brand red)
  - stages `['search', 'follow', 'report']`
  - limit fields: `search_query` (text), `max_follows_per_run` (number —
    the user-set follow limit), `follow_interval_min_seconds`,
    `follow_interval_max_seconds`, `max_scrolls`, `respect_active_window`
  - `isTiktokMassFollow: true` flag (drives the "🔍 Preview Search" button)
- Added a "🔍 Preview Search" button to the pipeline card actions,
  rendered only when `meta.isTiktokMassFollow` is true. Wired to
  `openTikTokSearchPreviewModal(id, btn)` in both action-handler locations.
- New modal: `renderTikTokSearchPreviewModal(id)` + `renderTikTokSearchResultsTable(cards)`
  + `openTikTokSearchPreviewModal(id, btn)`. The modal lets the user:
  1. Enter/edit the search query (pre-filled from the saved config)
  2. Click "🔍 Preview" to call the preview-search endpoint and see the
     discovered user cards in a table (name, @username, followers, likes,
     follow state, profile link)
  3. Set the follow limit for the run (pre-filled from saved config)
  4. "💾 Save query + limit" — PATCHes the pipeline config
  5. "▶ Run pipeline now" — saves then triggers `POST /:id/run`
- ESC closes the modal; click-outside closes; Back to Pipelines link closes.

### Verification

- `node --check` passes for all 7 modified/new `.js` files.
- `node scripts/verify-dom-shape.js` against the user-provided
  `people.html` (real TikTok search DOM) confirms selectors match:
  20 user-card anchors, 20 follow-back buttons (18 Follow + 2 Following),
  100% selector match.
- Pure-helper logic verified in isolation: `buildSearchUrl`,
  `usernameFromHref`, `parseStatCount` all produce expected outputs.
- `.git/` directory untouched.
