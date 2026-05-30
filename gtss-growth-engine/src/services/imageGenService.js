const crypto = require("crypto");
const { getDb } = require("../db/database");
const { callGeminiText } = require("./aiService");
const { getContext } = require("./contextService");
const { generateImageViaGeminiWeb } = require("../automation/geminiWeb");
const { emitJobEvent } = require("./schedulerService"); // reuse SSE helpers
const logger = require("../utils/logger");

/**
 * Build a meta-prompt that tells Gemini to produce a detailed image-generation prompt.
 * The richer the context the user gives (topic, style, platform), the better the result.
 */
function firstArrayValue(value, fallback = "") {
  return Array.isArray(value) ? value[0] || fallback : value || fallback;
}

function joinArrayValue(value) {
  return Array.isArray(value) ? value.join(", ") : value || "";
}

function buildMetaPrompt({ topic, style, platform = "instagram" }) {
  const ctx = getContext();
  const resolvedPlatform = platform || "instagram";
  const visualStyle = style || ctx.ctx_content_image_style || "photorealistic";
  const themes = joinArrayValue(ctx.ctx_content_post_themes);
  const features = joinArrayValue(ctx.ctx_product_key_features);
  const painPoints = joinArrayValue(ctx.ctx_product_pain_points);
  const location = firstArrayValue(ctx.ctx_audience_geographies, "Kenya");

  return `You are a creative director for ${ctx.ctx_biz_name}, ${ctx.ctx_biz_description}
Write a detailed, vivid image-generation prompt for an AI image model.
The image should suit a ${resolvedPlatform} post for a ${ctx.ctx_biz_industry} brand.

Topic: ${topic}
Product: ${ctx.ctx_product_name} - ${ctx.ctx_product_tagline}
Product value proposition: ${ctx.ctx_product_value_prop}
Key product features: ${features}
Customer pain points to reflect visually: ${painPoints}
Brand themes: ${themes}
Visual style: ${visualStyle}
Target audience: ${ctx.ctx_audience_ideal_profile}
Location context: ${location}
Brand tone: ${ctx.ctx_content_tone}

Rules:
- Keep imagery consistent with ${ctx.ctx_biz_name}'s brand and target audience.
- Make the concept reinforce ${ctx.ctx_product_name}'s positioning without adding visible words, logos, or UI text.
- Be specific about lighting, composition, colour palette, and mood.
- Describe the scene as if briefing a professional photographer.
- Do NOT include any text, watermarks, or logos in the description.
- Return ONLY the prompt text. No explanations, no preamble.`.trim();
}

/**
 * Full orchestration:
 *   1. Record job in DB
 *   2. Generate refined prompt via Gemini API
 *   3. Run Playwright session against gemini.google.com
 *   4. Download image to AUTOMATION_ARTIFACTS_DIR
 *   5. Update job record
 *
 * @returns {Promise<{jobId, filePath, fileName, genPrompt}>}
 */
async function runImageGenJob({
  jobId = crypto.randomUUID(),
  topic,
  style,
  platform,
}) {
  const db = getDb();
  const metaPrompt = buildMetaPrompt({ topic, style, platform });

  // Insert job row
  db.prepare(
    `
    INSERT INTO image_gen_jobs (id, meta_prompt, status)
    VALUES (?, ?, 'pending')
  `,
  ).run(jobId, metaPrompt);

  // Emit helper - wraps schedulerService.emitJobEvent so the UI SSE stream works
  const emit = (event, message, data = {}) => {
    emitJobEvent(jobId, { jobId, type: event, message, ...data });
  };

  try {
    db.prepare(`UPDATE image_gen_jobs SET status='running' WHERE id=?`).run(
      jobId,
    );

    // -- Phase 1: Prompt refinement -----------------------------------------
    emit("prompt_generating", "Generating image prompt with Gemini API...");
    const genPrompt = await callGeminiText(metaPrompt);

    db.prepare(`UPDATE image_gen_jobs SET gen_prompt=? WHERE id=?`).run(
      genPrompt,
      jobId,
    );
    emit("prompt_ready", "Prompt ready.", { genPrompt });

    // -- Phase 2: Browser automation ----------------------------------------
    const { filePath, fileName } = await generateImageViaGeminiWeb(
      genPrompt,
      emit,
    );

    // -- Phase 3: Persist result --------------------------------------------
    db.prepare(
      `
      UPDATE image_gen_jobs
      SET status='done', file_path=?, file_name=?, completed_at=CURRENT_TIMESTAMP
      WHERE id=?
    `,
    ).run(filePath, fileName, jobId);

    emit("download_complete", "Image ready.", { filePath, fileName });
    return { jobId, filePath, fileName, genPrompt };
  } catch (err) {
    logger.error("IMAGE_GEN", "Job failed", { jobId, error: err.message });
    db.prepare(
      `UPDATE image_gen_jobs SET status='failed', error=? WHERE id=?`,
    ).run(err.message, jobId);
    emit("error", err.message);
    throw err;
  }
}

module.exports = { runImageGenJob, buildMetaPrompt };
