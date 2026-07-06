/**
 * pipelines.js — Pipeline Operations Center UI
 *
 * Features:
 *   - Full lifecycle controls: Run Now / Pause / Resume / Stop / Restart / Retry-Stage / Resume-from-Checkpoint
 *   - Real-time progress bar + current stage indicator (Socket.IO)
 *   - Per-stage checkpoint visualization (done / active / failed / skipped)
 *   - Health metrics: last run, next run, uptime, success rate, failure rate, avg duration, retries, consecutive failures
 *   - Execution history with drill-down (state, error, stack trace, checkpoints, logs)
 *   - Searchable / filterable structured logs viewer
 *   - Live log tail (Socket.IO)
 */

/* global gtss, io */

// ── Constants ─────────────────────────────────────────────────────────────────

const CRON_PRESETS = [
  { label: 'Every 30 min',     cron: '*/30 * * * *', desc: 'Runs at the top and bottom of every hour' },
  { label: 'Every Hour',       cron: '0 * * * *',    desc: 'Runs at the top of every hour' },
  { label: 'Every 2 Hours',    cron: '0 */2 * * *',  desc: 'Runs every 2 hours' },
  { label: 'Every 4 Hours',    cron: '0 */4 * * *',  desc: 'Runs every 4 hours' },
  { label: 'Every 6 Hours',    cron: '0 */6 * * *',  desc: 'Runs every 6 hours' },
  { label: 'Daily at 8 AM',    cron: '0 8 * * *',    desc: 'Once a day at 8:00 AM' },
  { label: 'Daily at 9 AM',    cron: '0 9 * * *',    desc: 'Once a day at 9:00 AM' },
  { label: 'Weekdays at 8 AM', cron: '0 8 * * 1-5',  desc: 'Mon-Fri at 8:00 AM' },
  { label: 'Custom',           cron: null,            desc: 'Type your own cron expression' },
];

const PIPELINE_META = {
  outreach: {
    icon: '🔵',
    color: '#3b82f6',
    stages: ['discovery', 'qualification', 'messages', 'send'],
    stageLabels: { discovery: 'Discovery', qualification: 'Qualification', messages: 'Messages', send: 'Send' },
    limitFields: [
      { key: 'max_leads_per_keyword', label: 'Max leads per keyword', type: 'number', default: 10 },
      { key: 'max_dms_per_run', label: 'Max DMs per run', type: 'number', default: 20 },
      { key: 'max_connections_per_run', label: 'Max connections per run', type: 'number', default: 15 },
    ],
    platformField: true,
  },
  content: {
    icon: '🟠',
    color: '#f59e0b',
    stages: ['image_gen', 'caption_gen', 'post_record', 'publish'],
    stageLabels: { image_gen: 'Image Gen', caption_gen: 'Caption', post_record: 'Post Draft', publish: 'Publish' },
    limitFields: [
      { key: 'topic', label: 'Content Topic', type: 'text', default: '' },
      { key: 'style', label: 'Image Style', type: 'select', options: ['photorealistic', 'illustration', 'minimalist', 'abstract', 'cinematic'], default: 'photorealistic' },
      { key: 'max_posts_per_run', label: 'Posts per run', type: 'number', default: 1 },
    ],
    platformField: true,
  },
  dm_check: {
    icon: '🟢',
    color: '#22c55e',
    stages: ['scan'],
    stageLabels: { scan: 'Inbox Scan' },
    limitFields: [
      { key: 'active_hours_start', label: 'Active start hour', type: 'number', default: 8 },
      { key: 'active_hours_end', label: 'Active end hour', type: 'number', default: 22 },
      { key: 'timezone', label: 'Timezone', type: 'text', default: 'Africa/Nairobi' },
      { key: 'prompt', label: 'Response prompt', type: 'text', default: '' },
    ],
    platformField: true,
  },
};

const ALL_PLATFORMS = ['instagram', 'linkedin', 'x', 'facebook'];

const STATE_META = {
  idle:       { color: '#94a3b8', bg: 'rgba(148,163,184,0.12)', icon: '○', label: 'Idle' },
  scheduled:  { color: '#38bdf8', bg: 'rgba(56,189,248,0.12)',  icon: '◷', label: 'Scheduled' },
  running:    { color: '#38bdf8', bg: 'rgba(56,189,248,0.18)',  icon: '▶', label: 'Running' },
  paused:     { color: '#f59e0b', bg: 'rgba(245,158,11,0.15)',  icon: 'Ⅱ', label: 'Paused' },
  resuming:   { color: '#fbbf24', bg: 'rgba(251,191,36,0.15)',  icon: '↻', label: 'Resuming' },
  stopping:   { color: '#f87171', bg: 'rgba(248,113,113,0.15)', icon: '■', label: 'Stopping' },
  stopped:    { color: '#cbd5e1', bg: 'rgba(148,163,184,0.14)', icon: '■', label: 'Stopped' },
  completed:  { color: '#22c55e', bg: 'rgba(34,197,94,0.15)',   icon: '✓', label: 'Completed' },
  failed:     { color: '#f87171', bg: 'rgba(248,113,113,0.18)', icon: '✗', label: 'Failed' },
  retrying:   { color: '#a78bfa', bg: 'rgba(167,139,250,0.15)', icon: '↻', label: 'Retrying' },
  disabled:   { color: '#64748b', bg: 'rgba(100,116,139,0.14)', icon: '○', label: 'Disabled' },
};

let pipelinesData = [];
let healthData = {};
let activeLogsSub = null;
let expandedPipelines = new Set();

// ── API Helpers ───────────────────────────────────────────────────────────────

async function loadPipelines() {
  try {
    const data = await gtss.fetchJSON('/api/pipelines');
    pipelinesData = data.pipelines || [];
    renderPipelines(pipelinesData);
    renderGlobalHealthStrip();
  } catch (err) {
    gtss.showToast('Failed to load pipelines: ' + err.message, 'error');
  }
}

async function loadHealth() {
  try {
    const data = await gtss.fetchJSON('/api/pipelines/health');
    healthData = {};
    for (const h of (data.pipelines || [])) {
      healthData[h.pipeline_id] = h;
    }
    renderGlobalHealthStrip();
    // Also refresh cards' health sections without a full reload
    refreshHealthSections();
  } catch (err) {
    // Silent — health is supplementary
    console.warn('Failed to load health:', err.message);
  }
}

async function savePipeline(id) {
  const card = document.querySelector(`[data-pipeline-id="${id}"]`);
  if (!card) return;

  const cronInput = card.querySelector('[data-field="cron"]');
  const payload = { cron: cronInput ? cronInput.value : undefined };

  const limits = {};
  card.querySelectorAll('[data-limit-key]').forEach(el => {
    const key = el.dataset.limitKey;
    limits[key] = el.type === 'number' ? Number(el.value) : el.value;
  });

  if (id === 'outreach' || id === 'content' || id === 'dm_check') {
    const checked = [];
    card.querySelectorAll('[data-platform-checkbox]').forEach(cb => {
      if (cb.checked) checked.push(cb.dataset.platformCheckbox);
    });
    limits.platforms = checked;
  }

  payload.limits = limits;

  try {
    const result = await gtss.fetchJSON(`/api/pipelines/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
    if (result.ok) {
      gtss.showToast('Pipeline settings saved', 'success');
      loadPipelines();
    }
  } catch (err) {
    gtss.showToast(err.message, 'error');
  }
}

async function togglePipeline(id, enabled) {
  try {
    const result = await gtss.fetchJSON(`/api/pipelines/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    });
    if (result.ok) {
      gtss.showToast(`Pipeline ${enabled ? 'enabled' : 'disabled'}`, enabled ? 'success' : 'info');
      loadPipelines();
    }
  } catch (err) {
    gtss.showToast(err.message, 'error');
  }
}

