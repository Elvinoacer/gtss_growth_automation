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
