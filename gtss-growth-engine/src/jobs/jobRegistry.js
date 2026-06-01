const activeJobs = new Map();

function startJob(jobId, metadata = {}) {
  const controller = new AbortController();
  activeJobs.set(String(jobId), {
    jobId: String(jobId),
    controller,
    metadata,
    startedAt: new Date().toISOString(),
  });
  return controller;
}

function registerJob(jobId, controller, metadata = {}) {
  activeJobs.set(String(jobId), {
    jobId: String(jobId),
    controller,
    metadata,
    startedAt: new Date().toISOString(),
  });
}

function finishJob(jobId) {
  activeJobs.delete(String(jobId));
}

function stopJob(jobId) {
  const job = activeJobs.get(String(jobId));
  if (!job) return false;
  job.controller.abort();
  activeJobs.delete(String(jobId));
  return true;
}

function stopJobsByPipeline(pipelineId) {
  let stopped = 0;
  for (const [jobId, job] of activeJobs.entries()) {
    if (job.metadata?.pipelineId === pipelineId) {
      job.controller.abort();
      activeJobs.delete(jobId);
      stopped += 1;
    }
  }
  return stopped;
}

function listActiveJobs() {
  return [...activeJobs.values()].map((job) => ({
    jobId: job.jobId,
    startedAt: job.startedAt,
    ...job.metadata,
    aborted: job.controller.signal.aborted,
  }));
}

module.exports = {
  startJob,
  registerJob,
  finishJob,
  stopJob,
  stopJobsByPipeline,
  listActiveJobs,
};