async function runNow(id) {
  try {
    const result = await gtss.fetchJSON(`/api/pipelines/${id}/run`, { method: 'POST' });
    gtss.showToast(result.message || 'Pipeline triggered', 'success');
    setTimeout(loadPipelines, 400);
  } catch (err) {
    gtss.showToast(err.message, 'error');
  }
}

async function restartPipeline(id) {
  if (!confirm(`Restart pipeline "${id}"? This will stop the current run (if any) and start a fresh execution from the first step.`)) return;
  try {
    const result = await gtss.fetchJSON(`/api/pipelines/${id}/restart`, { method: 'POST' });
    gtss.showToast(result.message || 'Pipeline restarting', 'success');
    setTimeout(loadPipelines, 400);
  } catch (err) {
    gtss.showToast(err.message, 'error');
  }
}

async function pausePipeline(id, paused) {
  try {
    await gtss.fetchJSON(`/api/pipelines/${id}/${paused ? 'pause' : 'resume'}`, { method: 'POST' });
    gtss.showToast(`Pipeline ${paused ? 'paused' : 'resumed'}`, 'success');
    setTimeout(loadPipelines, 300);
  } catch (err) {
    gtss.showToast(err.message, 'error');
  }
}

async function stopPipeline(id) {
  if (!confirm(`Stop the active execution of pipeline "${id}"? This will gracefully terminate the current run. Checkpoints for completed stages will be preserved.`)) return;
  try {
    const result = await gtss.fetchJSON(`/api/pipelines/${id}/stop`, { method: 'POST' });
    gtss.showToast(`Stop requested (${result.stopped || 0} active job(s))`, 'info');
    setTimeout(loadPipelines, 300);
  } catch (err) {
    gtss.showToast(err.message, 'error');
  }
}

async function retryStage(id, stage, executionId) {
  try {
    const result = await gtss.fetchJSON(`/api/pipelines/${id}/retry-stage`, {
      method: 'POST',
      body: JSON.stringify({ stage, executionId }),
    });
    gtss.showToast(result.message || 'Retrying stage', 'success');
    setTimeout(loadPipelines, 400);
  } catch (err) {
    gtss.showToast(err.message, 'error');
  }
}

async function resumeFromCheckpoint(id, executionId) {
  if (!confirm(`Resume pipeline "${id}" from the last successful checkpoint? Earlier completed stages will be skipped.`)) return;
  try {
    const result = await gtss.fetchJSON(`/api/pipelines/${id}/resume-from-checkpoint`, {
      method: 'POST',
      body: JSON.stringify({ executionId }),
    });
    gtss.showToast(result.message || 'Resuming from checkpoint', 'success');
    setTimeout(loadPipelines, 400);
  } catch (err) {
    gtss.showToast(err.message, 'error');
  }
}

async function loadExecutions(id) {
  try {
    const data = await gtss.fetchJSON(`/api/pipelines/${id}/executions?limit=15`);
    renderExecutionsModal(id, data.executions || []);
  } catch (err) {
    gtss.showToast('Failed to load executions: ' + err.message, 'error');
  }
}

async function loadExecutionDetail(id, eid) {
  try {
    const data = await gtss.fetchJSON(`/api/pipelines/${id}/executions/${eid}?logLimit=200`);
    renderExecutionDetailModal(id, data);
  } catch (err) {
    gtss.showToast('Failed to load execution detail: ' + err.message, 'error');
  }
}

async function loadLogs(id, filters = {}) {
  try {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) {
      if (v !== undefined && v !== null && v !== '') params.append(k, v);
    }
    const data = await gtss.fetchJSON(`/api/pipelines/${id}/logs?${params.toString()}`);
    return data;
  } catch (err) {
    gtss.showToast('Failed to load logs: ' + err.message, 'error');
    return { logs: [], total: 0, counts: {} };
  }
}

async function openLogsModal(id) {
  const root = document.getElementById('pipeline-modal-root');
  root.innerHTML = renderLogsModalShell(id);
  attachLogsModalListeners(id);
  const data = await loadLogs(id, { limit: 200 });
  refreshLogsModal(id, data);
}

// ── Rendering helpers ────────────────────────────────────────────────────────

function formatDate(dateStr) {
  if (!dateStr) return 'Never';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return String(dateStr);
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit',
  });
}

