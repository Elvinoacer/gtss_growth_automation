/**
 * FirstRun — decides whether the onboarding wizard should run.
 *
 * Onboarding is intentionally minimal: it only collects the two pieces of
 * information that MUST exist before the server can boot:
 *
 *   1. The encryption passphrase (used as the login for the web app).
 *   2. The Gemini API key (optional — can be added later in the web app's
 *      Settings if the user wants to skip it).
 *
 * Everything else — platform logins (LinkedIn/X/Facebook/Instagram),
 * outreach settings, pipeline cron, etc. — is handled by the web app's
 * Settings page. The launcher does NOT duplicate those.
 */

const path = require("path");
const fs = require("fs");

class FirstRun {
  constructor({ envBootstrap }) {
    this.env = envBootstrap;
    // Sentinel file marks "user has completed onboarding at least once".
    this.sentinel = path.join(envBootstrap.dataRoot, ".onboarded");
  }

  async isRequired() {
    return !fs.existsSync(this.sentinel) || !this.env.isOnboardingComplete();
  }

  async complete(passphrase, geminiKey) {
    if (passphrase) {
      await this.env.setPassphrase(passphrase);
    }
    if (geminiKey) {
      this.env.setGeminiKey(geminiKey);
    }
    fs.writeFileSync(this.sentinel, new Date().toISOString(), { mode: 0o600 });
  }
}

module.exports = { FirstRun };
