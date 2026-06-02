const logger = require("../utils/logger");

let activeRun = null;
let tail = Promise.resolve();
let pendingCount = 0;

function getPipelineQueueState() {
  return {
    activeRun: activeRun ? { ...activeRun } : null,
    queuedCount: Math.max(0, pendingCount - (activeRun ? 1 : 0)),
  };
}

function enqueuePipelineRun(pipelineId, runLabel, runner, options = {}) {
  if (typeof runner !== "function") {
    throw new TypeError("enqueuePipelineRun requires a runner function");
  }

  const queuedAt = new Date().toISOString();
  const label = runLabel || `${pipelineId}-${Date.now()}`;
  const position = Math.max(0, pendingCount - (activeRun ? 1 : 0));
  const mustWait = pendingCount > 0;
  pendingCount += 1;

  if (mustWait) {
    if (typeof options.onQueued === "function") {
      options.onQueued({
        label,
        pipelineId,
        queuedAt,
        position,
        activeRun: activeRun ? { ...activeRun } : null,
      });
    }
    logger.info("PIPELINE-QUEUE", `Queued ${pipelineId} run ${label}`, {
      position,
      activeRun,
    });
  }

  const execute = async () => {
    activeRun = {
      label,
      pipelineId,
      queuedAt,
      startedAt: new Date().toISOString(),
    };
    try {
      return await runner();
    } finally {
      activeRun = null;
      pendingCount = Math.max(0, pendingCount - 1);
    }
  };

  const runPromise = tail.then(execute, execute);
  tail = runPromise.catch(() => {});
  return runPromise;
}

module.exports = {
  enqueuePipelineRun,
  getPipelineQueueState,
};
