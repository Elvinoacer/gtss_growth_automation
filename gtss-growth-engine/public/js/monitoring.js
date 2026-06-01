/* global gtss */

const REFRESH_MS = 10000;
let refreshTimer = null;

const JOB_TYPE_LABELS = {
  outreach: "Outreach",
  content: "Content",
  dm_check: "DM check",
  discovery: "Discovery",
  scheduled_post: "Scheduled post",
  campaign_dm: "Campaign DM",
  campaign_connection: "Campaign connection",
};

function formatJobType(jobType) {
  return JOB_TYPE_LABELS[jobType] || jobType || "Unknown";
}

function formatStage(stage) {
  if (!stage) return "--";
  return String(stage).replace(/_/g, " ");
}

function formatDate(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

function formatDuration(start, end) {
  const startTime = new Date(start).getTime();
  const endTime = new Date(end).getTime();
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) return "--";

  let delta = Math.max(0, endTime - startTime);
  const seconds = Math.floor(delta / 1000) % 60;
  const minutes = Math.floor(delta / 60000) % 60;
  const hours = Math.floor(delta / 3600000);

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function summarizeContext(context) {
  if (!context || typeof context !== "object") return "";
  const candidates = [
    "platform",
    "keyword",
    "leadId",
    "lead_id",
    "postId",
    "post_id",
    "campaignId",
    "campaign_id",
    "repliesFound",
    "nextRetryAt",
  ];

  const parts = [];
  for (const key of candidates) {
    if (context[key] !== undefined && context[key] !== null) {
      parts.push(`${key}: ${context[key]}`);
    }
  }

  if (context.error) {
    const errMsg =
      typeof context.error === "object" ? context.error.message : context.error;
    if (errMsg) parts.push(`error: ${errMsg}`);
  }

  return parts.join(" | ");
}

function renderJobCard(job) {
  const statusClass = `status-${job.status || "running"}`;
  const jobId = gtss.escapeHtml(String(job.job_id || ""));
  const jobType = gtss.escapeHtml(String(job.job_type || ""));
  const message = gtss.escapeHtml(job.message || "");
  const stage = gtss.escapeHtml(formatStage(job.stage));
  const duration = formatDuration(job.started_at, job.last_event_at);
  const lastEvent = formatDate(job.last_event_at);
  const startedAt = formatDate(job.started_at);

  return `
    <article class="job-card" data-job-id="${jobId}" data-job-type="${jobType}">
      <div class="job-header">
        <div>
          <div class="job-type">${gtss.escapeHtml(formatJobType(job.job_type))}</div>
          <div class="job-meta">Stage: <strong>${stage}</strong></div>
        </div>
        <span class="job-status ${statusClass}">${job.status || "running"}</span>
      </div>
      <div class="job-meta">
        <div>Last event: ${lastEvent}</div>
        <div>Started: ${startedAt}</div>
        <div>Duration: ${duration}</div>
        <div>Job ID: <code>${jobId}</code></div>
      </div>
      <div class="job-meta">${message}</div>
      <button class="job-toggle" data-job-toggle="${jobId}" data-job-type="${jobType}">
        View timeline
      </button>
      <div class="job-timeline" data-job-timeline="${jobId}" hidden></div>
    </article>
  `;
}

function renderJobColumn(containerId, jobs) {
  const container = document.getElementById(containerId);
  if (!container) return;

  if (!jobs || jobs.length === 0) {
    container.innerHTML = `<div class="job-meta">No jobs yet.</div>`;
    return;
  }

  container.innerHTML = jobs.map(renderJobCard).join("");
}

function updateCounts(prefix, count) {
  const el = document.getElementById(`count-${prefix}`);
  if (el) el.textContent = count;
}

async function loadJobs() {
  const data = await gtss.fetchJSON("/api/monitoring/jobs");
  const running = data.running || [];
  const completed = data.completed || [];
  const failed = data.failed || [];
  const retrying = data.retrying || [];

  renderJobColumn("monitoring-running", running);
  renderJobColumn("monitoring-completed", completed);
  renderJobColumn("monitoring-failed", failed);
  renderJobColumn("monitoring-retrying", retrying);

  updateCounts("running", running.length);
  updateCounts("completed", completed.length);
  updateCounts("failed", failed.length);
  updateCounts("retrying", retrying.length);

  attachTimelineListeners();
}

async function loadStats() {
  const data = await gtss.fetchJSON("/api/monitoring/stats");
  const stats = data.stats || {};
  const setStat = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value || 0;
  };

  setStat("stat-running", stats.running);
  setStat("stat-completed", stats.completed);
  setStat("stat-failed", stats.failed);
  setStat("stat-retrying", stats.retrying);
}

