/**
 * Settings Routes — Credentials (Gemini, Gmail, Passphrase)
 *
 * Express handlers for storing and live-testing credentials:
 *   POST /gemini-key    — Save the Gemini API key (also sets process.env.GEMINI_API_KEY)
 *   POST /test-gemini   — Live-test the Gemini API key with a one-word prompt
 *   POST /gmail         — Save Gmail address + app password (also sets process.env.GMAIL_*)
 *   POST /test-email    — Send a test email to the configured Gmail address
 *   POST /passphrase    — Change the app passphrase (verifies current, validates new + confirm, bcrypt-hashes, writes to .env)
 *
 * Cross-file dependencies: bcryptjs, nodemailer, ../../utils/envWriter
 * (upsertEnvValue), ./shared (upsertSetting, getRawSetting).
 *
 * Extracted from the original routes/settings.js for maintainability.
 */

const bcrypt = require("bcryptjs");
const nodemailer = require("nodemailer");
const { upsertEnvValue } = require("../../utils/envWriter");
const { upsertSetting, getRawSetting } = require("./shared");

/**
 * Register the credential management routes on the given router.
 *
 * @param {import('express').Router} router
 */
function registerCredentialsRoutes(router) {
  router.post("/gemini-key", (req, res) => {
    const apiKey = String(req.body.apiKey || "").trim();
    if (!apiKey) {
      return res.status(400).json({ error: "Gemini API key is required" });
    }

    upsertEnvValue("GEMINI_API_KEY", apiKey);
    upsertSetting("gemini_api_key", apiKey);
    process.env.GEMINI_API_KEY = apiKey;
    return res.json({ success: true });
  });

  router.post("/test-gemini", async (req, res) => {
    try {
      const apiKey =
        getRawSetting("gemini_api_key") || process.env.GEMINI_API_KEY;
      if (!apiKey) {
        return res.json({
          valid: false,
          error: "Gemini API key is not configured",
        });
      }

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${process.env.GEMINI_MODEL || "gemini-2.5-flash-lite"}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: "Say hello in one word" }] }],
          }),
        },
      );
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        return res.json({
          valid: false,
          error: data.error
            ? data.error.message
            : `Gemini returned ${response.status}`,
        });
      }

      return res.json({ valid: true });
    } catch (error) {
      return res.json({ valid: false, error: error.message });
    }
  });

  router.post("/gmail", (req, res) => {
    const email = String(req.body.email || "").trim();
    const appPassword = String(req.body.appPassword || "");

    if (!email || !appPassword) {
      return res
        .status(400)
        .json({ error: "Gmail address and app password are required" });
    }

    upsertEnvValue("GMAIL_USER", email);
    upsertEnvValue("GMAIL_APP_PASSWORD", appPassword);
    upsertSetting("gmail_user", email);
    upsertSetting("gmail_app_password", appPassword);
    process.env.GMAIL_USER = email;
    process.env.GMAIL_APP_PASSWORD = appPassword;
    return res.json({ success: true });
  });

  router.post("/test-email", async (req, res) => {
    try {
      const email = getRawSetting("gmail_user") || process.env.GMAIL_USER;
      const appPassword =
        getRawSetting("gmail_app_password") || process.env.GMAIL_APP_PASSWORD;

      if (!email || !appPassword) {
        return res.status(400).json({ error: "Gmail is not configured" });
      }

      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: {
          user: email,
          pass: appPassword,
        },
      });

      await transporter.sendMail({
        from: email,
        to: email,
        subject: "GTSS Growth Engine test email",
        text: "Your GTSS Growth Engine email notifications are configured.",
      });

      return res.json({ sent: true });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  router.post("/passphrase", async (req, res) => {
    const { currentPassphrase, newPassphrase, confirmPassphrase } = req.body;
    const hash = process.env.PASSPHRASE_HASH || "";

    if (!hash || !(await bcrypt.compare(currentPassphrase || "", hash))) {
      return res.status(400).json({ error: "Current passphrase is incorrect" });
    }

    if (!newPassphrase || newPassphrase.length < 8) {
      return res
        .status(400)
        .json({ error: "New passphrase must be at least 8 characters" });
    }

    if (newPassphrase !== confirmPassphrase) {
      return res.status(400).json({ error: "New passphrases do not match" });
    }

    const nextHash = await bcrypt.hash(newPassphrase, 10);
    // Write to the runtime .env (DOTENV_CONFIG_PATH / GTSS_ENV_PATH when
    // packaged — see envWriter.js) AND to the settings table so passphrase
    // is not the only setting living exclusively in a flat file.
    upsertEnvValue("PASSPHRASE_HASH", nextHash);
    upsertSetting("passphrase_hash", nextHash);
    process.env.PASSPHRASE_HASH = nextHash;

    return res.json({ success: true });
  });
}

module.exports = { registerCredentialsRoutes };
