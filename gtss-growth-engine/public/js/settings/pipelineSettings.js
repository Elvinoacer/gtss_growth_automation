/**
 * settings/pipelineSettings.js — Pipeline Settings section.
 *
 * Originally part of public/js/settings.js. Holds the entire Pipeline
 * Settings section's load / render / save / run / abort / pause / resume /
 * keyword-add / keyword-remove flow plus the Socket.IO subscriber that
 * updates the result pill in real time as the pipeline runs.
 *
 * Functions:
 *   - loadPipelineSettings()        — Promise.all of /api/settings/pipeline +
 *                                     /api/discovery/keywords +
 *                                     /api/pipeline/runs?limit=5; calls
 *                                     applyPipelineConfig + renderKeywords +
 *                                     renderPipelineRuns.
 *   - applyPipelineConfig(config)   — populate the 13 pipeline-config
 *                                     inputs (mode, auto-approve, cron, the
 *                                     4 stage modes, qualification knobs,
 *                                     max-DMs/connections, the 2 outreach
 *                                     modes) and the outreach-platforms list.
 *   - renderOutreachPlatforms(sel)  — render the per-platform checkbox list.
 *   - collectOutreachPlatforms()    — read the checked checkboxes.
 *   - renderKeywords(data)          — render the keywords list with remove
 *                                     buttons.
 *   - renderPipelineRuns(runs)      — render the last-5-runs table.
 *   - savePipelineSettings()        — PATCH the collected config to
 *                                     /api/settings/pipeline.
 *   - runPipeline()                 — POST /api/pipeline/run, then start
 *                                     watching the run via Socket.IO.
 *   - abortPipeline() / pausePipeline() / resumePipeline()
 *                                   — POST the corresponding control
 *                                     endpoint, then flip the
 *                                     pause/resume button visibility.
 *   - finishPipelineControls(runId, message, tone)
 *                                   — reset the Run button to its idle
 *                                     state, hide abort/pause/resume, clear
 *                                     activePipelineRunId, and reload.
 *   - subscribeToPipelineStream(runId)
 *                                   — attach a one-shot pipeline:event
 *                                     listener that updates the result pill
 *                                     as stage events arrive and calls
 *                                     finishPipelineControls on
 *                                     complete/aborted events.
 *   - addKeyword() / removeKeyword(idx)
 *                                   — POST add / DELETE the keyword at idx.
 *   - bindPipelineEvents()          — wire up the Save/Run/Abort/Pause/
 *                                     Resume/Add-Keyword buttons + the
 *                                     delegated remove-keyword click handler.
 *
 * Depends on globals declared in state.js (pipelineState,
 * activePipelineRunId, pipelineSocketSubscribed, settingsState) +
 * helpers.js (setInline, platformLabel).
 */

async function loadPipelineSettings() {
  try {
    const [config, keywords, runs] = await Promise.all([
      window.gtss.fetchJSON("/api/settings/pipeline"),
      window.gtss.fetchJSON("/api/discovery/keywords"),
      window.gtss.fetchJSON("/api/pipeline/runs?limit=5"),
    ]);
    pipelineState.config = config;
    pipelineState.keywords = keywords;
    pipelineState.runs = runs;
    applyPipelineConfig(config);
    renderKeywords(keywords);
    renderPipelineRuns(runs);
  } catch (error) {
    console.error("Failed to load pipeline settings:", error);
  }
}

function applyPipelineConfig(config) {
  document.getElementById("pipeline-mode").value = config.pipelineMode || "ai";
  document.getElementById("pipeline-auto-approve").value =
    config.autoApproveVariant || "B";
  document.getElementById("pipeline-cron").value =
    config.pipelineCron || "0 8 * * *";
  document.getElementById("discovery-mode").value = config.discoveryMode || "";
  document.getElementById("qualification-mode").value =
    config.qualificationMode || "";
  document.getElementById("message-mode").value = config.messageMode || "";
  document.getElementById("send-mode").value = config.sendMode || "";
  document.getElementById("qualification-threshold").value =
    config.qualificationThreshold ?? 50;
  document.getElementById("qualification-manual-score").value =
    config.qualificationManualScore ?? 75;
  const maxDmsInput = document.getElementById("pipeline-max-dms-per-run");
  if (maxDmsInput) maxDmsInput.value = config.maxDmsPerRun ?? 20;
  const maxConnectionsInput = document.getElementById(
    "pipeline-max-connections-per-run",
  );
  if (maxConnectionsInput) {
    maxConnectionsInput.value = config.maxConnectionsPerRun ?? 15;
  }
  document.getElementById("linkedin-outreach-mode").value =
    config.linkedinOutreachMode || "connect_first";
  document.getElementById("x-outreach-mode").value =
    config.xOutreachMode || "follow_first";
  renderOutreachPlatforms(config.outreachPlatforms || []);
}

