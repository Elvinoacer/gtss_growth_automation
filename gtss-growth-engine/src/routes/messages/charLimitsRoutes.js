/**
 * messages/charLimitsRoutes.js — GET /api/messages/char-limits.
 *
 * Returns the per-platform character-limit constants from messageService so
 * the frontend can show live character counters without hard-coding.
 *
 * Registered last (mirrors the original route order) so any earlier
 * `/api/messages/:id/...` route doesn't accidentally shadow the
 * `/api/messages/char-limits` static segment. (Express matches by method AND
 * path shape, so the ordering isn't strictly necessary, but preserving the
 * original order is the safe default.)
 *
 * Original routes/messages.js was 561 lines; this is one of its thematic
 * splits. Relative require paths were updated for the new directory depth.
 */

const { CHAR_LIMITS } = require("../../services/messageService");

module.exports = function registerCharLimitsRoutes(router) {
  router.get("/api/messages/char-limits", (req, res) => {
    return res.json(CHAR_LIMITS);
  });
};
