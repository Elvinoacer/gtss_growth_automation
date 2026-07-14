/**
 * Automation Routes — Pipeline Run Control + SSE Stream
 *
 * Express handlers for triggering and monitoring a full outreach pipeline
 * run (discovery → qualification → messages → send):
 *   POST /api/pipeline/run            — Trigger a manual full or partial pipeline run
 *   POST /api/pipeline/abort/:runId   — Signal abort for a specific run
 *   POST /api/pipeline/pause/:runId   — Signal pause-after-current-stage for a run
 *   POST /api/pipeline/resume/:runId  — Resume a paused run
 *   GET  /api/pipeline/stream/:runId  — SSE stream for a pipeline run's events
 *   GET  /api/pipeline/runs           — List recent pipeline runs (paginated)
 *   GET  /api/pipeline/runs/:runId    — Single run detail
 *
 * Cross-file dependencies: ../../db/database (getDb), ../../pipeline/pipelineRunner
 * (runFullPipeline, abortPipelineRun, pausePipelineRun, resumePipelineRun,
 * getPipelineRun, listPipelineRuns, registerPipelineStream), ../../utils/logger.
 *
 * Extracted from the original routes/automation.js for maintainability.
 */

const { getDb } = require("../../db/database");
const {
  runFullPipeline,
  abortPipelineRun,
  pausePipelineRun,
  resumePipelineRun,
  getPipelineRun,
  listPipelineRuns,
  registerPipelineStream,
} = require("../../pipeline/pipelineRunner");
const logger = require("../../utils/logger");

/**
 * Register the pipeline control + stream routes on the given router.
 *
 * @param {import('express').Router} router
 */
function registerPipelineRoutes(router) {
  // POST /api/pipeline/run — trigger full or partial pipeline
  router.post("/api/pipeline/run", async (req, res) => {
    const { mode, stages } = req.body || {};
    const options = {};
    const db = getDb();
    const row = db
      .prepare("SELECT limits_json FROM pipeline_schedules WHERE id = 'outreach'")
      .get();
    try {
      options.limits = JSON.parse(row?.limits_json || "{}");
    } catch (_) {
      options.limits = {};
    }

    if (mode === 'ai' || mode === 'manual') {
      options.mode = mode;
    }
    if (Array.isArray(stages) && stages.length > 0) {
      const validStages = ['discovery', 'qualification', 'messages', 'send'];
      options.stages = stages.filter(s => validStages.includes(s));
      if (options.stages.length === 0) delete options.stages;
    }

    try {
      let resolveRunId;
      const runIdPromise = new Promise((resolve) => {
        resolveRunId = resolve;
      });
      runFullPipeline("manual", {
        ...options,
        onRunId: resolveRunId,
      }).catch((error) => {
        logger.error("PIPELINE", "Manual pipeline run failed", { error: error.message });
      });
      const runId = await runIdPromise;
      res.json({ success: true, runId });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post("/api/pipeline/abort/:runId", (req, res) => {
    abortPipelineRun(Number(req.params.runId));
    res.json({ success: true, message: "Pipeline abort signal sent." });
  });

  router.post("/api/pipeline/pause/:runId", (req, res) => {
    pausePipelineRun(Number(req.params.runId));
    res.json({ success: true, message: "Pipeline will pause after the current stage." });
  });

  router.post("/api/pipeline/resume/:runId", (req, res) => {
    resumePipelineRun(Number(req.params.runId));
    res.json({ success: true, message: "Pipeline resumed." });
  });

  // GET /api/pipeline/stream/:runId — SSE stream for pipeline events
  router.get("/api/pipeline/stream/:runId", (req, res) => {
    const runId = req.params.runId;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    registerPipelineStream(runId, res);
  });

  // GET /api/pipeline/runs — list recent pipeline runs
  router.get("/api/pipeline/runs", (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const runs = listPipelineRuns(limit);
    res.json(runs);
  });

  // GET /api/pipeline/runs/:runId — single run detail
  router.get("/api/pipeline/runs/:runId", (req, res) => {
    const run = getPipelineRun(Number(req.params.runId));
    if (!run) return res.status(404).json({ error: 'Pipeline run not found' });
    res.json(run);
  });
}

module.exports = { registerPipelineRoutes };
