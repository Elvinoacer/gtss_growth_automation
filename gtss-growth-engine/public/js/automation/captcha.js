/* global gtss */
/**
 * automation/captcha.js — CAPTCHA banner show + manual-open / manual-resume
 * handlers for the Automation Control page.
 *
 * Pulled verbatim from the original automation.js IIFE (lines 920-946).
 * showCaptchaWarning is called by execution.js's onAutomationLog socket
 * handler whenever a "captcha" event arrives.
 *
 * Exposes (via global scope):
 *   - showCaptchaWarning(platform) — sets currentCaptchaPlatform, shows
 *     the captcha banner with the platform name
 *
 * Top-level bindings (registered at script-load time):
 *   - manualOpenBtn   "click" → POST /api/automation/open-browser/:platform
 *     (opens a visible browser window so the user can solve the captcha
 *     manually)
 *   - manualResumeBtn "click" → hide the banner + startAutomation()
 *     (resumes the run after the user has solved the captcha)
 */

// ----------------------------------------------------------------
// Authentication & Captcha
// ----------------------------------------------------------------

function showCaptchaWarning(platform) {
  currentCaptchaPlatform = platform;
  captchaPlatformText.textContent = platform;
  captchaBanner.style.display = "flex";
}

manualOpenBtn.addEventListener("click", async () => {
  if (!currentCaptchaPlatform) return;
  try {
    showToast(
      `Opening visible browser for ${currentCaptchaPlatform}`,
      "info",
    );
    await fetchJSON(
      `/api/automation/open-browser/${currentCaptchaPlatform}`,
      { method: "POST" },
    );
  } catch (err) {
    showToast(err.message, "error");
  }
});

manualResumeBtn.addEventListener("click", () => {
  captchaBanner.style.display = "none";
  currentCaptchaPlatform = null;
  startAutomation(); // Resumes run
});
