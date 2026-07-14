/**
 * geminiWeb/constants.js
 *
 * Module-level constants + simple env-driven resolvers shared by every
 * split file in geminiWeb/:
 *  - CONFIGURED_ARTIFACTS_DIR / GEMINI_URL / SELECTORS: static config
 *  - getArtifactsDir(): resolve a writable dir for downloaded Gemini images
 *    (with a fallback to ./artifacts/automation if the configured dir is
 *    unwritable, e.g. user pointed GEMINI_IMAGE_SAVE_DIR at /var/log)
 *  - getSharedCdpEndpoint(): resolve the shared Chrome CDP endpoint env
 *    var. We prefer GEMINI_CDP_ENDPOINT but fall back to the social-platform
 *    endpoints so Gemini opens as a new tab in the same browser the operator
 *    is already using for LinkedIn/IG/X/FB (avoids launching a second
 *    Chrome instance just for image generation).
 */

const path = require("path");
const fs = require("fs");
const logger = require("../../utils/logger");

const CONFIGURED_ARTIFACTS_DIR = path.resolve(
  process.env.GEMINI_IMAGE_SAVE_DIR ||
    process.env.AUTOMATION_ARTIFACTS_DIR ||
    "./artifacts/automation",
);
const GEMINI_URL = "https://gemini.google.com/app";

/**
 * Resolve a writable artifacts directory for Gemini image output.
 *
 * Tries the configured GEMINI_IMAGE_SAVE_DIR / AUTOMATION_ARTIFACTS_DIR first;
 * if that path can't be created (e.g. user pointed it at /var/log/... without
 * root), falls back to ./artifacts/automation under the process cwd.
 */
function getArtifactsDir() {
  try {
    fs.mkdirSync(CONFIGURED_ARTIFACTS_DIR, { recursive: true });
    return CONFIGURED_ARTIFACTS_DIR;
  } catch (err) {
    logger.warn("GEMINI_WEB", `Artifacts dir unwritable: ${CONFIGURED_ARTIFACTS_DIR} (${err.message}); falling back to ./artifacts/automation`);
  }
  const fallback = path.resolve(process.cwd(), "artifacts", "automation");
  try {
    fs.mkdirSync(fallback, { recursive: true });
  } catch (err) {
    logger.warn("GEMINI_WEB", `Fallback artifacts dir unwritable: ${fallback} (${err.message})`);
  }
  return fallback;
}

function getSharedCdpEndpoint() {
  return (
    process.env.GEMINI_CDP_ENDPOINT ||
    process.env.CDP_ENDPOINT ||
    process.env.LINKEDIN_CDP_ENDPOINT ||
    process.env.INSTAGRAM_CDP_ENDPOINT ||
    process.env.FACEBOOK_CDP_ENDPOINT ||
    process.env.X_CDP_ENDPOINT ||
    null
  );
}

// -- Selectors ---------------------------------------------------------------
// These target the Gemini web app as of 2025-2026. Gemini uses Shadow DOM and
// Angular-based components; locating by role / aria-label is more stable than
// class names. Update here if Google changes the UI.

const SELECTORS = {
  // The main chat text input area
  input: 'rich-textarea div[contenteditable="true"]',
  // Send / submit button
  sendBtn: 'button[aria-label="Send message"]',
  // Image element inside a Gemini response turn
  responseImage:
    'message-turn img[src*="generativelanguage"], message-turn img[src*="blob:"], message-turn img[src^="https://"]',
  // Fallback: any img inside a model response container
  fallbackImage: ".model-response-text img, .response-container img",
  // "Generate image" chips / buttons that may appear
  imageChip: 'suggestion-chip[data-chip-type="generate_image"]',
  downloadButtons: [
    'button[aria-label*="Download" i]',
    '[role="button"][aria-label*="Download" i]',
    'button:has-text("Download")',
    '[role="button"]:has-text("Download")',
    'button:has-text("download")',
    '[role="button"]:has-text("download")',
  ],
  responseText:
    'message-turn .model-response-text, message-turn [data-test-id="response-text"], .model-response-text, .response-container',
  modelTurns: "message-turn, model-response",
  copyButtons: [
    'button[aria-label*="Copy" i]',
    '[role="button"][aria-label*="Copy" i]',
    'button:has-text("Copy")',
    '[role="button"]:has-text("Copy")',
  ],
  stopButton: 'button[aria-label*="Stop" i], button:has-text("Stop")',
};

module.exports = {
  CONFIGURED_ARTIFACTS_DIR,
  GEMINI_URL,
  SELECTORS,
  getArtifactsDir,
  getSharedCdpEndpoint,
};
