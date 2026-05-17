const path = require("path");
const fs = require("fs");
const { getDb } = require("../db/database");
const { getPrimaryPlatform } = require("./platformCatalog");
const { callGeminiText } = require("./aiService");
const logger = require("../utils/logger");
const {
  stageMode,
  autoApproveVariant,
} = require("../config/pipelineConfig");

// ---------------------------------------------------------------------------
// SSE infrastructure (mirrors qualificationService pattern)
// ---------------------------------------------------------------------------

const jobStreams = new Map();
const jobEventHistory = new Map();
const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 2500;

function registerJobStream(jobId, res) {
  const key = String(jobId);
  if (!jobStreams.has(key)) jobStreams.set(key, new Set());

  jobStreams.get(key).add(res);
  res.write(`data: ${JSON.stringify({ type: "connected", jobId })}\n\n`);
  (jobEventHistory.get(key) || []).forEach((event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  res.on("close", () => {
    const streams = jobStreams.get(key);
    if (!streams) return;
    streams.delete(res);
    if (streams.size === 0) jobStreams.delete(key);
  });
}

function emitJobEvent(jobId, event) {
  const key = String(jobId);
  const history = jobEventHistory.get(key) || [];
  history.push(event);
  jobEventHistory.set(key, history.slice(-200));

  // Broadcast via Socket.IO
  const { broadcast } = require("./socketService");
  broadcast('messages:event', event);

  // Legacy SSE
  const streams = jobStreams.get(key);
  if (!streams || streams.size === 0) return;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  streams.forEach((stream) => stream.write(payload));
}

function closeJobStream(jobId) {
  const key = String(jobId);
  const streams = jobStreams.get(key);
  if (streams) {
    streams.forEach((s) => s.end());
    jobStreams.delete(key);
  }
  setTimeout(() => jobEventHistory.delete(key), 5 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Character limits per platform+type
// ---------------------------------------------------------------------------

const CHAR_LIMITS = {
  linkedin_connect: 300,
  linkedin_dm: 1000,
  x_dm: 500,
  instagram_dm: 1000,
  facebook_dm: 1000,
};

function getCharLimit(platform, type) {
  const key = `${platform}_${type || "dm"}`;
  return CHAR_LIMITS[key] || 1000;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

function loadTemplates() {
  try {
    const filePath = path.join(__dirname, "..", "config", "templates.json");
    if (!fs.existsSync(filePath)) return {};
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    logger.error("MESSAGES", "Failed to load templates", {
      error: err.message,
    });
    return {};
  }
}

function getTemplate(platform, type) {
  const db = getDb();
  const settingKey = `template_${platform}_${type || "dm"}`;
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(settingKey);
  if (row && row.value) return row.value;

  const templates = loadTemplates();
  const fileKey = type ? `${platform}_${type}` : `${platform}_dm`;
  return templates[fileKey] || "";
}

function fillTemplate(template, vars) {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value || "");
  }
  return result;
}

function extractPainPoint(scoreReason) {
  if (!scoreReason) return "managing restaurant operations more efficiently";
  const lower = scoreReason.toLowerCase();
  if (lower.includes("restaurant") || lower.includes("food"))
    return "streamlining restaurant operations and orders";
  if (lower.includes("hotel"))
    return "optimising hotel staff scheduling and guest management";
  if (lower.includes("cafe") || lower.includes("coffee"))
    return "managing café orders and inventory efficiently";
  if (lower.includes("sme") || lower.includes("enterprise"))
    return "simplifying business operations with smart software";
  return "managing business operations more efficiently";
}

// ---------------------------------------------------------------------------
// Gemini API helpers
// ---------------------------------------------------------------------------

function stripCodeFences(text) {
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  return cleaned.trim();
}

// ---------------------------------------------------------------------------
// Template-based fallback message generation
// ---------------------------------------------------------------------------

/**
 * Generate messages from the canonical template.
 * Both variants A and B use the same template — personalised with lead name only.
 * No AI generation is used for outreach DMs.
 *
 * @param {Object} lead - Lead record from DB
 * @param {string} [productPitch] - Unused, kept for API compatibility
 * @returns {{variantA: {id: number, body: string}, variantB: {id: number, body: string}}}
 */
function generateFromTemplate(lead, productPitch) {
  const db = getDb();
  const resolvedPlatform = lead.platform || getPrimaryPlatform();
  const messageType = resolvedPlatform === "linkedin" ? "connect" : "dm";
  const template = getTemplate(resolvedPlatform, messageType);

  const templateVars = {
    lead_name: lead.name || "there",
    role: lead.role || "",
    company: lead.company || "your business",
    location: lead.location || "Kenya",
    product: productPitch || "Restaurant Manager",
    pain_point: extractPainPoint(lead.score_reason),
  };

  // Both variants use the same canonical template
  const body = template
    ? fillTemplate(template, templateVars)
    : `Hi ${templateVars.lead_name},\n\nI'm reaching out because I know how much of a nightmare it is when a sudden ISP outage brings a busy dining room to a standstill. I develop localized management systems specifically designed to maintain 100% operational uptime during internet drops—meaning kitchen routing and mobile payments keep flowing no matter what.\n\nIs relying on a stable connection something that currently causes friction for your front-of-house team?\n\nWould love to connect!\n\nBest,\nElvin`;

  const insertStmt = db.prepare(
    `INSERT INTO messages (lead_id, platform, body, variant, status, generated_by, generated_at)
     VALUES (?, ?, ?, ?, 'pending', 'template', CURRENT_TIMESTAMP)`,
  );

  const resultA = insertStmt.run(lead.id, resolvedPlatform, body, "A");
  const resultB = insertStmt.run(lead.id, resolvedPlatform, body, "B");

  return {
    variantA: { id: resultA.lastInsertRowid, body },
    variantB: { id: resultB.lastInsertRowid, body },
  };
}

// ---------------------------------------------------------------------------
// Core: generateMessages
// ---------------------------------------------------------------------------

async function generateMessages(leadId, platform, productPitch, tone) {
  const db = getDb();
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(leadId);
  if (!lead) throw new Error(`Lead ${leadId} not found`);

  // Always use template — no AI generation for outreach DMs
  return generateFromTemplate(lead, productPitch);
}

// ---------------------------------------------------------------------------
// Core: generateFollowUp
// ---------------------------------------------------------------------------

async function generateFollowUp(leadId) {
  const db = getDb();
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(leadId);
  if (!lead) throw new Error(`Lead ${leadId} not found`);
  const resolvedPlatform = lead.platform || getPrimaryPlatform();

  const originalMsg = db
    .prepare(
      `SELECT * FROM messages
     WHERE lead_id = ? AND is_follow_up = 0 AND status IN ('sent', 'approved')
     ORDER BY generated_at DESC LIMIT 1`,
    )
    .get(leadId);

  const daysSince = originalMsg
    ? Math.floor(
        (Date.now() -
          new Date(
            originalMsg.sent_at ||
              originalMsg.approved_at ||
              originalMsg.generated_at,
          ).getTime()) /
          86400000,
      )
    : 7;

  const prompt = `Generate a brief, non-pushy follow-up for ${resolvedPlatform}.
Name: ${lead.name}. Sent ${daysSince} days ago.
Original: "${originalMsg ? originalMsg.body.slice(0, 100) : ""}"
Return ONLY the message body (max 300 chars).`;

  try {
    const body = await callGeminiText(prompt);
    const cleanBody = stripCodeFences(body).replace(/^["']|["']$/g, "");

    const result = db
      .prepare(
        `INSERT INTO messages (lead_id, platform, body, variant, is_follow_up, status, generated_at)
       VALUES (?, ?, ?, 'A', 1, 'pending', CURRENT_TIMESTAMP)`,
      )
      .run(leadId, resolvedPlatform, cleanBody);

    return { id: result.lastInsertRowid, body: cleanBody };
  } catch (error) {
    logger.error(
      "MESSAGES",
      `Failed to generate follow-up for lead ${leadId}`,
      error,
    );
    throw error;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function generateAllMessages(jobId, productPitch, tone) {
  const db = getDb();
  const emit = (event) => emitJobEvent(jobId, { ...event, jobId });

  const qualifiedLeads = db
    .prepare(
      `SELECT l.* FROM leads l
     WHERE l.status = 'qualified'
       AND NOT EXISTS (
         SELECT 1 FROM messages m
         WHERE m.lead_id = l.id AND m.status IN ('pending', 'approved')
       )
     ORDER BY l.lead_score DESC`,
    )
    .all();

  const total = qualifiedLeads.length;
  let processed = 0;
  let succeeded = 0;
  let failed = 0;

  emit({
    type: "info",
    message: `Generating messages for ${total} qualified leads`,
  });

  try {
    for (let i = 0; i < qualifiedLeads.length; i += BATCH_SIZE) {
      const batch = qualifiedLeads.slice(i, i + BATCH_SIZE);

      for (const lead of batch) {
        try {
          const result = await generateMessages(
            lead.id,
            lead.platform,
            productPitch,
            tone,
          );
          succeeded++;
          emit({
            type: "generated",
            leadId: lead.id,
            name: lead.name,
            variantA: result.variantA.body.slice(0, 60),
            variantB: result.variantB.body.slice(0, 60),
          });
        } catch (err) {
          failed++;
          emit({ type: "error", leadId: lead.id, message: err.message });
        }
        processed++;
        emit({ type: "progress", processed, total });
      }
      if (i + BATCH_SIZE < qualifiedLeads.length) await delay(BATCH_DELAY_MS);
    }
    const summary = { processed, succeeded, failed };
    emit({ type: "done", result: summary });
    return summary;
  } catch (error) {
    emit({ type: "error", message: error.message });
    throw error;
  } finally {
    closeJobStream(jobId);
  }
}

// ---------------------------------------------------------------------------
// Pipeline entry point: runMessageStage
// ---------------------------------------------------------------------------

/**
 * Run the message generation stage for the pipeline.
 * Generates messages for all qualified leads that don't yet have an approved message.
 * Auto-approves the configured variant (default: B).
 *
 * @param {string|number} jobId - Pipeline run ID for event tracking
 * @param {Function} emit - Event emitter function
 * @returns {Promise<{generated: number, approved: number}>}
 */
async function runMessageStage(jobId, emit) {
  const db = getDb();
  const mode = stageMode('message');
  const variant = autoApproveVariant();

  // Get all qualified leads that don't yet have an approved message
  const leads = db.prepare(`
    SELECT l.* FROM leads l
    LEFT JOIN messages m ON m.lead_id = l.id AND m.status = 'approved'
    WHERE l.status = 'qualified' AND m.id IS NULL
    ORDER BY l.lead_score DESC
  `).all();

  if (leads.length === 0) {
    emit({ type: 'info', message: 'No qualified leads need messages' });
    return { generated: 0, approved: 0 };
  }

  let generated = 0;
  let approved = 0;

  emit({ type: 'info', message: `Generating messages for ${leads.length} leads (mode: ${mode}, auto-approve: variant ${variant})` });

  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i];
    emit({ type: 'progress', message: `Generating message for ${lead.name || lead.id}...`, processed: i, total: leads.length });

    try {
      let result;
      if (mode === 'manual') {
        result = generateFromTemplate(lead);
      } else {
        // AI mode with automatic template fallback (handled inside generateMessages)
        result = await generateMessages(lead.id, lead.platform);
      }

      generated++;

      // Auto-approve configured variant
      const updated = db.prepare(`
        UPDATE messages
        SET status = 'approved',
            approved_by = 'pipeline-auto',
            approved_at = CURRENT_TIMESTAMP
        WHERE lead_id = ? AND variant = ? AND status = 'pending'
      `).run(lead.id, variant);

      if (updated.changes > 0) {
        approved++;
        emit({
          type: 'generated',
          leadId: lead.id,
          name: lead.name,
          autoApproved: variant,
          variantA: result.variantA.body.slice(0, 60),
          variantB: result.variantB.body.slice(0, 60),
        });
      }
    } catch (err) {
      emit({ type: 'warn', message: `Failed for ${lead.name || lead.id}: ${err.message}` });
    }

    // Batch delay every BATCH_SIZE leads
    if ((i + 1) % BATCH_SIZE === 0 && i + 1 < leads.length) {
      await delay(BATCH_DELAY_MS);
    }
  }

  emit({
    type: 'complete',
    message: `Generated ${generated} messages, ${approved} auto-approved as variant ${variant}`,
  });

  return { generated, approved };
}

module.exports = {
  generateMessages,
  generateFollowUp,
  generateAllMessages,
  generateFromTemplate,
  runMessageStage,
  registerJobStream,
  emitJobEvent,
  closeJobStream,
  getCharLimit,
  CHAR_LIMITS,
};