function formatRelative(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '—';
  const diffMs = Date.now() - d.getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function formatDuration(ms) {
  if (ms === null || ms === undefined) return '—';
  const num = Number(ms);
  if (!Number.isFinite(num) || num < 0) return '—';
  if (num < 1000) return `${Math.round(num)}ms`;
  if (num < 60_000) return `${(num / 1000).toFixed(1)}s`;
  if (num < 3_600_000) return `${(num / 60_000).toFixed(1)}m`;
  return `${(num / 3_600_000).toFixed(2)}h`;
}

function formatUptime(ms) {
  if (!ms) return '—';
  return formatDuration(ms);
}

function statusBadge(state) {
  const meta = STATE_META[state] || STATE_META.idle;
  return `<span style="display:inline-flex;align-items:center;gap:5px;padding:4px 11px;border-radius:999px;font-size:11px;font-weight:700;background:${meta.bg};color:${meta.color};border:1px solid ${meta.color}33">${meta.icon} ${meta.label}</span>`;
}

function liveDot(state) {
  const cls = state === 'running' ? '' : state === 'failed' ? 'error' : state === 'paused' ? 'warn' : 'idle';
  return `<span class="live-dot ${cls}"></span>`;
}

function actionStyle(color, enabled = true) {
  const disabled = !enabled;
  return `padding:8px 14px;border-radius:10px;border:1px solid ${disabled ? 'rgba(100,116,139,0.2)' : color.border};
    background:${disabled ? 'rgba(100,116,139,0.08)' : color.bg};color:${disabled ? '#64748b' : color.text};font-size:12px;font-weight:600;
    cursor:${disabled ? 'not-allowed' : 'pointer'};opacity:${disabled ? '0.55' : '1'};transition:all 150ms`;
}

function disabledAttr(enabled) {
  return enabled ? '' : ' disabled aria-disabled="true"';
}

function renderCronPicker(currentCron, pipelineId) {
  const matchedPreset = CRON_PRESETS.find(p => p.cron === currentCron);
  const isCustom = !matchedPreset || matchedPreset.label === 'Custom';

  let html = `<div class="cron-picker" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px">`;
  for (const preset of CRON_PRESETS) {
    const active = (preset.cron === currentCron) || (preset.label === 'Custom' && isCustom);
    html += `<button type="button" class="cron-preset-btn${active ? ' active' : ''}"
      data-cron-preset="${preset.cron || 'custom'}"
      data-pipeline-target="${pipelineId}"
      title="${preset.desc}"
    >${preset.label}</button>`;
  }
  html += `</div>`;

  html += `<div style="display:flex;align-items:center;gap:8px">
    <code style="color:#94a3b8;font-size:13px">Cron:</code>
    <input type="text" data-field="cron" value="${gtss.escapeHtml(currentCron || '')}"
      style="flex:1;padding:8px 12px;border-radius:8px;border:1px solid rgba(148,163,184,0.22);
      background:rgba(15,23,42,0.6);color:#e2e8f0;font-family:monospace;font-size:14px"
      placeholder="0 8 * * *"
    />
  </div>`;

  return html;
}

function renderLimitFields(meta, limits) {
  let html = '';
  for (const field of meta.limitFields) {
    const val = limits[field.key] !== undefined ? limits[field.key] : field.default;
    if (field.type === 'number') {
      html += `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:6px 0">
        <label style="color:#94a3b8;font-size:13px;white-space:nowrap">${field.label}</label>
        <input type="number" data-limit-key="${field.key}" value="${val}" min="1" max="100"
          style="width:80px;padding:6px 10px;border-radius:8px;border:1px solid rgba(148,163,184,0.22);
          background:rgba(15,23,42,0.6);color:#e2e8f0;font-size:14px;text-align:center"
        />
      </div>`;
    } else if (field.type === 'text') {
      html += `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:6px 0">
        <label style="color:#94a3b8;font-size:13px;white-space:nowrap">${field.label}</label>
        <input type="text" data-limit-key="${field.key}" value="${gtss.escapeHtml(val || '')}"
          style="flex:1;max-width:320px;padding:6px 10px;border-radius:8px;border:1px solid rgba(148,163,184,0.22);
          background:rgba(15,23,42,0.6);color:#e2e8f0;font-size:14px"
          placeholder="e.g. business growth in Africa"
        />
      </div>`;
    } else if (field.type === 'select') {
      html += `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:6px 0">
        <label style="color:#94a3b8;font-size:13px;white-space:nowrap">${field.label}</label>
        <select data-limit-key="${field.key}"
          style="padding:6px 10px;border-radius:8px;border:1px solid rgba(148,163,184,0.22);
          background:rgba(15,23,42,0.6);color:#e2e8f0;font-size:14px">
          ${(field.options || []).map(o =>
            `<option value="${o}"${o === val ? ' selected' : ''}>${o}</option>`
          ).join('')}
        </select>
      </div>`;
    }
  }
  return html;
}

function renderPlatformCheckboxes(selectedPlatforms, pipelineId) {
  const fallback =
    pipelineId === 'outreach'
      ? ['linkedin', 'x']
      : pipelineId === 'dm_check'
        ? ALL_PLATFORMS
        : ['instagram', 'linkedin'];
  const selected = Array.isArray(selectedPlatforms) ? selectedPlatforms : fallback;
  return `<div style="display:flex;flex-wrap:wrap;gap:10px;padding:6px 0">
    <label style="color:#94a3b8;font-size:13px;white-space:nowrap;width:100%">Target Platforms</label>
    ${ALL_PLATFORMS.map(p => `
      <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;
        padding:6px 12px;border-radius:8px;border:1px solid rgba(148,163,184,0.18);
        background:${selected.includes(p) ? 'rgba(14,165,233,0.12)' : 'transparent'};
        color:#e2e8f0;font-size:13px;font-weight:500">
        <input type="checkbox" data-platform-checkbox="${p}"
          ${selected.includes(p) ? 'checked' : ''}
          style="accent-color:#0ea5e9" />
        ${gtss.formatPlatformLabel(p)}
      </label>
    `).join('')}
  </div>`;
}

function renderStageProgress(meta, pipeline) {
  const stages = meta.stages || [];
  const activeStage = pipeline.current_stage;
  const failedStage = pipeline.failed_stage || (healthData[pipeline.id]?.last_error ? null : null);
  const checkpoints = pipeline.checkpoints || [];

  // Build a quick lookup: stage → checkpoint status
  const cpStatus = {};
  for (const cp of checkpoints) cpStatus[cp.stage] = cp.status;

  return `<div style="display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 4px">
    ${stages.map(stage => {
      const isFailed = stage === failedStage;
      const isActive = stage === activeStage && !isFailed;
      const status = cpStatus[stage];
      const isDone = status === 'completed' || (pipeline.state === 'completed' && !isFailed);
      const cls = isFailed ? 'failed' : isActive ? 'active' : isDone ? 'done' : 'skipped';
      const label = meta.stageLabels?.[stage] || stage;
      return `<span class="stage-pill ${cls}" title="${stage}">${label}</span>`;
    }).join('')}
  </div>`;
}

function renderHealthSection(pipeline) {
  const h = healthData[pipeline.id];
  if (!h) {
    return `<div style="font-size:12px;color:#64748b;padding:8px 0">Loading health metrics…</div>`;
  }
  const successRate = Math.round((h.success_rate_24h || 0) * 100);
  const failureRate = Math.round((h.failure_rate_24h || 0) * 100);
  const healthyBadge = h.healthy
    ? `<span class="stage-pill done">● Healthy</span>`
    : `<span class="stage-pill failed">● Unhealthy</span>`;

  return `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin:8px 0">
      <div class="metric-card">
        <div class="metric-label">Last Run</div>
        <div class="metric-value" style="font-size:13px">${formatRelative(h.last_run_at)}</div>
        <div class="metric-sub">${formatDate(h.last_run_at)}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Next Run</div>
        <div class="metric-value" style="font-size:13px">${h.enabled ? formatRelative(h.next_run_at) : 'Disabled'}</div>
        <div class="metric-sub">${h.enabled ? formatDate(h.next_run_at) : '—'}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Success Rate (24h)</div>
        <div class="metric-value" style="color:${successRate >= 80 ? '#22c55e' : successRate >= 50 ? '#f59e0b' : '#f87171'}">${successRate}%</div>
        <div class="metric-sub">${h.executions_completed_24h || 0}/${h.executions_24h || 0} runs</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Failure Rate (24h)</div>
        <div class="metric-value" style="color:${failureRate <= 10 ? '#22c55e' : failureRate <= 30 ? '#f59e0b' : '#f87171'}">${failureRate}%</div>
        <div class="metric-sub">${h.executions_failed_24h || 0} failed</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Avg Duration</div>
        <div class="metric-value">${formatDuration(h.avg_duration_ms_24h || h.avg_duration_ms)}</div>
        <div class="metric-sub">All-time: ${formatDuration(h.avg_duration_ms)}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Consecutive Failures</div>
        <div class="metric-value" style="color:${(h.consecutive_failures || 0) === 0 ? '#22c55e' : (h.consecutive_failures || 0) >= 3 ? '#f87171' : '#f59e0b'}">${h.consecutive_failures || 0}</div>
        <div class="metric-sub">Retries: ${h.total_retries || 0}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Total Runs</div>
        <div class="metric-value">${h.total_runs || 0}</div>
        <div class="metric-sub">Failures: ${h.total_failures || 0}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Uptime</div>
        <div class="metric-value" style="font-size:14px">${formatUptime(h.uptime_ms)}</div>
        <div class="metric-sub">since last success</div>
      </div>
    </div>
    <div style="display:flex;align-items:center;gap:8px;margin-top:6px;font-size:12px;color:#94a3b8">
      ${healthyBadge}
      ${h.last_error ? `<span style="color:#f87171" title="${gtss.escapeHtml(h.last_error)}">⚠ Last error: ${gtss.escapeHtml(h.last_error.slice(0, 80))}${h.last_error.length > 80 ? '…' : ''}</span>` : ''}
    </div>
  `;
}

function renderProgressSection(pipeline) {
  const progress = pipeline.progress || 0;
  const state = pipeline.state || 'idle';
  let fillClass = '';
  if (state === 'failed') fillClass = 'error';
  else if (state === 'paused') fillClass = 'warn';
  else if (state === 'completed') fillClass = 'success';

  const currentText = pipeline.current_message || pipeline.current_stage || (state === 'running' ? 'Starting…' : state === 'paused' ? 'Paused — click Resume to continue' : state === 'failed' ? 'Failed — see logs for details' : 'No active run right now.');

  return `
    <div style="padding:12px 14px;border-radius:12px;background:rgba(15,23,42,0.45);border:1px solid rgba(148,163,184,0.12);margin-bottom:12px">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px">
        <div style="display:flex;align-items:center;gap:8px;min-width:0">
          ${liveDot(state)}
          <span style="color:#f8fafc;font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${gtss.escapeHtml(currentText)}</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
          ${pipeline.active_execution_id ? `<span style="font-size:11px;color:#64748b;font-family:monospace">exec ${String(pipeline.active_execution_id).slice(0,8)}</span>` : ''}
          <span style="font-size:12px;font-weight:700;color:${STATE_META[state]?.color || '#94a3b8'}">${progress}%</span>
        </div>
      </div>
      <div class="progress-track">
        <div class="progress-fill ${fillClass}" style="width:${progress}%"></div>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:11px;color:#64748b;margin-top:6px">
        <span>Step ${(pipeline.completed_steps || 0) + (state === 'running' ? 1 : 0)} of ${pipeline.total_steps || '?'}</span>
        <span>${pipeline.active_job_count || 0} active job(s)</span>
      </div>
    </div>
  `;
}

function renderPipelineCard(pipeline) {
  const meta = PIPELINE_META[pipeline.id] || {};
  const limits = pipeline.limits || {};
  const enabled = Boolean(pipeline.enabled);
  const displayStatus = pipeline.state || (pipeline.paused ? 'paused' : pipeline.last_status) || (enabled ? 'idle' : 'disabled');
  const activeJobs = Array.isArray(pipeline.active_jobs) ? pipeline.active_jobs : [];
  const needsTopic = pipeline.id === 'content' && (!limits.topic || !limits.topic.trim());
  const canRun = pipeline.can_run !== undefined ? pipeline.can_run : displayStatus !== 'running' && !pipeline.paused;
  const canPause = pipeline.can_pause !== undefined ? pipeline.can_pause : enabled && !pipeline.paused;
  const canResume = pipeline.can_resume !== undefined ? pipeline.can_resume : Boolean(pipeline.paused);
  const canStop = pipeline.can_stop !== undefined ? pipeline.can_stop : displayStatus === 'running';
  const pauseAction = pipeline.paused ? 'resume' : 'pause';
  const pauseEnabled = pipeline.paused ? canResume : canPause;
  const isExpanded = expandedPipelines.has(pipeline.id);
  const hasFailedStage = pipeline.state === 'failed';

  return `
  <article class="pipeline-card glass-panel animate-card" data-pipeline-id="${pipeline.id}"
    style="border-radius:24px;padding:24px 28px;border-left:4px solid ${meta.color || '#94a3b8'}">

    <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:18px;flex-wrap:wrap">
      <div style="display:flex;align-items:center;gap:12px;min-width:0">
        <span style="font-size:26px">${meta.icon || '◉'}</span>
        <div style="min-width:0">
          <h2 style="margin:0;font-size:19px;font-weight:700;color:#f8fafc">${gtss.escapeHtml(pipeline.name)}</h2>
          <p style="margin:3px 0 0;font-size:12px;color:#94a3b8">${meta.stages?.map(s => meta.stageLabels?.[s] || s).join(' → ') || ''}</p>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:10px">
        ${statusBadge(displayStatus)}
        <label class="pipeline-toggle" style="position:relative;display:inline-block;width:48px;height:26px;cursor:pointer" title="${enabled ? 'Disable pipeline' : 'Enable pipeline'}">
          <input type="checkbox" class="pipeline-toggle-input" data-toggle-pipeline="${pipeline.id}"
            ${enabled ? 'checked' : ''}
            style="opacity:0;width:0;height:0" />
          <span class="pipeline-toggle-slider" style="
            position:absolute;inset:0;border-radius:999px;transition:all 200ms;
            background:${enabled ? '#22c55e' : 'rgba(148,163,184,0.3)'};
            box-shadow:${enabled ? '0 0 12px rgba(34,197,94,0.3)' : 'none'}
          ">
            <span style="
              position:absolute;top:3px;${enabled ? 'right:3px' : 'left:3px'};
              width:20px;height:20px;border-radius:999px;background:#fff;
              transition:all 200ms;box-shadow:0 2px 6px rgba(0,0,0,0.2)
            "></span>
          </span>
        </label>
      </div>
    </div>

    ${needsTopic ? `
      <div style="padding:10px 14px;border-radius:10px;background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.25);
        margin-bottom:12px;display:flex;align-items:center;gap:8px;font-size:13px;color:#fbbf24">
        ⚠ Set a content topic before enabling this pipeline.
      </div>
    ` : ''}

    ${renderProgressSection(pipeline)}

    ${renderStageProgress(meta, pipeline)}

    ${hasFailedStage ? `
      <div style="padding:10px 14px;border-radius:10px;background:rgba(248,113,113,0.08);border:1px solid rgba(248,113,113,0.3);
        margin:10px 0;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
        <div style="display:flex;align-items:center;gap:8px;font-size:12px;color:#fca5a5">
          <span>✗ Last execution failed${pipeline.failed_stage ? ` at stage "${pipeline.failed_stage}"` : ''}.</span>
        </div>
        <div style="display:flex;gap:6px">
          <button type="button" class="pipeline-action-btn" data-action="retry-stage" data-pipeline="${pipeline.id}" data-stage="${pipeline.failed_stage || ''}"
            style="${actionStyle({ border: 'rgba(167,139,250,0.3)', bg: 'rgba(167,139,250,0.1)', text: '#a78bfa' }, true)}" title="Retry the failed stage">
            ↻ Retry Failed Step
          </button>
          <button type="button" class="pipeline-action-btn" data-action="resume-checkpoint" data-pipeline="${pipeline.id}"
            style="${actionStyle({ border: 'rgba(34,197,94,0.3)', bg: 'rgba(34,197,94,0.1)', text: '#4ade80' }, true)}" title="Resume from the last successful checkpoint">
            ⏵ Resume from Checkpoint
          </button>
        </div>
      </div>
    ` : ''}

    <details class="pipeline-section" ${isExpanded ? 'open' : ''} data-pipeline-section="${pipeline.id}" style="margin-top:8px">
      <summary style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;cursor:pointer">
        <span style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:#cbd5e1">
          <span class="chevron" style="color:#64748b">▸</span>
          Pipeline Health & Metrics
        </span>
        <span style="font-size:11px;color:#64748b">click to ${isExpanded ? 'collapse' : 'expand'}</span>
      </summary>
      <div data-health-section="${pipeline.id}" style="padding-top:4px">
        ${renderHealthSection(pipeline)}
      </div>
    </details>

    <details class="pipeline-section" data-pipeline-section="${pipeline.id}-config" style="margin-top:8px">
      <summary style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;cursor:pointer">
        <span style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:#cbd5e1">
          <span class="chevron" style="color:#64748b">▸</span>
          Schedule & Configuration
        </span>
        <span style="font-size:11px;color:#64748b">click to expand</span>
      </summary>
      <div style="padding-top:8px">
        <div style="display:grid;gap:4px;margin-bottom:14px">
          ${renderCronPicker(pipeline.cron, pipeline.id)}
        </div>
        <div style="border-top:1px solid rgba(148,163,184,0.12);padding-top:14px">
          <p style="margin:0 0 10px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#64748b">
            ${pipeline.id === 'content' ? 'Content Settings' : 'Limits'}
          </p>
          ${renderLimitFields(meta, limits)}
          ${meta.platformField ? renderPlatformCheckboxes(limits.platforms, pipeline.id) : ''}
        </div>
      </div>
    </details>

    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;
      border-top:1px solid rgba(148,163,184,0.12);padding-top:14px;margin-top:14px">
      <div style="font-size:11px;color:#64748b;display:flex;gap:14px;flex-wrap:wrap">
        <span>Last run: <strong style="color:#94a3b8">${formatRelative(pipeline.last_run_at)}</strong></span>
        <span>Next: <strong style="color:#94a3b8">${pipeline.enabled ? formatRelative(pipeline.next_run_at) : 'Disabled'}</strong></span>
        <span>Runs: <strong style="color:#94a3b8">${pipeline.run_count || 0}</strong></span>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button type="button" class="pipeline-action-btn" data-action="run" data-pipeline="${pipeline.id}"
          style="${actionStyle({ border: 'rgba(34,197,94,0.3)', bg: 'rgba(34,197,94,0.1)', text: '#22c55e' }, canRun)}" title="${canRun ? 'Run this pipeline now' : 'Cannot run while paused or already running'}"${disabledAttr(canRun)}>
          ▶ Run Now
        </button>
        <button type="button" class="pipeline-action-btn" data-action="restart" data-pipeline="${pipeline.id}"
          style="${actionStyle({ border: 'rgba(56,189,248,0.3)', bg: 'rgba(56,189,248,0.1)', text: '#38bdf8' }, true)}" title="Stop current run (if any) and start fresh">
          ↻ Restart
        </button>
        <button type="button" class="pipeline-action-btn" data-action="${pauseAction}" data-pipeline="${pipeline.id}"
          style="${actionStyle({ border: 'rgba(245,158,11,0.3)', bg: 'rgba(245,158,11,0.1)', text: '#fbbf24' }, pauseEnabled)}" title="${pauseEnabled ? (pipeline.paused ? 'Resume this pipeline' : 'Pause this pipeline') : 'Pause is only available for enabled pipelines'}"${disabledAttr(pauseEnabled)}>
          ${pipeline.paused ? '▶ Resume' : 'Ⅱ Pause'}
        </button>
        <button type="button" class="pipeline-action-btn" data-action="stop" data-pipeline="${pipeline.id}"
          style="${actionStyle({ border: 'rgba(248,113,113,0.3)', bg: 'rgba(248,113,113,0.1)', text: '#f87171' }, canStop)}" title="${canStop ? 'Stop the active run' : 'No active run to stop'}"${disabledAttr(canStop)}>
          ■ Stop
        </button>
        <button type="button" class="pipeline-action-btn" data-action="executions" data-pipeline="${pipeline.id}"
          style="padding:8px 14px;border-radius:10px;border:1px solid rgba(148,163,184,0.2);
          background:rgba(148,163,184,0.06);color:#94a3b8;font-size:12px;font-weight:600;cursor:pointer;
          transition:all 150ms" title="View execution history">
          📋 History
        </button>
        <button type="button" class="pipeline-action-btn" data-action="logs" data-pipeline="${pipeline.id}"
          style="padding:8px 14px;border-radius:10px;border:1px solid rgba(148,163,184,0.2);
          background:rgba(148,163,184,0.06);color:#94a3b8;font-size:12px;font-weight:600;cursor:pointer;
          transition:all 150ms" title="View structured logs">
          📜 Logs
        </button>
        <button type="button" class="pipeline-action-btn" data-action="save" data-pipeline="${pipeline.id}"
          style="padding:8px 14px;border-radius:10px;border:1px solid rgba(14,165,233,0.3);
          background:rgba(14,165,233,0.1);color:#38bdf8;font-size:12px;font-weight:600;cursor:pointer;
          transition:all 150ms" title="Save changes">
          💾 Save
        </button>
      </div>
    </div>
  </article>`;
}

function renderPipelines(pipelines) {
  const container = document.getElementById('pipelines-container');
  if (!container) return;

  if (!pipelines || pipelines.length === 0) {
    container.innerHTML = gtss.renderEmptyState(null, 'No pipelines configured.');
    return;
  }

  container.innerHTML = pipelines.map(renderPipelineCard).join('');
  attachCardListeners();
}

function refreshHealthSections() {
  for (const p of pipelinesData) {
    const el = document.querySelector(`[data-health-section="${p.id}"]`);
    if (el) {
      el.innerHTML = renderHealthSection(p);
    }
  }
}

function renderGlobalHealthStrip() {
  const strip = document.getElementById('global-health-strip');
  if (!strip) return;
  if (pipelinesData.length === 0) {
    strip.innerHTML = '';
    return;
  }
  strip.innerHTML = pipelinesData.map(p => {
    const h = healthData[p.id];
    const state = p.state || (p.paused ? 'paused' : 'idle');
    const meta = STATE_META[state] || STATE_META.idle;
    const sr = h ? Math.round((h.success_rate_24h || 0) * 100) + '%' : '—';
    return `<span style="display:inline-flex;align-items:center;gap:6px;padding:5px 11px;border-radius:999px;
      background:${meta.bg};color:${meta.color};border:1px solid ${meta.color}33;font-weight:600">
      ${liveDot(state)} ${p.name}: ${meta.label} · 24h success ${sr}
    </span>`;
  }).join('');
}

function attachCardListeners() {
  document.querySelectorAll('[data-toggle-pipeline]').forEach(input => {
    input.addEventListener('change', (e) => {
      togglePipeline(e.target.dataset.togglePipeline, e.target.checked);
    });
  });

  document.querySelectorAll('.pipeline-action-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      if (btn.disabled) return;
      const action = btn.dataset.action;
      const id = btn.dataset.pipeline;
      const stage = btn.dataset.stage;
      if (action === 'run') runNow(id);
      else if (action === 'restart') restartPipeline(id);
      else if (action === 'executions') loadExecutions(id);
      else if (action === 'logs') openLogsModal(id);
      else if (action === 'pause') pausePipeline(id, true);
      else if (action === 'resume') pausePipeline(id, false);
      else if (action === 'stop') stopPipeline(id);
      else if (action === 'retry-stage') retryStage(id, stage || null, null);
      else if (action === 'resume-checkpoint') resumeFromCheckpoint(id, null);
      else if (action === 'save') savePipeline(id);
    });
  });

  document.querySelectorAll('.cron-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const preset = btn.dataset.cronPreset;
      const targetId = btn.dataset.pipelineTarget;
      const card = document.querySelector(`[data-pipeline-id="${targetId}"]`);
      if (!card) return;

      const cronInput = card.querySelector('[data-field="cron"]');
      if (preset !== 'custom' && cronInput) {
        cronInput.value = preset;
      }

      card.querySelectorAll('.cron-preset-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      if (preset === 'custom' && cronInput) {
        cronInput.focus();
        cronInput.select();
      }
    });
  });

  document.querySelectorAll('.pipeline-section > summary').forEach(summary => {
    summary.addEventListener('click', (e) => {
      // Track expansion state for the health section
      const details = summary.parentElement;
      const sectionId = details.dataset.pipelineSection;
      if (sectionId && !sectionId.endsWith('-config')) {
        const pipelineId = sectionId;
        if (details.open) expandedPipelines.delete(pipelineId);
        else expandedPipelines.add(pipelineId);
      }
    });
  });

  document.querySelectorAll('.pipeline-action-btn').forEach(btn => {
    btn.addEventListener('mouseenter', () => { btn.style.transform = 'translateY(-1px)'; btn.style.opacity = '0.9'; });
    btn.addEventListener('mouseleave', () => { btn.style.transform = 'translateY(0)'; btn.style.opacity = '1'; });
  });
}

