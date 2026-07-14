/**
 * instagramDiscovery/discoverViaGeolocation.js
 *
 * Discover business leads from an Instagram geolocation page.
 * Thin wrapper around runInstagramFeedDiscovery — the location explore URL is
 * https://www.instagram.com/explore/locations/<locationId>/.
 */

const logger = require("../../utils/logger");
const { safeEmit } = require("./shared");
const { runInstagramFeedDiscovery } = require("./runInstagramFeedDiscovery");

/**
 * Automate discover via Instagram Geolocation tags.
 * @param {object} page - Playwright page context
 * @param {object} params - Parameters object
 * @param {string} params.locationId - Instagram Location ID
 * @param {string} params.locationName - Geolocation title string
 * @param {number} [params.maxLeads=30] - Total lead target count
 * @param {function} emitter - Progress log callback
 */
async function discoverViaGeolocation(
  page,
  { locationId, locationName, maxLeads = 30 },
  emitter,
) {
  try {
    return await runInstagramFeedDiscovery(page, {
      exploreUrl: `https://www.instagram.com/explore/locations/${locationId}/`,
      sourceType: `location ${locationName}`,
      sourceKeyword: `geolocation:${locationId}:${locationName}`,
      maxLeads,
      emitter,
    });
  } catch (err) {
    logger.error("Instagram discoverViaGeolocation Failed", {
      locationId,
      locationName,
      error: err.message,
    });
    safeEmit(emitter, "error", `Location discovery failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

module.exports = { discoverViaGeolocation };
