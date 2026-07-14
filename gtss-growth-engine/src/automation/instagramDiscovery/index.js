/**
 * instagramDiscovery/index.js
 *
 * Barrel module that re-exports the EXACT same module.exports surface as the
 * original instagramDiscovery.js. Existing require('./instagramDiscovery')
 * callers resolve transparently to this file via Node.js's directory-index
 * resolution.
 *
 * Public API:
 *   - parseIgCount
 *   - filterBusinessProfile
 *   - scrapeProfileForLead
 *   - discoverViaHashtag
 *   - discoverViaGeolocation
 *   - discoverViaCompetitorFollowers
 *
 * Private API (under __private — preserved for test introspection):
 *   - createDiscoveryMetrics
 *   - collectDiscoveryLinks
 *   - readDiscoveryFeedState
 *   - advanceDiscoveryFeed
 *   - runInstagramFeedDiscovery
 */

const { parseIgCount } = require("./shared");
const { filterBusinessProfile } = require("./filterBusinessProfile");
const { scrapeProfileForLead } = require("./scrapeProfileForLead");
const { runInstagramFeedDiscovery } = require("./runInstagramFeedDiscovery");
const { discoverViaHashtag } = require("./discoverViaHashtag");
const { discoverViaGeolocation } = require("./discoverViaGeolocation");
const { discoverViaCompetitorFollowers } = require("./discoverViaCompetitorFollowers");
const {
  createDiscoveryMetrics,
  collectDiscoveryLinks,
  readDiscoveryFeedState,
  advanceDiscoveryFeed,
} = require("./discoveryFeedHelpers");

module.exports = {
  parseIgCount,
  filterBusinessProfile,
  scrapeProfileForLead,
  discoverViaHashtag,
  discoverViaGeolocation,
  discoverViaCompetitorFollowers,
  __private: {
    createDiscoveryMetrics,
    collectDiscoveryLinks,
    readDiscoveryFeedState,
    advanceDiscoveryFeed,
    runInstagramFeedDiscovery,
  },
};