function renderOutreachPlatforms(selectedPlatforms) {
  const container = document.getElementById("outreach-platforms-list");
  if (!container) return;
  const selected = new Set(
    (Array.isArray(selectedPlatforms) ? selectedPlatforms : [])
      .map((platform) => String(platform).toLowerCase())
      .filter(Boolean),
  );
  const platforms = settingsState.settings.platforms || [];
  container.innerHTML = platforms
    .map(
      (platform) => `
      <label>
        <input
          type="checkbox"
          data-outreach-platform="${platform.key}"
          ${selected.has(platform.key) ? "checked" : ""}
        />
        ${platform.label || platformLabel(platform.key)}
      </label>
    `,
    )
    .join("");
}

function collectOutreachPlatforms() {
  return [
    ...document.querySelectorAll("[data-outreach-platform]:checked"),
  ].map((checkbox) => checkbox.dataset.outreachPlatform);
}

function renderKeywords(data) {
  const list = document.getElementById("keywords-list");
  if (!data.keywords || data.keywords.length === 0) {
    list.innerHTML = '<span class="muted">No keywords configured.</span>';
    return;
  }
  list.innerHTML = data.keywords
    .map(
      (kw, idx) => `
    <div style="display: flex; align-items: center; gap: 8px;">
      <span style="flex: 1; color: var(--gtss-text); font-size: 13px;">${idx + 1}. ${kw}</span>
      <button class="secondary-button" data-remove-keyword="${idx}" type="button" style="min-height: 30px; padding: 0 8px; font-size: 12px;">✕</button>
    </div>
  `,
    )
    .join("");
}

function renderPipelineRuns(runs) {
  const body = document.getElementById("pipeline-runs-body");
  if (!runs || runs.length === 0) {
    body.innerHTML =
      '<tr><td colspan="9" class="muted" style="text-align: center;">No pipeline runs yet</td></tr>';
    return;
  }
  body.innerHTML = runs
    .map((run) => {
      const s = run.stages || {};
      const statusClass =
        run.status === "completed"
          ? "color: var(--gtss-success)"
          : run.status === "failed"
            ? "color: var(--gtss-danger)"
            : "color: var(--gtss-warning, #f59e0b)";
      return `<tr>
      <td>${run.id}</td>
      <td>${run.trigger}</td>
      <td>${run.mode}</td>
      <td style="${statusClass}; font-weight: 800;">${run.status}</td>
      <td>${run.started_at ? new Date(run.started_at).toLocaleString() : "-"}</td>
      <td>${s.discovery ? `${s.discovery.newLeads || 0} new` : "-"}</td>
      <td>${s.qualification ? `${s.qualification.qualified || 0}` : "-"}</td>
      <td>${s.messages ? `${s.messages.generated || 0}` : "-"}</td>
      <td>${s.send ? `${s.send.sent || 0}` : "-"}</td>
    </tr>`;
    })
    .join("");
}

async function savePipelineSettings() {
  try {
    await window.gtss.fetchJSON("/api/settings/pipeline", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pipelineMode: document.getElementById("pipeline-mode").value,
        autoApproveVariant: document.getElementById("pipeline-auto-approve")
          .value,
        pipelineCron: document.getElementById("pipeline-cron").value,
        discoveryMode: document.getElementById("discovery-mode").value,
        qualificationMode: document.getElementById("qualification-mode").value,
        messageMode: document.getElementById("message-mode").value,
        sendMode: document.getElementById("send-mode").value,
        qualificationThreshold: document.getElementById(
          "qualification-threshold",
        ).value,
        qualificationManualScore: document.getElementById(
          "qualification-manual-score",
        ).value,
        maxDmsPerRun: document.getElementById("pipeline-max-dms-per-run")
          ?.value,
        maxConnectionsPerRun: document.getElementById(
          "pipeline-max-connections-per-run",
        )?.value,
        outreachPlatforms: collectOutreachPlatforms(),
        linkedinOutreachMode: document.getElementById("linkedin-outreach-mode")
          .value,
        xOutreachMode: document.getElementById("x-outreach-mode").value,
      }),
    });
    window.gtss.showToast("Pipeline settings saved", "success");
  } catch (error) {
    window.gtss.showToast(error.message, "error");
  }
}