// ── Executions Modal ────────────────────────────────────────────────────────

function renderExecutionsModal(pipelineId, executions) {
  const root = document.getElementById('pipeline-modal-root');
  const pipeline = pipelinesData.find(p => p.id === pipelineId) || { name: pipelineId };

  const rowsHtml = executions.length === 0
    ? `<div style="padding:32px;text-align:center;color:#64748b">No executions recorded yet. Click "Run Now" to start the first one.</div>`
    : executions.map(exec => {
        const meta = STATE_META[exec.status] || STATE_META.idle;
        return `
          <div style="display:grid;grid-template-columns:auto 1fr auto;gap:12px;padding:12px;border-bottom:1px solid rgba(148,163,184,0.1);cursor:pointer"
            data-exec-row="${exec.id}" data-pipeline="${pipelineId}">
            <div style="font-family:monospace;font-size:12px;color:#64748b">${String(exec.id).slice(0,8)}</div>
            <div style="min-width:0">
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
                ${statusBadge(exec.status)}
                <span style="font-size:11px;color:#64748b">trigger: ${exec.trigger}</span>
                ${exec.retry_count > 0 ? `<span class="stage-pill failed">↻ ${exec.retry_count} retries</span>` : ''}
              </div>
              <div style="font-size:12px;color:#94a3b8">
                ${exec.current_stage ? `<strong>Stage:</strong> ${exec.current_stage} · ` : ''}
                Started ${formatRelative(exec.started_at)} · Duration ${formatDuration(exec.duration_ms)}
              </div>
              ${exec.error_message ? `<div style="font-size:11px;color:#f87171;margin-top:4px;word-break:break-word">${gtss.escapeHtml(exec.error_message.slice(0, 200))}${exec.error_message.length > 200 ? '…' : ''}</div>` : ''}
            </div>
            <div style="font-size:11px;color:#64748b;text-align:right">
              ${exec.progress || 0}%
            </div>
          </div>
        `;
      }).join('');

  root.innerHTML = `
    <div id="pipeline-modal" style="position:fixed;inset:0;z-index:3000;display:grid;place-items:center;padding:20px;background:rgba(2,6,23,0.78);animation:fadeIn 200ms ease">
      <div style="width:min(900px,100%);max-height:85vh;display:flex;flex-direction:column;border-radius:20px;
        background:linear-gradient(180deg,rgba(15,23,42,0.98),rgba(15,23,42,0.92));
        border:1px solid rgba(148,163,184,0.2);box-shadow:0 24px 80px rgba(0,0,0,0.4)">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:18px 24px;border-bottom:1px solid rgba(148,163,184,0.12)">
          <div>
            <h3 style="margin:0;font-size:17px;font-weight:700;color:#f8fafc">${gtss.escapeHtml(pipeline.name)} — Execution History</h3>
            <p style="margin:4px 0 0;font-size:12px;color:#94a3b8">Click any execution to view full detail, checkpoints, and logs.</p>
          </div>
          <button id="close-modal" type="button" style="width:32px;height:32px;border-radius:999px;
            border:1px solid rgba(148,163,184,0.2);background:rgba(148,163,184,0.06);
            color:#94a3b8;cursor:pointer;font-size:16px;display:grid;place-items:center">✕</button>
        </div>
        <div class="scroll-y" style="flex:1;overflow-y:auto">${rowsHtml}</div>
      </div>
    </div>
  `;

  const overlay = document.getElementById('pipeline-modal');
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.id === 'close-modal') {
      overlay.remove();
    }
  });
  overlay.querySelectorAll('[data-exec-row]').forEach(row => {
    row.addEventListener('click', () => {
      const eid = row.dataset.execRow;
      const pid = row.dataset.pipeline;
      loadExecutionDetail(pid, eid);
    });
  });
}

