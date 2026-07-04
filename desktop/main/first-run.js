/**
 * FirstRun — decides whether the onboarding wizard should run, and exposes
 * the small set of operations the wizard UI needs (set passphrase, set
 * Gemini key, open platform login pages in the bundled Chrome).
 */

const { shell } = require("electron");
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

  /**
   * Open a platform login page in the user's default browser. The user logs
   * in normally; the cookies are then available to the bundled Chrome via the
   * copied profile.
   */
  async openPlatformLogin(platform) {
    const urls = {
      linkedin: "https://www.linkedin.com/login",
      x: "https://x.com/i/flow/login",
      facebook: "https://www.facebook.com/login",
      instagram: "https://www.instagram.com/accounts/login/",
    };
    const url = urls[platform];
    if (!url) throw new Error(`Unknown platform: ${platform}`);
    await shell.openExternal(url);
  }
}

module.exports = { FirstRun };
