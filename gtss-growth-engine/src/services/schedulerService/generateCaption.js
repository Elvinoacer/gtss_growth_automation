/**
 * Scheduler Service — AI Caption Generation
 * generateCaption — build a per-platform caption prompt from the
 * context settings (business name, product, tone, CTA, hashtag sets),
 * call Gemini via the text-only API (callGeminiText/unwrapGeminiText),
 * and normalize the result for the target platform. Image-aware
 * captioning via Gemini Web is intentionally disabled — see the long
 * comment block.
 * Extracted from the original schedulerService.js for maintainability.
 */

const { callGeminiText, unwrapGeminiText } = require("../aiService");
const { getContext } = require("../contextService");
const logger = require("../../utils/logger");
const {
  GTSS_RESTAURANT_MANAGER_URL,
  POST_CHAR_LIMITS,
} = require("./constants");
const { preparePlatformPostBody } = require("./textNormalization");

async function generateCaption(topic, platform, tone, options = {}) {
  const ctx = getContext();
  const limit = POST_CHAR_LIMITS[platform] || 2200;
  const toneLabel = tone || ctx.ctx_content_tone || "engaging";

  // Build platform hashtags string
  const hashtagSets = ctx.ctx_content_hashtag_sets || {};
  const platformHashtags = Array.isArray(hashtagSets[platform])
    ? hashtagSets[platform]
        .slice(0, 5)
        .map((h) => `#${h}`)
        .join(" ")
    : "";

  const prompt = `Write a social media caption for ${platform} about: ${topic}

Company: ${ctx.ctx_biz_name} — ${ctx.ctx_biz_description}
Product: ${ctx.ctx_product_name} — ${ctx.ctx_product_tagline}
Tone: ${toneLabel}
Platform character limit: ${limit}
Target audience: ${ctx.ctx_audience_ideal_profile}
Location context: ${Array.isArray(ctx.ctx_audience_geographies) ? ctx.ctx_audience_geographies[0] : "Kenya"}
End with this call to action: ${ctx.ctx_content_cta}
Product link to include naturally when it fits: ${GTSS_RESTAURANT_MANAGER_URL}
${platformHashtags ? `Append these hashtags only if the final text still fits inside the character limit: ${platformHashtags}` : ""}
Use plain text only. Do not use markdown formatting, HTML entities, bullets, or special styling characters.
If you include the product link, write it as a bare URL on its own line (e.g. https://example.com) — never as [text](url) markdown.
For X, the final caption must be ${POST_CHAR_LIMITS.x} characters or fewer including spaces and hashtags.
Return ONLY the caption text, no explanations.`;

  // ── Image-aware caption path: DISABLED ────────────────────────────────
  // The image-aware path previously uploaded the chosen asset to Gemini Web
  // (generateImageAwareCaptionViaGeminiWeb) so the LLM could "see" the image
  // and write a caption that referenced its contents. Per project decision
  // we no longer upload images to Gemini; captions are now produced via the
  // text-only Gemini API path below (which itself falls back to text-only
  // Gemini Web). The image-aware code is intentionally bypassed so that
  // library assets never leave the local machine. options.imagePath is
  // therefore ignored for caption generation, but the asset itself is still
  // attached to the post at publish time.
  if (options.imagePath) {
    logger.db("info", "content", "caption_gen", "Image-aware caption path skipped (Gemini upload disabled); using text-only Gemini", {
      platform,
      imagePath: options.imagePath,
    });
  }

  try {
    const generation = await callGeminiText(prompt, { timeoutMs: 25_000 });
    const caption = unwrapGeminiText(generation);
    logger.db("info", "content", "caption_gen", "Gemini caption generated", {
      platform,
      source: generation.source || "unknown",
      model: generation.model,
    });
    return {
      text: preparePlatformPostBody(platform, caption),
      source: generation.source || "gemini",
      model: generation.model || null,
      ok: true,
    };
  } catch (err) {
    logger.warn("SCHEDULER", "Caption generation failed", {
      platform,
      topic,
      error: err.message,
    });
    // IMPORTANT: we no longer return the `${topic} — [Edit this caption
    // before posting]` stub. That stub was leaking into live posts because
    // the content pipeline trusted any string returned from this function.
    // Now we return an explicit failure marker so the caller can decide
    // whether to abort the run, retry, or skip the platform.
    return {
      text: "",
      source: "failed",
      model: null,
      ok: false,
      error: err.message,
    };
  }
}

module.exports = {
  generateCaption,
};
