const crypto = require("crypto");
const { getDb } = require("../db/database");
const { callGeminiText } = require("./aiService");
const { generateImageViaGeminiWeb } = require("../automation/geminiWeb");
const { emitJobEvent } = require("./schedulerService"); // reuse SSE helpers
const logger = require("../utils/logger");

/**
 * Build a meta-prompt that tells Gemini to produce a detailed image-generation prompt.
 * The richer the context the user gives (topic, style, platform), the better the result.
 */
function buildMetaPrompt({
  topic,
  style = "photorealistic",
  platform = "instagram",
}) {
  return `
You are a creative director. Write a detailed, vivid image-generation prompt
for an AI image model. The image should suit a ${platform} post.

Topic: ${topic}
Visual style: ${style}

Rules:
- Be specific about lighting, composition, colour palette, and mood.
- Describe the scene as if briefing a photographer.
- Do NOT include any text, watermarks, or logos in the description.
- Return ONLY the prompt text. No explanations, no preamble.
`.trim();
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
async function runImageGenJob({ jobId = crypto.randomUUID(), topic, style, platform }) {
  const db = getDb();

  // Insert job row
  db.prepare(
    `
    INSERT INTO image_gen_jobs (id, meta_prompt, status)
    VALUES (?, ?, 'pending')
  `,
  ).run(jobId, topic);

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
    const metaPrompt = buildMetaPrompt({ topic, style, platform });
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

module.exports = { runImageGenJob };
