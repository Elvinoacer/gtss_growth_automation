/**
 * Discovery Service — Public API
 *
 * Re-exports the exact module.exports surface of the original
 * discoveryService.js so that downstream `require("../services/discoveryService")`
 * calls continue to resolve transparently to this directory's index file.
 *
 * Public exports:
 *   - discoverLeads
 *   - listDiscoverySources
 *   - registerJobStream
 *   - emitJobEvent
 *   - closeJobStream
 *   - stopDiscovery
 *   - __private: { mapInstagramLead, parseXSearchLeadSnapshot,
 *                   parseFacebookSearchSnapshot, inferRoleCompanyFromBio,
 *                   normalizeXProfileUrl, normalizeFacebookProfileUrl,
 *                   buildLeadPersistenceRecord, validateLeadPersistenceRecord,
 *                   insertLeads }
 */

const { discoverLeads } = require("./discoverLeads");
const {
  listDiscoverySources,
  registerJobStream,
  emitJobEvent,
  closeJobStream,
  stopDiscovery,
} = require("./jobStreams");
const { insertLeads, buildLeadPersistenceRecord, validateLeadPersistenceRecord } = require("./persistence");
const {
  mapInstagramLead,
  parseXSearchLeadSnapshot,
  parseFacebookSearchSnapshot,
  inferRoleCompanyFromBio,
  normalizeXProfileUrl,
  normalizeFacebookProfileUrl,
} = require("./textParsing");

module.exports = {
  discoverLeads,
  listDiscoverySources,
  registerJobStream,
  emitJobEvent,
  closeJobStream,
  stopDiscovery,
  __private: {
    mapInstagramLead,
    parseXSearchLeadSnapshot,
    parseFacebookSearchSnapshot,
    inferRoleCompanyFromBio,
    normalizeXProfileUrl,
    normalizeFacebookProfileUrl,
    buildLeadPersistenceRecord,
    validateLeadPersistenceRecord,
    insertLeads,
  },
};
