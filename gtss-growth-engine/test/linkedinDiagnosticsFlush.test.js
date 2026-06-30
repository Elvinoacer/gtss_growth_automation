const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

/**
 * Regression test for the bug where:
 *   - User sets AUTOMATION_ARTIFACTS_DIR=/var/log/gtss/automation
 *     (a path that requires root to create).
 *   - LINKEDIN_DM_DEBUG=true causes sendDirectMessage to call
 *     diag.flush(profileUrl) in a `finally` block.
 *   - The old flush() called fs.mkdirSync() outside a try/catch,
 *     which threw EACCES. Because it ran in a `finally` block,
 *     the throw replaced the original `premium_required` outcome,
 *     and the executor mistook the action for a hard failure,
 *     eventually tripping the circuit breaker and aborting the run.
 *
 * After the fix: flush() catches mkdir failures, logs a warning, and
 * returns null. The original outcome is preserved.
 */

// Pick a path the current process definitely cannot create.
// /var/log/... is the user's actual config; on most CI/dev machines the
// non-root user can't create it. If for some reason it CAN (e.g. tests
// running as root in a container), use a guaranteed-unwritable path under
// /proc which is a virtual filesystem that rejects all writes.
function pickUnwritableDir() {
  const candidates = [
    '/var/log/gtss-test-unwritable-' + process.pid,
    '/proc/gtss-test-cannot-exist',
  ];
  for (const c of candidates) {
    try {
      fs.mkdirSync(c, { recursive: true });
      // We were able to create it — clean up and try the next candidate.
      try { fs.rmdirSync(c, { recursive: true }); } catch (_) {}
    } catch (_) {
      return c; // Good — this path is unwritable for us.
    }
  }
  // Last resort: a path with a NUL byte in it, which mkdir will reject.
  return path.join(os.tmpdir(), 'cannot\u0000create');
}

const unwritableDir = pickUnwritableDir();

// Set env BEFORE requiring the module under test.
process.env.AUTOMATION_ARTIFACTS_DIR = unwritableDir;
process.env.LINKEDIN_DM_DEBUG = 'true';
process.env.LINKEDIN_DM_DEBUG_SCREENSHOTS = 'true';

const diag = require('../src/automation/linkedinDiagnostics.js');

test('diag.flush() does not throw when AUTOMATION_ARTIFACTS_DIR is unwritable', () => {
  // flush() with an empty buffer short-circuits and returns null.
  // The bug was that even this short-circuit path used to throw because
  // mkdirSync ran before the _steps.length check (after the fix, mkdir
  // is gated behind the _steps.length > 0 check and is also wrapped in
  // a try/catch).
  let result;
  assert.doesNotThrow(() => {
    result = diag.flush('https://www.linkedin.com/in/test-profile');
  }, 'flush() must not throw when artifacts dir is unwritable');
  assert.equal(result, null);
});

test('diag.flush() preserves the caller\'s original outcome when called from a finally block', async () => {
  // Simulate the exact structure of sendDirectMessage:
  //   try { return { outcome: 'premium_required', ... }; }
  //   finally { diag.flush(profileUrl); }
  //
  // Before the fix: the throw from flush() replaced the return value,
  //   so the caller saw an exception instead of `premium_required`.
  // After the fix: flush() returns null (or a path), the original
  //   return value is preserved.
  async function fakeSendDirectMessage() {
    try {
      return {
        outcome: 'premium_required',
        reason: 'LinkedIn Premium required to message this profile',
      };
    } finally {
      diag.flush('https://www.linkedin.com/in/sheilah-n-45753488');
    }
  }

  const result = await fakeSendDirectMessage();
  assert.equal(result.outcome, 'premium_required');
  assert.match(result.reason, /LinkedIn Premium required/);
});

test('diag.isEnabled() reflects LINKEDIN_DM_DEBUG env', () => {
  assert.equal(diag.isEnabled(), true);
});
