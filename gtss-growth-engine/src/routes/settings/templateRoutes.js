/**
 * Settings Routes — Templates & Data Management
 *
 * Express handlers for the per-platform DM/connection templates and the
 * destructive "clear all data" reset:
 *   GET   /templates                  — Read every per-platform template (defaults overridden by stored overrides)
 *   PATCH /templates/:platform        — Override a single platform's template
 *   POST  /templates/:platform/reset  — Reset a single platform's template back to its default
 *   POST  /templates/apply-all        — Re-render every non-follow-up message with the current active template (substituting lead + product context vars)
 *   POST  /clear-data                 — Drop every table (requires body.confirmation === "DELETE") and re-initialize the schema
 *
 * Cross-file dependencies: ../../db/database (getDb, initializeDatabase),
 * ../../config/templates.json (defaultTemplates — for the reset default),
 * ../../services/contextService (getContext — for the template-variable
 * substitution in /templates/apply-all), ./shared (upsertSetting, getTemplates).
 *
 * Extracted from the original routes/settings.js for maintainability.
 */

const { getDb, initializeDatabase } = require("../../db/database");
const defaultTemplates = require("../../config/templates.json");
const { getContext } = require("../../services/contextService");
const { upsertSetting, getTemplates } = require("./shared");

/**
 * Register the template + data-management routes on the given router.
 *
 * @param {import('express').Router} router
 */
function registerTemplateRoutes(router) {
  router.get("/templates", (req, res) => {
    res.json(getTemplates());
  });

  router.patch("/templates/:platform", (req, res) => {
    const platform = req.params.platform;
    const template = String(req.body.template || "");

    if (!Object.prototype.hasOwnProperty.call(defaultTemplates, platform)) {
      return res.status(404).json({ error: "Template not found" });
    }

    upsertSetting(`template_${platform}`, template);
    return res.json({ success: true });
  });

  router.post("/templates/:platform/reset", (req, res) => {
    const platform = req.params.platform;
    const defaultTemplate = defaultTemplates[platform];

    if (typeof defaultTemplate !== "string") {
      return res.status(404).json({ error: "Template not found" });
    }

    upsertSetting(`template_${platform}`, defaultTemplate);
    return res.json({ template: defaultTemplate });
  });

  // Apply the current active template to ALL existing messages in the system
  router.post("/templates/apply-all", (req, res) => {
    const db = getDb();
    const templates = getTemplates();

    // Get all non-follow-up messages with FULL lead info for variable substitution
    const messages = db
      .prepare(
        `
      SELECT m.id, m.lead_id, m.platform, l.name, l.company, l.role, l.location, l.score_reason
      FROM messages m
      JOIN leads l ON l.id = m.lead_id
      WHERE m.is_follow_up = 0 OR m.is_follow_up IS NULL
    `,
      )
      .all();

    if (messages.length === 0) {
      return res.json({
        success: true,
        updated: 0,
        message: "No messages to update",
      });
    }

    const updateStmt = db.prepare(
      "UPDATE messages SET body = ?, generated_by = 'template' WHERE id = ?",
    );

    let updated = 0;
    const txn = db.transaction(() => {
      for (const msg of messages) {
        const platform = msg.platform || "linkedin";
        const messageType = platform === "linkedin" ? "connect" : "dm";
        const templateKey = `${platform}_${messageType}`;
        const template =
          templates[templateKey] || templates[`${platform}_dm`] || "";

        if (!template) continue;

        // Substitute ALL template variables
        const ctx = getContext();
        const painPoints = Array.isArray(ctx.ctx_product_pain_points)
          ? ctx.ctx_product_pain_points
          : [];
        const geographies = Array.isArray(ctx.ctx_audience_geographies)
          ? ctx.ctx_audience_geographies
          : [];
        const firstName =
          String(msg.name || "there")
            .trim()
            .split(/\s+/)[0] || "there";

        const body = template
          .replace(/\{\{lead_name\}\}/g, firstName)
          .replace(/\{\{company\}\}/g, msg.company || "your business")
          .replace(/\{\{role\}\}/g, msg.role || "")
          .replace(/\{\{location\}\}/g, msg.location || geographies[0] || "Kenya")
          .replace(/\{\{product\}\}/g, ctx.ctx_product_name)
          .replace(/\{\{product_tagline\}\}/g, ctx.ctx_product_tagline)
          .replace(
            /\{\{pain_point\}\}/g,
            painPoints[0] || "managing operations efficiently",
          )
          .replace(/\{\{value_prop\}\}/g, ctx.ctx_product_value_prop)
          .replace(/\{\{sender_name\}\}/g, ctx.ctx_sender_name)
          .replace(/\{\{sign_off\}\}/g, ctx.ctx_sender_sign_off)
          .replace(/\{\{cta\}\}/g, ctx.ctx_content_cta)
          .replace(/\{\{biz_name\}\}/g, ctx.ctx_biz_name);

        updateStmt.run(body, msg.id);
        updated++;
      }
    });

    txn();
    return res.json({ success: true, updated, total: messages.length });
  });

  router.post("/clear-data", (req, res) => {
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
}

module.exports = { registerTemplateRoutes };
