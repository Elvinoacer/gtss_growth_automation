Master

You are working inside an existing production codebase called `gtss-growth-engine`.

Rules:

* NEVER rewrite entire files unless explicitly requested.
* ALWAYS inspect existing implementations before coding.
* Reuse existing architecture patterns from LinkedIn integration.
* Preserve backward compatibility.
* Follow the existing coding style exactly.
* Return:

  1. Analysis of existing architecture
  2. Exact files to modify
  3. Step-by-step implementation plan
  4. Final code changes
  5. Edge cases handled
  6. Test checklist

Critical:

* Do not invent functions that already exist.
* Do not hardcode platform-specific behavior if the system already supports platform abstraction.
* Do not remove LinkedIn functionality.
* Prefer additive changes over destructive changes.
* Keep all automation resilient against selector failures.
* Use defensive Playwright patterns with retries and visibility checks.


Update `src/automation/browserBase.js` to support X authentication state detection.

Tasks:

1. Inspect existing platform auth detection logic.

2. Add X-specific detection:

   * authenticated
   * login_required
   * captcha_required
   * unknown_state
   * rate_limited (if detectable)

3. Use resilient selectors.

4. Preserve existing platform behavior.

5. Return:

   * Exact code diff
   * Explanation of detection flow
   * Edge cases
   * Test scenarios

Important:

* Do not break LinkedIn auth detection.
* Follow existing AUTH_STATES architecture.
