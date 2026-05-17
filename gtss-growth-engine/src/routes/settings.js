const fs = require("fs");
const path = require("path");
const express = require("express");
const bcrypt = require("bcryptjs");
const nodemailer = require("nodemailer");
const { renderPage } = require("./pageRenderer");
const { getDb, initializeDatabase } = require("../db/database");
const defaultTemplates = require("../config/templates.json");
const defaultLimits = require("../config/limits");
const { upsertEnvValue } = require("../utils/envWriter");
const {
  getPlatformCatalog,
  getLimitFields,
} = require("../services/platformCatalog");

const pageRouter = express.Router();
const apiRouter = express.Router();
const packageJson = require("../../package.json");
const sensitiveKeys = new Set(["PASSPHRASE_HASH", "passphrase_hash"]);
const apiKeyPatterns = [/api_key/i, /app_password/i, /password/i];

pageRouter.get("/", (req, res) => {
  renderPage(res, {
    title: "Settings",
    primaryHeading: "Configure growth engine",
    primaryCopy:
      "Update limits, templates, account credentials, and platform session storage settings.",
  });
});

apiRouter.get("/", (req, res) => {
  const catalog = getPlatformCatalog();
  const rows = getDb()
    .prepare("SELECT key, value FROM settings ORDER BY key")
    .all();
  const settings = {};

  rows.forEach((row) => {
    if (sensitiveKeys.has(row.key)) {
      return;
    }

    settings[row.key] = shouldMask(row.key)
      ? maskSecret(row.value)
      : parseSettingValue(row.value);
  });

  settings.limits = getStoredLimits();
  settings.loadedLimits = clone(settings.limits);
  settings.platforms = catalog.entries;
  settings.platformKeys = catalog.keys;
  settings.platformLabels = catalog.labels;
  settings.limitFields = getLimitFields();
  settings.appVersion = packageJson.version;

  res.json(settings);
});

apiRouter.post("/gemini-key", (req, res) => {
  const apiKey = String(req.body.apiKey || "").trim();
  if (!apiKey) {
    return res.status(400).json({ error: "Gemini API key is required" });
  }

  upsertSetting("gemini_api_key", apiKey);
  process.env.GEMINI_API_KEY = apiKey;
  return res.json({ success: true });
});

