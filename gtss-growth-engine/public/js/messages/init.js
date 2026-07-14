/**
 * messages/init.js — Launch-time boot sequence for the Message Generator
 * page. Loaded LAST (after every other split file) so all referenced
 * functions are guaranteed to exist.
 *
 * Defines:
 *   - loadPipelineConfig() — async; fetches /api/settings/pipeline so the
 *                            review modal can show the correct X/LinkedIn
 *                            outreach-mode hint
 *
 * Then runs the boot calls in order:
 *   1. loadPlatformFilterOptions() — populates the platform-filter <select>
 *   2. loadPipelineConfig()         — fetches the pipeline outreach config
 *   3. loadStats()                  — initial stat counters
 *   4. loadMessages()               — first page of messages
 *   5. resumeActiveMessageGeneration() — reattach to a running bulk job,
 *      if any
 *
 * Depends on (from messages/state.js, loaded earlier):
 *   - fetchJSON, pipelineConfig
 * Depends on (from messages/helpers.js, loaded earlier):
 *   - loadPlatformFilterOptions
 * Depends on (from messages/stats.js, loaded earlier):
 *   - loadStats
 * Depends on (from messages/table.js, loaded earlier):
 *   - loadMessages
 * Depends on (from messages/generateAll.js, loaded earlier):
 *   - resumeActiveMessageGeneration
 */

async function loadPipelineConfig() {
  try {
    pipelineConfig = await fetchJSON("/api/settings/pipeline");
  } catch (err) {
    console.warn("Failed to load pipeline config for outreach hints:", err);
  }
}

loadPlatformFilterOptions().finally(() => {
  loadPipelineConfig().finally(() => {
    loadStats();
    loadMessages();
    resumeActiveMessageGeneration();
  });
});