function renderExecutionDetailModal(pipelineId, data) {
  const root = document.getElementById('pipeline-modal-root');
  const { execution, checkpoints, logs } = data;

  const cpStatus = {};
  for (const cp of checkpoints) cpStatus[cp.stage] = cp.status;

  const meta = PIPELINE_META[pipelineId] || { stages: [] };

  const logsHtml = (logs || []).slice().reverse().map(log => renderLogRow(log)).join('');

  const checkpointsHtml = checkpoints.length === 0
    ? `<div style="padding:16px;color:#64748b;font-size:12px">No checkpoints recorded.</div>`
    : checkpoints.map(cp => `
        <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-radius:8px;background:rgba(15,23,42,0.4);margin-bottom:4px">
          <div style="display:flex;align-items:center;gap:8px">
            <span class="stage-pill ${cp.status === 'completed' ? 'done' : cp.status === 'failed' ? 'failed' : 'skipped'}">${cp.status}</span>
            <strong style="font-size:13px;color:#e2e8f0">${cp.stage}</strong>
            ${cp.attempt > 1 ? `<span style="font-size:11px;color:#a78bfa">attempt ${cp.attempt}</span>` : ''}
          </div>
          <div style="font-size:11px;color:#64748b">
            ${formatRelative(cp.created_at)}${cp.duration_ms ? ` · ${formatDuration(cp.duration_ms)}` : ''}
            ${cp.error_message ? ` · <span style="color:#f87171">${gtss.escapeHtml(cp.error_message.slice(0, 60))}${cp.error_message.length > 60 ? '…' : ''}</span>` : ''}
          </div>
        </div>
      `).join('');

  root.innerHTML = `
    <div id="pipeline-modal" style="position:fixed;inset:0;z-index:3000;display:grid;place-items:center;padding:20px;background:rgba(2,6,23,0.78);animation:fadeIn 200ms ease">
      <div style="width:min(1000px,100%);max-height:88vh;display:flex;flex-direction:column;border-radius:20px;
        background:linear-gradient(180deg,rgba(15,23,42,0.98),rgba(15,23,42,0.92));
        border:1px solid rgba(148,163,184,0.2);box-shadow:0 24px 80px rgba(0,0,0,0.4)">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:18px 24px;border-bottom:1px solid rgba(148,163,184,0.12)">
          <div style="min-width:0">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px">
              ${statusBadge(execution.status)}
              <span style="font-family:monospace;font-size:11px;color:#64748b">${execution.id}</span>
              <span style="font-size:11px;color:#64748b">trigger: ${execution.trigger}</span>
            </div>
            <h3 style="margin:0;font-size:17px;font-weight:700;color:#f8fafc">Execution Detail</h3>
          </div>
          <button id="close-modal" type="button" style="width:32px;height:32px;border-radius:999px;
            border:1px solid rgba(148,163,184,0.2);background:rgba(148,163,184,0.06);
            color:#94a3b8;cursor:pointer;font-size:16px;display:grid;place-items:center">✕</button>
        </div>

        <div class="scroll-y" style="flex:1;overflow-y:auto;padding:20px 24px;display:flex;flex-direction:column;gap:18px">

          <div>
            <h4 style="margin:0 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:0.1em;color:#64748b">Summary</h4>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px">
              <div class="metric-card"><div class="metric-label">Started</div><div class="metric-value" style="font-size:12px">${formatDate(execution.started_at)}</div></div>
              <div class="metric-card"><div class="metric-label">Finished</div><div class="metric-value" style="font-size:12px">${execution.finished_at ? formatDate(execution.finished_at) : '—'}</div></div>
              <div class="metric-card"><div class="metric-label">Duration</div><div class="metric-value">${formatDuration(execution.duration_ms)}</div></div>
              <div class="metric-card"><div class="metric-label">Progress</div><div class="metric-value">${execution.progress || 0}%</div><div class="metric-sub">${execution.completed_steps || 0}/${execution.total_steps || 0} steps</div></div>
              <div class="metric-card"><div class="metric-label">Retries</div><div class="metric-value">${execution.retry_count || 0}</div><div class="metric-sub">max ${execution.max_retries || 3}</div></div>
              <div class="metric-card"><div class="metric-label">Current Stage</div><div class="metric-value" style="font-size:13px">${execution.current_stage || '—'}</div></div>
            </div>
            ${execution.current_message ? `<div style="margin-top:8px;padding:8px 10px;border-radius:8px;background:rgba(15,23,42,0.5);font-size:12px;color:#cbd5e1"><strong>Last message:</strong> ${gtss.escapeHtml(execution.current_message)}</div>` : ''}
          </div>

          ${execution.error_message ? `
            <div>
              <h4 style="margin:0 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:0.1em;color:#f87171">Error</h4>
              <div style="padding:12px;border-radius:8px;background:rgba(248,113,113,0.06);border:1px solid rgba(248,113,113,0.3);font-family:monospace;font-size:12px;color:#fca5a5;white-space:pre-wrap;word-break:break-word">${gtss.escapeHtml(execution.error_message)}</div>
              ${execution.stack_trace ? `<details style="margin-top:6px"><summary style="cursor:pointer;font-size:11px;color:#64748b">Stack trace</summary><pre style="padding:10px;border-radius:6px;background:rgba(15,23,42,0.6);font-size:11px;color:#94a3b8;overflow-x:auto;max-height:300px">${gtss.escapeHtml(execution.stack_trace)}</pre></details>` : ''}
              ${execution.failed_stage ? `
                <div style="display:flex;gap:8px;margin-top:10px">
                  <button type="button" class="pipeline-action-btn" data-action="retry-stage-detail" data-pipeline="${pipelineId}" data-exec="${execution.id}" data-stage="${execution.failed_stage}"
                    style="${actionStyle({ border: 'rgba(167,139,250,0.3)', bg: 'rgba(167,139,250,0.1)', text: '#a78bfa' }, true)}">↻ Retry Failed Step (${execution.failed_stage})</button>
                  <button type="button" class="pipeline-action-btn" data-action="resume-checkpoint-detail" data-pipeline="${pipelineId}" data-exec="${execution.id}"
                    style="${actionStyle({ border: 'rgba(34,197,94,0.3)', bg: 'rgba(34,197,94,0.1)', text: '#4ade80' }, true)}">⏵ Resume from Checkpoint</button>
                </div>
              ` : ''}
            </div>
          ` : ''}

          <div>
            <h4 style="margin:0 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:0.1em;color:#64748b">Checkpoints (${checkpoints.length})</h4>
            ${checkpointsHtml}
          </div>

          <div>
            <h4 style="margin:0 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:0.1em;color:#64748b">Logs (${logs.length})</h4>
            <div style="max-height:400px;overflow-y:auto;padding:4px;background:rgba(2,6,23,0.4);border-radius:8px;border:1px solid rgba(148,163,184,0.1)">
              ${logsHtml || '<div style="padding:12px;color:#64748b;font-size:12px">No logs recorded.</div>'}
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  const overlay = document.getElementById('pipeline-modal');
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.id === 'close-modal') {
      overlay.remove();
    }
  });
  overlay.querySelectorAll('[data-action="retry-stage-detail"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const pid = btn.dataset.pipeline;
      const eid = btn.dataset.exec;
      const stage = btn.dataset.stage;
      retryStage(pid, stage, eid);
      overlay.remove();
    });
  });
  overlay.querySelectorAll('[data-action="resume-checkpoint-detail"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const pid = btn.dataset.pipeline;
      const eid = btn.dataset.exec;
      resumeFromCheckpoint(pid, eid);
      overlay.remove();
    });
  });
}

// ── Logs Modal ──────────────────────────────────────────────────────────────

function renderLogsModalShell(pipelineId) {
  const pipeline = pipelinesData.find(p => p.id === pipelineId) || { name: pipelineId };
  return `
    <div id="pipeline-modal" style="position:fixed;inset:0;z-index:3000;display:grid;place-items:center;padding:20px;background:rgba(2,6,23,0.78);animation:fadeIn 200ms ease">
      <div style="width:min(1100px,100%);max-height:88vh;display:flex;flex-direction:column;border-radius:20px;
        background:linear-gradient(180deg,rgba(15,23,42,0.98),rgba(15,23,42,0.92));
        border:1px solid rgba(148,163,184,0.2);box-shadow:0 24px 80px rgba(0,0,0,0.4)">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:18px 24px;border-bottom:1px solid rgba(148,163,184,0.12)">
          <div>
            <h3 style="margin:0;font-size:17px;font-weight:700;color:#f8fafc">📜 ${gtss.escapeHtml(pipeline.name)} — Logs</h3>
            <p style="margin:4px 0 0;font-size:12px;color:#94a3b8">Searchable, filterable structured logs.</p>
          </div>
          <button id="close-modal" type="button" style="width:32px;height:32px;border-radius:999px;
            border:1px solid rgba(148,163,184,0.2);background:rgba(148,163,184,0.06);
            color:#94a3b8;cursor:pointer;font-size:16px;display:grid;place-items:center">✕</button>
        </div>

        <div style="padding:14px 24px;border-bottom:1px solid rgba(148,163,184,0.1);display:flex;flex-wrap:wrap;gap:8px;align-items:center">
          <input id="logs-search" type="text" placeholder="Search messages…" class="filter-input" style="flex:1;min-width:200px" />
          <select id="logs-level" class="filter-input">
            <option value="">All levels</option>
            <option value="info">Info</option>
            <option value="success">Success</option>
            <option value="warn">Warn</option>
            <option value="error">Error</option>
            <option value="retry">Retry</option>
            <option value="debug">Debug</option>
          </select>
          <select id="logs-stage" class="filter-input">
            <option value="">All stages</option>
          </select>
          <label style="display:flex;align-items:center;gap:5px;font-size:12px;color:#94a3b8;cursor:pointer">
            <input id="logs-live" type="checkbox" style="accent-color:#0ea5e9" /> Live tail
          </label>
          <button id="logs-refresh" type="button" class="filter-input" style="cursor:pointer">Refresh</button>
        </div>

        <div id="logs-counts" style="padding:8px 24px;border-bottom:1px solid rgba(148,163,184,0.1);font-size:11px;color:#94a3b8;display:flex;gap:14px;flex-wrap:wrap"></div>

        <div id="logs-list" class="scroll-y" style="flex:1;overflow-y:auto;padding:12px 24px;background:rgba(2,6,23,0.4)">
          <div style="padding:24px;text-align:center;color:#64748b">Loading logs…</div>
        </div>
      </div>
    </div>
  `;
}

function renderLogRow(log) {
  const time = new Date(log.created_at).toLocaleTimeString('en-US', { hour12: false });
  const meta = `[${time}]${log.stage ? ` [${log.stage}]` : ''}${log.retry_attempt ? ` (retry ${log.retry_attempt})` : ''}`;
  const stack = log.stack_trace ? `<details style="margin-top:4px"><summary style="cursor:pointer;font-size:10px;color:#64748b">Stack trace</summary><pre style="margin:4px 0 0;font-size:11px;color:#94a3b8;white-space:pre-wrap">${gtss.escapeHtml(log.stack_trace)}</pre></details>` : '';
  return `<div class="log-row ${log.level}">
    <span class="log-meta">${meta}</span>
    ${gtss.escapeHtml(log.message)}
    ${stack}
  </div>`;
}

function refreshLogsModal(pipelineId, data) {
  const list = document.getElementById('logs-list');
  const counts = document.getElementById('logs-counts');
  if (!list) return;

  const logs = data.logs || [];
  if (logs.length === 0) {
    list.innerHTML = `<div style="padding:24px;text-align:center;color:#64748b">No logs match the current filters.</div>`;
  } else {
    // Render oldest-first for natural reading flow
    list.innerHTML = logs.slice().reverse().map(renderLogRow).join('');
  }

  if (counts) {
    const c = data.counts || {};
    counts.innerHTML = `
      <span>Total: <strong style="color:#e2e8f0">${c.total || logs.length}</strong></span>
      <span style="color:#38bdf8">Info: ${c.info || 0}</span>
      <span style="color:#22c55e">Success: ${c.success || 0}</span>
      <span style="color:#fbbf24">Warn: ${c.warn || 0}</span>
      <span style="color:#f87171">Errors: ${c.error || 0}</span>
      <span style="color:#a78bfa">Retries: ${c.retry || 0}</span>
      <span style="color:#64748b">Debug: ${c.debug || 0}</span>
    `;
  }

  // Populate stage filter from observed stages
  const stageSelect = document.getElementById('logs-stage');
  if (stageSelect) {
    const stages = [...new Set(logs.map(l => l.stage).filter(Boolean))].sort();
    const currentVal = stageSelect.value;
    stageSelect.innerHTML = '<option value="">All stages</option>' +
      stages.map(s => `<option value="${s}"${s === currentVal ? ' selected' : ''}>${s}</option>`).join('');
  }
}

function attachLogsModalListeners(pipelineId) {
  const overlay = document.getElementById('pipeline-modal');
  if (!overlay) return;

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.id === 'close-modal') {
      if (activeLogsSub) { try { activeLogsSub.off(); } catch (_) {} activeLogsSub = null; }
      overlay.remove();
    }
  });

  const refresh = async () => {
    const search = document.getElementById('logs-search')?.value || '';
    const level = document.getElementById('logs-level')?.value || '';
    const stage = document.getElementById('logs-stage')?.value || '';
    const data = await loadLogs(pipelineId, { search, level, stage, limit: 300 });
    refreshLogsModal(pipelineId, data);
  };

  document.getElementById('logs-refresh')?.addEventListener('click', refresh);
  let searchTimer = null;
  document.getElementById('logs-search')?.addEventListener('input', () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(refresh, 300);
  });
  document.getElementById('logs-level')?.addEventListener('change', refresh);
  document.getElementById('logs-stage')?.addEventListener('change', refresh);

  // Live tail via Socket.IO
  const liveCheckbox = document.getElementById('logs-live');
  liveCheckbox?.addEventListener('change', () => {
    if (liveCheckbox.checked) {
      activeLogsSub = gtss.initSocket({
        'pipeline:log': (log) => {
          if (log.pipeline_id !== pipelineId) return;
          const list = document.getElementById('logs-list');
          if (!list) return;
          // Prepend new log (we render oldest-first via reverse, so prepend visually = at the bottom)
          const wrapper = document.createElement('div');
          wrapper.innerHTML = renderLogRow(log);
          const newRow = wrapper.firstElementChild;
          if (newRow) list.appendChild(newRow);
          // Auto-scroll to bottom
          list.scrollTop = list.scrollHeight;
        },
      });
    } else {
      if (activeLogsSub) { try { activeLogsSub.off(); } catch (_) {} activeLogsSub = null; }
    }
  });
}

// ── Socket.IO Live Updates ───────────────────────────────────────────────────

function initPipelineSocket() {
  const sub = gtss.initSocket({
    'pipeline:status': ({ id, status, state, error, last_run_at }) => {
      if (!id) return;
      // Refresh the full list for accurate data
      loadPipelines();
      if (status === 'completed') {
        gtss.showToast(`Pipeline "${id}" completed successfully`, 'success');
      } else if (status === 'failed') {
        gtss.showToast(`Pipeline "${id}" failed: ${error || 'unknown error'}`, 'error');
      } else if (state === 'paused') {
        gtss.showToast(`Pipeline "${id}" paused`, 'info');
      } else if (state === 'resuming' || status === 'resumed') {
        gtss.showToast(`Pipeline "${id}" resuming…`, 'info');
      } else if (state === 'stopped') {
        gtss.showToast(`Pipeline "${id}" stopped`, 'info');
      }
    },
    'pipeline:progress': ({ pipeline_id, execution_id, stage, message, progress, completed_steps, total_steps }) => {
      // Update the progress bar in-place for snappy UX (without a full reload)
      const card = document.querySelector(`[data-pipeline-id="${pipeline_id}"]`);
      if (!card) return;
      // Light-touch update: just patch the progress section
      const pipeline = pipelinesData.find(p => p.id === pipeline_id);
      if (pipeline) {
        pipeline.current_stage = stage;
        pipeline.current_message = message;
        pipeline.progress = progress;
        pipeline.completed_steps = completed_steps;
        pipeline.total_steps = total_steps;
        pipeline.active_execution_id = execution_id;
        // Re-render just the progress + stages sections
        const progressContainer = card.querySelector('.progress-track')?.parentElement?.parentElement;
        // For simplicity, do a full card refresh on every progress event (cheap enough at the rate we emit)
        const scrollY = window.scrollY;
        loadPipelines().then(() => { window.scrollTo(0, scrollY); });
      }
    },
    'pipeline:log': (log) => {
      // Live tail handled inside logs modal; nothing to do here for the main page
    },
  });
}

// ── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  loadPipelines();
  loadHealth();
  initPipelineSocket();
  // Refresh health every 30 seconds
  setInterval(loadHealth, 30_000);
});
