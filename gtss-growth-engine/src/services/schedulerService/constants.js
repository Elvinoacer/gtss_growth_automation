/**
 * Scheduler Service — Shared Constants
 * GTSS_RESTAURANT_MANAGER_URL, POST_CHAR_LIMITS, UPLOADS_DIR,
 * AUTOMATION_ARTIFACT_DIR — module-wide constants used by caption
 * generation, text normalization, media path resolution, and the Facebook
 * debug snapshot dumper.
 *
 * NOTE: __dirname in this split file resolves one level deeper than the
 * original (src/services/schedulerService/ vs src/services/), so the
 * public/uploads and artifacts/automation paths each get one extra ".."
 * segment to land at the same absolute path as before.
 */

const path = require("path");

const GTSS_RESTAURANT_MANAGER_URL = "https://www.gtss.software/products/restaurant-manager";

const POST_CHAR_LIMITS = {
  x: 280,
  linkedin: 3000,
  facebook: 63206,
  instagram: 2200,
};

// Resolve the writable uploads directory. The desktop launcher sets
// UPLOADS_DIR=<userData>/public/uploads (writable); in standalone dev mode
// (running `npm start` inside gtss-growth-engine/), UPLOADS_DIR is unset
// and we fall back to the bundled <serverRoot>/public/uploads (writable
// in dev). See src/routes/assets.js for the same pattern.
const UPLOADS_DIR = process.env.UPLOADS_DIR
  ? path.resolve(process.env.UPLOADS_DIR)
  : path.resolve(__dirname, "..", "..", "..", "public", "uploads");
const AUTOMATION_ARTIFACT_DIR = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "artifacts",
  "automation",
);

module.exports = {
  GTSS_RESTAURANT_MANAGER_URL,
  POST_CHAR_LIMITS,
  UPLOADS_DIR,
  AUTOMATION_ARTIFACT_DIR,
};