async function loadErrors() {
  const filter = document.getElementById("error-filter");
  const jobType = filter ? filter.value : "";
  const query = jobType ? `?jobType=${encodeURIComponent(jobType)}` : "";
  const data = await gtss.fetchJSON(`/api/monitoring/errors${query}`);
  const errors = data.errors || [];

  const container = document.getElementById("monitoring-errors");
  if (!container) return;

  if (errors.length === 0) {
    container.innerHTML = `<div class="job-meta">No errors logged.</div>`;
    return;
  }

  container.innerHTML = errors
    .map((entry) => {
      const context = summarizeContext(entry.context);
      return `
        <div class="error-item">
          <strong>${gtss.escapeHtml(formatJobType(entry.job_type))}</strong>
          <span>${gtss.escapeHtml(entry.message || "")}</span>
          <code>${gtss.escapeHtml(entry.job_id || "")}</code>
          <span class="job-meta">${gtss.escapeHtml(formatDate(entry.created_at))}</span>
          ${context ? `<span class="job-meta">${gtss.escapeHtml(context)}</span>` : ""}
        </div>
      `;
    })
    .join("");
}

function attachTimelineListeners() {
  document.querySelectorAll("[data-job-toggle]").forEach((button) => {
    button.addEventListener("click", async () => {
      const jobId = button.dataset.jobToggle;
      const jobType = button.dataset.jobType || "";
      const panel = document.querySelector(`[data-job-timeline='${jobId}']`);
      if (!panel) return;

      if (panel.dataset.expanded === "true") {
        panel.dataset.expanded = "false";
        panel.hidden = true;
        button.textContent = "View timeline";
        return;
      }

      panel.hidden = false;
      panel.dataset.expanded = "true";
      button.textContent = "Hide timeline";
      panel.innerHTML = `<div class="job-meta">Loading timeline...</div>`;

      try {
        const query = jobType ? `?jobType=${encodeURIComponent(jobType)}` : "";
        const data = await gtss.fetchJSON(
          `/api/monitoring/jobs/${encodeURIComponent(jobId)}${query}`,
        );
        const events = data.events || [];
        if (events.length === 0) {
          panel.innerHTML = `<div class="job-meta">No events recorded.</div>`;
          return;
        }

        panel.innerHTML = events
          .map((event) => {
            const context = summarizeContext(event.context);
            return `
              <div class="timeline-item">
                <strong>${gtss.escapeHtml(formatStage(event.stage))} (${gtss.escapeHtml(event.level || "info")})</strong>
                <span>${gtss.escapeHtml(event.message || "")}</span>
                <span class="job-meta">${gtss.escapeHtml(formatDate(event.created_at))}</span>
                ${context ? `<span class="job-meta">${gtss.escapeHtml(context)}</span>` : ""}
              </div>
            `;
          })
          .join("");
      } catch (err) {
        panel.innerHTML = `<div class="job-meta">Failed to load timeline.</div>`;
      }
    });
  });
}

function updateLastUpdated() {
  const el = document.getElementById("monitoring-last-updated");
  if (!el) return;
  el.textContent = `Last updated: ${new Date().toLocaleTimeString()}`;
}

async function refreshAll() {
  try {
    await Promise.all([loadJobs(), loadStats(), loadErrors()]);
    updateLastUpdated();
  } catch (err) {
    gtss.showToast(`Monitoring refresh failed: ${err.message}`, "error");
  }
}

function startAutoRefresh() {
  if (refreshTimer) window.clearInterval(refreshTimer);
  refreshTimer = window.setInterval(refreshAll, REFRESH_MS);
}

function stopAutoRefresh() {
  if (refreshTimer) window.clearInterval(refreshTimer);
  refreshTimer = null;
}

function initMonitoring() {
  const refreshBtn = document.getElementById("monitoring-refresh");
  if (refreshBtn) refreshBtn.addEventListener("click", refreshAll);

  const autoToggle = document.getElementById("monitoring-auto-refresh");
  if (autoToggle) {
    autoToggle.addEventListener("change", () => {
      if (autoToggle.checked) startAutoRefresh();
      else stopAutoRefresh();
    });
  }

  const errorFilter = document.getElementById("error-filter");
  if (errorFilter) errorFilter.addEventListener("change", loadErrors);

  refreshAll();
  startAutoRefresh();
}

document.addEventListener("DOMContentLoaded", initMonitoring);
