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
