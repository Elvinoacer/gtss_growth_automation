/**
 * instagramDiscovery/discoverViaHashtag.js
 *
 * Discover business leads from an Instagram hashtag page.
 * Thin wrapper around runInstagramFeedDiscovery — the hashtag explore URL is
 * https://www.instagram.com/explore/tags/<hashtag>/.
 */

const logger = require("../../utils/logger");
const { safeEmit } = require("./shared");
const { runInstagramFeedDiscovery } = require("./runInstagramFeedDiscovery");

/**
 * Automate discover via Instagram hashtags.
 * @param {object} page - Playwright page context
 * @param {object} params - Parameters object
 * @param {string} params.hashtag - Hashtag text to explore
 * @param {number} [params.maxLeads=30] - Total lead target count
 * @param {function} emitter - Progress log callback
 */
async function discoverViaHashtag(page, { hashtag, maxLeads = 30 }, emitter) {
  try {
    return await runInstagramFeedDiscovery(page, {
      exploreUrl: `https://www.instagram.com/explore/tags/${hashtag}/`,
      sourceType: `hashtag #${hashtag}`,
      sourceKeyword: `hashtag:${hashtag}`,
      maxLeads,
      emitter,
    });
  } catch (err) {
    logger.error("Instagram discoverViaHashtag Failed", {
      hashtag,
      error: err.message,
    });
    safeEmit(emitter, "error", `Hashtag discovery failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

module.exports = { discoverViaHashtag };
