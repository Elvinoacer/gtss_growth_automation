const { getDb } = require("../db/database");
const logger = require("../utils/logger");

const jobStreams = new Map();
const jobEventHistory = new Map();
const BATCH_SIZE = 10;
const BATCH_DELAY_MS = 2000;

// ---------------------------------------------------------------------------
// SSE helpers (same pattern as discoveryService)
// ---------------------------------------------------------------------------

function registerJobStream(jobId, res) {
  const key = String(jobId);
  if (!jobStreams.has(key)) {
    jobStreams.set(key, new Set());
  }

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

  const streams = jobStreams.get(key);
  if (!streams || streams.size === 0) return;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  streams.forEach((stream) => stream.write(payload));
}

function closeJobStream(jobId) {
  const key = String(jobId);
  const streams = jobStreams.get(key);
  if (!streams) return;
  streams.forEach((stream) => stream.end());
  jobStreams.delete(key);
  setTimeout(() => jobEventHistory.delete(key), 5 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Gemini API interaction
// ---------------------------------------------------------------------------

function buildPrompt(lead) {
  return `You are a lead qualification specialist for GTSS, a Kenyan tech company selling restaurant management software.

Score this lead from 0 to 100 based on likelihood to be a paying client.

Scoring factors:
- Business type match (restaurant/cafe/hotel/SME = high score; unrelated = low): 30 points
- Location (Kenya, especially Nairobi/Mombasa = high; outside Africa = low): 20 points
- Business size signals (has website, company listed, professional profile = high): 20 points
- Profile completeness (full profile = high; empty = low): 15 points
- Activity recency (recent posts/activity signals = high): 15 points

Lead data:
Name: ${lead.name || "N/A"}
Role: ${lead.role || "N/A"}
Company: ${lead.company || "N/A"}
Location: ${lead.location || "N/A"}
Website: ${lead.website || "N/A"}
Platform: ${lead.platform || "N/A"}

Respond ONLY with valid JSON, no markdown, no preamble:
{"score": 72, "reason": "Restaurant owner in Nairobi with active profile and website — strong match.", "factors": {"business_type": 25, "location": 18, "business_size": 15, "completeness": 8, "recency": 6}}`;
}

function stripCodeFences(text) {
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  return cleaned.trim();
}

async function callGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set in environment");
  }

  const primaryModel = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
  const modelsToTry = [...new Set([primaryModel, "gemini-2.0-flash", "gemini-1.5-flash", "gemini-1.5-pro"])];

  let lastError;
  let response;

  for (const model of modelsToTry) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    });
    const text = await res.text().catch(() => "");
    response = { status: res.status, ok: res.ok, text };

    if (response.status === 429 || response.text.includes("429")) {
      logger.warn("GEMINI", `Rate limited (429) for model ${model}, trying next model`);
      lastError = new Error(`Gemini API error 429 for model ${model}: ${response.text}`);
      continue;
    }

    if (!response.ok) {
      lastError = new Error(`Gemini API error ${response.status}: ${response.text}`);
      lastError.status = response.status;
      throw lastError;
    }

    break; // Success
  }

  if (!response || !response.ok) {
    throw lastError;
  }

  let data;
  try {
    data = JSON.parse(response.text);
  } catch (err) {
    logger.error("GEMINI", "Failed to parse Gemini response JSON", {
      raw: response.text,
    });
    const parseError = new Error("Invalid JSON in Gemini response");
    parseError.status = "parse_failed";
    throw parseError;
  }

  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) {
    throw new Error("Empty response content from Gemini API");
  }

  try {
    return JSON.parse(stripCodeFences(rawText));
  } catch (err) {
    logger.error("GEMINI", "Failed to parse Gemini message content as JSON", {
      raw: rawText,
    });
    const contentError = new Error("Gemini did not return valid JSON content");
    contentError.status = "parse_failed";
    throw contentError;
  }
}

// ---------------------------------------------------------------------------
// Core scoring
// ---------------------------------------------------------------------------

async function scoreLead(lead) {
  const db = getDb();
  const prompt = buildPrompt(lead);

  try {
    const result = await callGemini(prompt);

    const score = Math.max(0, Math.min(100, Number(result.score) || 0));
    const reason = String(result.reason || "");
    const status = score >= 50 ? "qualified" : "deprioritized";

    db.prepare(
      `UPDATE leads
       SET lead_score = ?, score_reason = ?, status = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    ).run(score, reason, status, lead.id);

    return { score, reason, factors: result.factors || {} };
  } catch (error) {
    logger.error("QUALIFICATION", `Error scoring lead ${lead.id}`, error);

    // Mark as scoring_failed if it's a 500 or parse error
    const status =
      error.status === 500 || error.status === "parse_failed"
        ? "scoring_failed"
        : "pending_qualification";

    db.prepare(
      `UPDATE leads
       SET status = ?, score_reason = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    ).run(status, `Qualification failed: ${error.message}`, lead.id);

    throw error;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function scoreLeadsBatch(leadIds, jobId) {
  const db = getDb();
  const emit = (event) => emitJobEvent(jobId, { ...event, jobId });
  const total = leadIds.length;
  let processed = 0;
  let qualified = 0;
  let deprioritized = 0;

  emit({ type: "info", message: `Starting qualification of ${total} leads` });

  try {
    for (let i = 0; i < leadIds.length; i += BATCH_SIZE) {
      const batch = leadIds.slice(i, i + BATCH_SIZE);

      for (const leadId of batch) {
        const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(leadId);
        if (!lead) {
          processed++;
          continue;
        }

        try {
          const result = await scoreLead(lead);
          if (result.score >= 50) {
            qualified++;
          } else {
            deprioritized++;
          }
          emit({
            type: "scored",
            leadId: lead.id,
            name: lead.name,
            score: result.score,
            reason: result.reason,
          });
        } catch (error) {
          // Error already logged and handled in scoreLead
          emit({ type: "error", leadId, message: error.message });
        }

        processed++;
        emit({ type: "progress", processed, total });
      }

      if (i + BATCH_SIZE < leadIds.length) {
        await delay(BATCH_DELAY_MS);
      }
    }

    const summary = { processed, qualified, deprioritized };
    emit({ type: "done", result: summary });
    return summary;
  } catch (error) {
    emit({ type: "error", message: `Batch failed: ${error.message}` });
    throw error;
  } finally {
    closeJobStream(jobId);
  }
}

module.exports = {
  scoreLead,
  scoreLeadsBatch,
  registerJobStream,
  emitJobEvent,
  closeJobStream,
};
