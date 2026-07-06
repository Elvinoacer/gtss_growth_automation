# Changes — gtss_growth_automation

This document summarises the edits made to the project in this pass. The
`.git` directory is untouched.

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
