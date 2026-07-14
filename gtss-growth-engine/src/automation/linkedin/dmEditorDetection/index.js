/**
 * LinkedIn DM Editor Detection — Index
 *
 * Re-exports the four public functions of the dmEditorDetection module.
 * Callers that `require('./dmEditorDetection')` (e.g. linkedin/index.js,
 * connectionActions.js, profileActions.js) continue to receive the exact same
 * shape as the original dmEditorDetection.js monolith.
 *
 * The original dmEditorDetection.js (~673 lines) was split into thematic files
 * inside this directory for maintainability:
 *   - firstVisibleOverlay.js — overlay-scoped firstVisible helper
 *   - findBestDmOverlay.js   — modal-aware overlay selection
 *   - findBestDmEditor.js    — main editor discovery (calls findBestDmOverlay)
 *   - waitForDmEditor.js     — retry wrapper (calls findBestDmEditor + findBestDmOverlay)
 *
 * Inter-file dependency: findBestDmEditor.js requires findBestDmOverlay from
 * ./findBestDmOverlay; waitForDmEditor.js requires both from their respective
 * files. This preserves the original call graph without any change to behavior.
 */

const { firstVisibleOverlay } = require("./firstVisibleOverlay");
const { findBestDmEditor } = require("./findBestDmEditor");
const { findBestDmOverlay } = require("./findBestDmOverlay");
const { waitForDmEditor } = require("./waitForDmEditor");

module.exports = {
  firstVisibleOverlay,
  findBestDmEditor,
  findBestDmOverlay,
  waitForDmEditor,
};
