/**
 * Discovery Service — Main Orchestrator
 * The top-level discoverLeads(keyword, platforms, maxLeads, jobId) function:
 * iterates the requested platforms, delegates to each per-platform discoverer
 * (with a per-platform timeout), tallies results, persists new leads via
 * insertLeads(), updates the discovery_runs row, and emits lifecycle events.
 * Extracted from the original discoveryService.js for maintainability.
 */

const { getDb } = require("../../db/database");
const { withTimeout } = require("./timing");
const {
  listDiscoverySources,
  emitJobEvent,
  closeJobStream,
  isJobStopped,
  stoppedJobs,
} = require("./jobStreams");
const { isWithinLimit } = require("./timing");
const { insertLeads } = require("./persistence");
const { discoverLeadsOnLinkedIn } = require("./discoverLinkedin");
const { discoverLeadsOnX } = require("./discoverX");
const { discoverLeadsOnInstagram } = require("./discoverInstagram");
const { discoverLeadsOnFacebook } = require("./discoverFacebook");

// Map of platform key -> per-platform discoverer, preserving the original
// platformDiscoveryMap shape. Built lazily at module load (after the per-
// platform modules' own requires have resolved).
const platformDiscoveryMap = {
  linkedin: discoverLeadsOnLinkedIn,
  x: discoverLeadsOnX,
  instagram: discoverLeadsOnInstagram,
  facebook: discoverLeadsOnFacebook,
};

/**
 * Discover leads for a single keyword across the requested platforms.
 *
 * For each platform:
 *   - Skip if the job has been stopped
 *   - Skip if the daily visit limit has been reached
 *   - Delegate to the per-platform discoverer (with DISCOVERY_PLATFORM_TIMEOUT_MS,
 *     default 300s)
 *   - Dedupe results against the in-run buffer and the DB
 *
 * After all platforms complete (or the job is stopped):
 *   - Persist new leads via insertLeads()
 *   - Update the discovery_runs row (leads_found + status)
 *   - Emit a `done` event with the result summary
 *   - Clean up the stop flag and close the SSE stream
 *
 * @param {string} keyword - Search keywords
 * @param {string[]} platforms - Subset of DISCOVERY_PLATFORM_KEYS to search
 * @param {number} maxLeads - Target new-lead count per platform
 * @param {string|number} jobId - discovery_runs row id
 * @returns {Promise<object>} { total, new, duplicates, invalid, stopped? }
 */
async function discoverLeads(keyword, platforms, maxLeads, jobId) {
  const db = getDb();
  const emit = (e) => emitJobEvent(jobId, { ...e, jobId });
  const selected = platforms.filter((p) => listDiscoverySources().includes(p));
  let totalNewCollected = 0;
  let prePersistedNew = 0;
  const rawProfiles = [];
  const platformErrors = [];

  emit({
    type: "info",
    message: `Starting discovery for "${keyword}" (Goal: ${maxLeads} new leads per selected platform)`,
  });

  try {
    for (const platform of selected) {
      if (isJobStopped(jobId)) break;

      // Limit Check
      if (!isWithinLimit(platform, "visits")) {
        emit({
          type: "warn",
          platform,
          message: `Daily visit limit reached for ${platform}. Skipping.`,
        });
        continue;
      }

      emit({
        type: "info",
        platform,
        message: `Searching ${platform} for up to ${maxLeads} new leads...`,
      });

      try {
        let platformNewCollected = 0;
        const found = await withTimeout(
          platformDiscoveryMap[platform](keyword, maxLeads, emit, jobId),
          Number(process.env.DISCOVERY_PLATFORM_TIMEOUT_MS || 300_000),
          `${platform} discovery`,
        );

        found.forEach((p) => {
          if (p && p.__prePersistedByDiscovery) {
            prePersistedNew++;
            totalNewCollected++;
            platformNewCollected++;
            return;
          }

          // Check if this profile is already in our collected list or in the DB
          const isInBatch = rawProfiles.some((rp) => rp.profile_url === p.profile_url);
          const existsInDb = db.prepare("SELECT 1 FROM leads WHERE profile_url = ?").get(p.profile_url);

          if (!isInBatch && !existsInDb) {
            totalNewCollected++;
            platformNewCollected++;
          }

          // We still push duplicates to rawProfiles so insertLeads can report them correctly,
          // but we only count non-duplicates toward our stopping goal.
          rawProfiles.push({ ...p, source_keyword: keyword });
        });

        emit({
          type: "info",
          platform,
          message: `${platform} discovery finished: ${platformNewCollected}/${maxLeads} new leads collected for this platform.`,
        });
      } catch (e) {
        platformErrors.push(e);
        emit({ type: "error", platform, message: e.message });
      }
    }

    if (
      rawProfiles.length === 0 &&
      prePersistedNew === 0 &&
      platformErrors.length > 0 &&
      platformErrors.length >= selected.length
    ) {
      throw platformErrors[platformErrors.length - 1];
    }

    if (isJobStopped(jobId)) {
      db.prepare("UPDATE discovery_runs SET status = ? WHERE id = ?").run(
        "stopped",
        jobId,
      );
      emit({ type: "stopped", jobId, message: "Discovery stopped by user." });
      closeJobStream(jobId);
      return { total: 0, new: 0, duplicates: 0, stopped: true };
    }

    const result = insertLeads(rawProfiles);
    if (prePersistedNew > 0) {
      result.total += prePersistedNew;
      result.new += prePersistedNew;
    }
    db.prepare("UPDATE discovery_runs SET leads_found = ?, status = ? WHERE id = ?").run(
      result.new,
      isJobStopped(jobId) ? "stopped" : "completed",
      jobId,
    );
    emit({ type: "done", result });
    return result;
  } catch (e) {
    db.prepare("UPDATE discovery_runs SET status = ? WHERE id = ?").run("failed", jobId);
    emit({ type: "error", message: e.message });
    throw e;
  } finally {
    stoppedJobs.delete(String(jobId));
    closeJobStream(jobId);
  }
}

module.exports = {
  discoverLeads,
  platformDiscoveryMap,
};
