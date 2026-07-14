/**
 * x/index.js — Public entry point for `require("../automation/x")`.
 *
 * Preserves the EXACT module.exports surface of the original x.js
 * monolith:
 *
 *   module.exports = {
 *     sendConnectionRequest: followUser,  // alias for backward-compat
 *                                        // with executor.js (which calls
 *                                        // platformAdapter.sendConnectionRequest)
 *     sendDirectMessage,
 *     followUser,
 *     likeRecentPost,
 *   };
 *
 * The split files live one directory deeper than the original x.js.
 * The original used:
 *   - `require("./browserBase")`        → now `require("../browserBase")`
 *     (same depth — original at src/automation/x.js, split at
 *     src/automation/x/foo.js, both resolve ../browserBase → src/automation/browserBase ✓)
 *   - `require("../utils/logger")`      → now `require("../../utils/logger")`
 *     (one level deeper — ../../utils/logger from the split file =
 *     src/utils/logger ✓)
 *
 * File manifest:
 *   selectors.js      — SELECTORS constant (every X CSS / data-testid
 *                       selector used by the action helpers)
 *   domHelpers.js     — low-level Playwright DOM helpers
 *                       (firstVisible, firstVisibleOnProfile,
 *                       detectActionWarning, checkAccountStatus,
 *                       verifyDmSent, typeLikeHuman, etc.)
 *   followUser.js     — followUser(page, profileUrl, emit)
 *   directMessage.js  — sendDirectMessage(page, profileUrl, message, emit)
 *   likeRecentPost.js — likeRecentPost(page, profileUrl, emit)
 *   index.js          — this file
 */

const { followUser } = require("./followUser");
const { sendDirectMessage } = require("./directMessage");
const { likeRecentPost } = require("./likeRecentPost");

module.exports = {
  sendConnectionRequest: followUser, // maps to followUser for backward-compatibility with executor.js
  sendDirectMessage,
  followUser,
  likeRecentPost,
};