apiRouter.post("/test-gemini", async (req, res) => {
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

apiRouter.post("/gmail", (req, res) => {
  const email = String(req.body.email || "").trim();
  const appPassword = String(req.body.appPassword || "");

  if (!email || !appPassword) {
    return res
      .status(400)
      .json({ error: "Gmail address and app password are required" });
  }

  upsertSetting("gmail_user", email);
  upsertSetting("gmail_app_password", appPassword);
  process.env.GMAIL_USER = email;
  process.env.GMAIL_APP_PASSWORD = appPassword;
  return res.json({ success: true });
});

apiRouter.post("/test-email", async (req, res) => {
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

apiRouter.patch("/limits", (req, res) => {
  const nextLimits = req.body || {};
  const validationError = validateLimits(nextLimits);

  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  upsertSetting("daily_limits", JSON.stringify(nextLimits));

  return res.json({ success: true });
});

apiRouter.patch("/notifications", (req, res) => {
  const notifications = {
    lead_replies: Boolean(req.body.lead_replies),
    session_expired: Boolean(req.body.session_expired),
    daily_limit_reached: Boolean(req.body.daily_limit_reached),
    automation_errors: Boolean(req.body.automation_errors),
  };

  upsertSetting("notification_settings", JSON.stringify(notifications));
  return res.json({ success: true });
});

apiRouter.post("/passphrase", async (req, res) => {
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
  upsertEnvValue("PASSPHRASE_HASH", nextHash);
  process.env.PASSPHRASE_HASH = nextHash;

  return res.json({ success: true });
});

apiRouter.get("/templates", (req, res) => {
  res.json(getTemplates());
});

apiRouter.patch("/templates/:platform", (req, res) => {
  const platform = req.params.platform;
  const template = String(req.body.template || "");

  if (!Object.prototype.hasOwnProperty.call(defaultTemplates, platform)) {
    return res.status(404).json({ error: "Template not found" });
  }

  upsertSetting(`template_${platform}`, template);
  return res.json({ success: true });
});

apiRouter.post("/templates/:platform/reset", (req, res) => {
  const platform = req.params.platform;
  const defaultTemplate = defaultTemplates[platform];

  if (typeof defaultTemplate !== "string") {
    return res.status(404).json({ error: "Template not found" });
  }

  upsertSetting(`template_${platform}`, defaultTemplate);
  return res.json({ template: defaultTemplate });
});

// Apply the current active template to ALL existing messages in the system
apiRouter.post("/templates/apply-all", (req, res) => {
  const db = getDb();
  const templates = getTemplates();

  // Get all non-follow-up messages with FULL lead info for variable substitution
  const messages = db.prepare(`
    SELECT m.id, m.lead_id, m.platform, l.name, l.company, l.role, l.location, l.score_reason
    FROM messages m
    JOIN leads l ON l.id = m.lead_id
    WHERE m.is_follow_up = 0 OR m.is_follow_up IS NULL
  `).all();

  if (messages.length === 0) {
    return res.json({ success: true, updated: 0, message: "No messages to update" });
  }

  const updateStmt = db.prepare("UPDATE messages SET body = ?, generated_by = 'template' WHERE id = ?");

  let updated = 0;
  const txn = db.transaction(() => {
    for (const msg of messages) {
      const platform = msg.platform || "linkedin";
      const messageType = platform === "linkedin" ? "connect" : "dm";
      const templateKey = `${platform}_${messageType}`;
      const template = templates[templateKey] || templates[`${platform}_dm`] || "";

      if (!template) continue;

      // Substitute ALL template variables
      const body = template
        .replace(/\{\{lead_name\}\}/g, msg.name || "there")
        .replace(/\{\{company\}\}/g, msg.company || "your business")
        .replace(/\{\{role\}\}/g, msg.role || "")
        .replace(/\{\{location\}\}/g, msg.location || "Kenya")
        .replace(/\{\{product\}\}/g, "Restaurant Manager")
        .replace(/\{\{pain_point\}\}/g, "operational efficiency");

      updateStmt.run(body, msg.id);
      updated++;
    }
  });

  txn();
  return res.json({ success: true, updated, total: messages.length });
});

apiRouter.post("/clear-data", (req, res) => {
  if (req.body.confirmation !== "DELETE") {
    return res.status(400).json({ error: "Type DELETE to confirm" });
  }

  const db = getDb();
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .all();

  db.exec("PRAGMA foreign_keys = OFF");
  tables.forEach((table) => {
    db.prepare(`DROP TABLE IF EXISTS ${table.name}`).run();
  });
  db.exec("PRAGMA foreign_keys = ON");
  initializeDatabase();

  return res.json({ success: true });
});

function upsertSetting(key, value) {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value)
       VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value);
}

function getRawSetting(key) {
  const row = getDb()
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key);
  return row ? row.value : null;
}

function getStoredLimits() {
  const value = getRawSetting("daily_limits");
  if (!value) {
    return clone(defaultLimits);
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    return clone(defaultLimits);
  }
}

function getTemplates() {
  const templates = { ...defaultTemplates };
  const rows = getDb()
    .prepare("SELECT key, value FROM settings WHERE key LIKE 'template_%'")
    .all();

  rows.forEach((row) => {
    templates[row.key.replace("template_", "")] = row.value;
  });

  return templates;
}

function shouldMask(key) {
  return apiKeyPatterns.some((pattern) => pattern.test(key));
}

function maskSecret(value) {
  if (!value) {
    return "";
  }

  if (value.length <= 6) {
    return `${value.slice(0, 1)}...${value.slice(-1)}`;
  }

  return `${value.slice(0, 3)}...${value.slice(-3)}`;
}

function parseSettingValue(value) {
  try {
    return JSON.parse(value);
  } catch (error) {
    return value;
  }
}

function validateLimits(nextLimits) {
  const expectedPlatforms = getPlatformCatalog().keys;

  for (const platform of expectedPlatforms) {
    if (!nextLimits[platform]) {
      return `Missing limits for ${platform}`;
    }
  }

  for (const [platform, fields] of Object.entries(nextLimits)) {
    if (!expectedPlatforms.includes(platform)) {
      return `Unexpected limits for ${platform}`;
    }

    if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
      return `Missing limits for ${platform}`;
    }

    for (const [field, rawValue] of Object.entries(fields)) {
      const value = Number(rawValue);
      if (!Number.isInteger(value) || value < 1 || value > 200) {
        return `${platform}.${field} must be an integer between 1 and 200`;
      }
      nextLimits[platform][field] = value;
    }
  }

  return null;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// Pipeline settings
// ---------------------------------------------------------------------------
const pipelineConfig = require('../config/pipelineConfig');

apiRouter.get('/pipeline', (req, res) => {
  res.json({
    pipelineMode: process.env.PIPELINE_MODE || 'ai',
    discoveryMode: process.env.DISCOVERY_MODE || '',
    qualificationMode: process.env.QUALIFICATION_MODE || '',
    messageMode: process.env.MESSAGE_MODE || '',
    sendMode: process.env.SEND_MODE || '',
    qualificationThreshold: pipelineConfig.qualificationThreshold(),
    qualificationManualScore: pipelineConfig.manualQualificationScore(),
    autoApproveVariant: pipelineConfig.autoApproveVariant(),
    pipelineCron: pipelineConfig.pipelineCron(),
  });
});

apiRouter.patch('/pipeline', (req, res) => {
  const fields = {
    pipelineMode: 'PIPELINE_MODE',
    discoveryMode: 'DISCOVERY_MODE',
    qualificationMode: 'QUALIFICATION_MODE',
    messageMode: 'MESSAGE_MODE',
    sendMode: 'SEND_MODE',
    qualificationThreshold: 'QUALIFICATION_THRESHOLD',
    qualificationManualScore: 'QUALIFICATION_MANUAL_SCORE',
    autoApproveVariant: 'MESSAGE_AUTO_APPROVE_VARIANT',
    pipelineCron: 'PIPELINE_CRON',
  };

  const updated = [];

  for (const [bodyKey, envKey] of Object.entries(fields)) {
    if (req.body[bodyKey] !== undefined) {
      const value = String(req.body[bodyKey]).trim();
      upsertEnvValue(envKey, value);
      process.env[envKey] = value;
      updated.push(bodyKey);
    }
  }

  if (updated.length === 0) {
    return res.status(400).json({ error: 'No pipeline settings provided' });
  }

  return res.json({ success: true, updated });
});

module.exports = pageRouter;
module.exports.apiRouter = apiRouter;