async function runPipeline() {
  const btn = document.getElementById("run-pipeline");
  const abortBtn = document.getElementById("abort-pipeline");
  const pauseBtn = document.getElementById("pause-pipeline");
  const resumeBtn = document.getElementById("resume-pipeline");
  btn.disabled = true;
  btn.textContent = "⏳ Running...";
  setInline(
    "pipeline-result",
    "Pipeline running — this may take several minutes...",
    "",
  );

  try {
    const mode = document.getElementById("pipeline-mode").value;
    const result = await window.gtss.fetchJSON("/api/pipeline/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    activePipelineRunId = result.runId;
    if (abortBtn) abortBtn.style.display = "inline-flex";
    if (pauseBtn) pauseBtn.style.display = "inline-flex";
    if (resumeBtn) resumeBtn.style.display = "none";
    setInline(
      "pipeline-result",
      `Pipeline run #${result.runId} started. Watching for updates…`,
      "success",
    );
    subscribeToPipelineStream(result.runId);
  } catch (error) {
    btn.disabled = false;
    btn.textContent = "▶ Run Pipeline Now";
    setInline("pipeline-result", `Pipeline failed: ${error.message}`, "error");
  }
}

async function abortPipeline() {
  if (!activePipelineRunId) return;
  await window.gtss.fetchJSON(`/api/pipeline/abort/${activePipelineRunId}`, {
    method: "POST",
  });
  setInline(
    "pipeline-result",
    "Abort signal sent — pipeline will stop after the current stage.",
    "warn",
  );
}

async function pausePipeline() {
  if (!activePipelineRunId) return;
  await window.gtss.fetchJSON(`/api/pipeline/pause/${activePipelineRunId}`, {
    method: "POST",
  });
  document.getElementById("pause-pipeline").style.display = "none";
  document.getElementById("resume-pipeline").style.display = "inline-flex";
  setInline("pipeline-result", "Pause signal sent — pipeline will pause at the next boundary.", "warn");
}

async function resumePipeline() {
  if (!activePipelineRunId) return;
  await window.gtss.fetchJSON(`/api/pipeline/resume/${activePipelineRunId}`, {
    method: "POST",
  });
  document.getElementById("pause-pipeline").style.display = "inline-flex";
  document.getElementById("resume-pipeline").style.display = "none";
  setInline("pipeline-result", "Pipeline resumed.", "success");
}

function finishPipelineControls(runId, message, tone = "success") {
  setInline("pipeline-result", message, tone);
  const runBtn = document.getElementById("run-pipeline");
  runBtn.disabled = false;
  runBtn.textContent = "▶ Run Pipeline Now";
  ["abort-pipeline", "pause-pipeline", "resume-pipeline"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
  });
  activePipelineRunId = null;
  loadPipelineSettings();
}

function subscribeToPipelineStream(runId) {
  const socket = window.gtss.getSocket?.();
  if (!socket || pipelineSocketSubscribed) return;
  pipelineSocketSubscribed = true;

  socket.on("pipeline:event", (event) => {
    if (String(event.runId) !== String(activePipelineRunId || runId)) return;

    if (event.type === "stage" || event.type === "stage_done" || event.type === "info") {
      setInline("pipeline-result", event.message, "");
    } else if (event.type === "complete") {
      finishPipelineControls(event.runId, `✓ Pipeline #${event.runId} complete.`, "success");
    } else if (event.type === "warn" && /aborted/i.test(event.message || "")) {
      finishPipelineControls(event.runId, `Pipeline #${event.runId} aborted.`, "warn");
    } else if (event.type === "error") {
      setInline("pipeline-result", `Error: ${event.message}`, "error");
    }
  });
}

async function addKeyword() {
  const input = document.getElementById("new-keyword");
  const keyword = input.value.trim();
  if (!keyword) return;

  try {
    const result = await window.gtss.fetchJSON("/api/discovery/keywords/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keyword }),
    });
    pipelineState.keywords = result.config;
    renderKeywords(result.config);
    input.value = "";
    window.gtss.showToast("Keyword added", "success");
  } catch (error) {
    window.gtss.showToast(error.message, "error");
  }
}

async function removeKeyword(idx) {
  try {
    const result = await window.gtss.fetchJSON(
      `/api/discovery/keywords/${idx}`,
      {
        method: "DELETE",
      },
    );
    pipelineState.keywords = result.config;
    renderKeywords(result.config);
    window.gtss.showToast(`Removed: ${result.removed}`, "success");
  } catch (error) {
    window.gtss.showToast(error.message, "error");
  }
}

function bindPipelineEvents() {
  document
    .getElementById("save-pipeline")
    .addEventListener("click", savePipelineSettings);
  document
    .getElementById("run-pipeline")
    .addEventListener("click", runPipeline);
  document
    .getElementById("abort-pipeline")
    ?.addEventListener("click", abortPipeline);
  document
    .getElementById("pause-pipeline")
    ?.addEventListener("click", pausePipeline);
  document
    .getElementById("resume-pipeline")
    ?.addEventListener("click", resumePipeline);
  document.getElementById("add-keyword").addEventListener("click", addKeyword);
  document.getElementById("new-keyword").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addKeyword();
  });
  document.addEventListener("click", (event) => {
    const removeBtn = event.target.closest("[data-remove-keyword]");
    if (removeBtn) {
      removeKeyword(Number(removeBtn.dataset.removeKeyword));
    }
  });
}
