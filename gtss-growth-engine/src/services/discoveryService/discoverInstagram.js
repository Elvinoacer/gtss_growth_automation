/**
 * Discovery Service — Instagram Per-Platform Discoverer
 * The Instagram branch of platformDiscoveryMap: opens a browser and delegates
 * to automation/instagramDiscovery (lazy-required to avoid a circular module
 * load with the automation layer), then maps the returned IG leads into the
 * canonical lead-record shape via mapInstagramLead.
 * Extracted from the original discoveryService.js for maintainability.
 */

const { captureFailureArtifact } = require("../../automation/browserBase");
const { createBrowserContext, closeBrowserContext } = require("./timing");
const { mapInstagramLead } = require("./textParsing");

/**
 * Instagram discoverer. Keyword format encodes the discovery mode:
 *   - "#hashtag"                    -> discoverViaHashtag
 *   - "geolocation:<id>:<name>"     -> discoverViaGeolocation
 *   - "competitor_followers:<acct>" -> discoverViaCompetitorFollowers
 *   - "competitor:<acct>"           -> discoverViaCompetitorFollowers (alias)
 *
 * @param {string} kw - Keyword (with mode prefix)
 * @param {number} max - Target new-lead count for this run
 * @param {function} emit - Event emitter (called with { type, platform, message })
 * @param {string|number} jobId - Reserved for interface parity (unused)
 * @returns {Promise<object[]>} Collected lead records (already pre-persisted by
 *   the instagramDiscovery layer, tagged with __prePersistedByDiscovery: true)
 */
async function discoverLeadsOnInstagram(kw, max, emit, jobId) {
  // NOTE: jobId is intentionally unused — the Instagram discoverer runs in a
  // single bound and does not poll isJobStopped() between sub-steps. Parameter
  // is kept for parity with the other per-platform discoverers and with the
  // original platformDiscoveryMap shape.
  void jobId;

  const {
    discoverViaHashtag,
    discoverViaGeolocation,
    discoverViaCompetitorFollowers,
  } = require("../../automation/instagramDiscovery");

  const browserState = await createBrowserContext("instagram");
  const page = browserState.page;
  let rawLeads = [];

  try {
    emit({
      type: "info",
      platform: "instagram",
      message: "Opening Instagram browser for discovery...",
    });

    const progressEmitter = (type, message, data) => {
      emit({ type, platform: "instagram", message, ...data });
    };

    let result;
    if (kw.startsWith("#")) {
      const hashtag = kw.substring(1);
      result = await discoverViaHashtag(page, { hashtag, maxLeads: max }, progressEmitter);
    } else if (kw.startsWith("geolocation:")) {
      const parts = kw.split(":");
      const locationId = parts[1];
      const locationName = parts[2];
      result = await discoverViaGeolocation(page, { locationId, locationName, maxLeads: max }, progressEmitter);
    } else if (kw.startsWith("competitor_followers:")) {
      const targetAccount = kw.substring("competitor_followers:".length);
      result = await discoverViaCompetitorFollowers(page, { targetAccount, maxProfiles: max }, progressEmitter);
    } else if (kw.startsWith("competitor:")) {
      const targetAccount = kw.substring("competitor:".length);
      result = await discoverViaCompetitorFollowers(page, { targetAccount, maxProfiles: max }, progressEmitter);
    } else {
      throw new Error(
        `Invalid Instagram discovery input format: "${kw}". Must start with '#', 'geolocation:', 'competitor_followers:', or 'competitor:'.`,
      );
    }

    if (result && result.success === false) {
      throw new Error(result.error || "Instagram discovery failed");
    }

    if (result && result.leads) {
      rawLeads = result.leads.map((lead) => ({
        ...mapInstagramLead(lead, kw),
        __prePersistedByDiscovery: true,
      }));
    }
    return rawLeads;
  } catch (error) {
    await captureFailureArtifact(page, "instagram", "discovery-instagram");
    throw error;
  } finally {
    emit({
      type: "info",
      platform: "instagram",
      message: "Closing Instagram discovery browser...",
    });
    await closeBrowserContext("instagram", browserState);
  }
}

module.exports = {
  discoverLeadsOnInstagram,
};
