/**
 * geminiWeb/index.js
 *
 * Re-exports the EXACT same module.exports surface as the original
 * geminiWeb.js — three public functions:
 *   { generateImageViaGeminiWeb, generateTextViaGeminiWeb, generateImageAwareCaptionViaGeminiWeb }
 *
 * Every in-tree caller that did `require("../automation/geminiWeb")`
 * continues to resolve to this index.js (Node.js directory-index resolution).
 *
 * The split files live one directory deeper than the original, so every
 * `require("../X")` in the original file became `require("../../X")` in
 * the split files (the only such case is `../utils/logger` →
 * `../../utils/logger`). The `require("./browserBase")` sibling require
 * stays as `../browserBase` from the split dir.
 */

const { generateImageViaGeminiWeb } = require("./generateImage");
const { generateTextViaGeminiWeb } = require("./generateText");
const { generateImageAwareCaptionViaGeminiWeb } = require("./generateImageAwareCaption");

module.exports = {
  generateImageViaGeminiWeb,
  generateTextViaGeminiWeb,
  generateImageAwareCaptionViaGeminiWeb,
};
