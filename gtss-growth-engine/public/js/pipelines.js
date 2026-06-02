/**
 * pipelines.js — Pipeline Manager UI logic
 */

/* global gtss, io */

const CRON_PRESETS = [
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
    stages: 'Discovery → Qualification → Messaging → DM Send',
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
    stages: 'Gemini Image → Caption → Multi-platform Post',
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
    stages: 'Inbox scan → Reply detection → CRM update',
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

let pipelinesData = [];

// ── API Helpers ──────────────────────────────────────────────────────────────

async function loadPipelines() {
  try {
    const data = await gtss.fetchJSON('/api/pipelines');
    pipelinesData = data.pipelines || [];
    renderPipelines(pipelinesData);
  } catch (err) {
    gtss.showToast('Failed to load pipelines: ' + err.message, 'error');
  }
}

async function savePipeline(id) {
  const card = document.querySelector(`[data-pipeline-id="${id}"]`);
  if (!card) return;

  const cronInput = card.querySelector('[data-field="cron"]');
  const payload = { cron: cronInput ? cronInput.value : undefined };

  // Collect limits
  const limits = {};
  card.querySelectorAll('[data-limit-key]').forEach(el => {
    const key = el.dataset.limitKey;
    limits[key] = el.type === 'number' ? Number(el.value) : el.value;
  });

  // Collect platforms for pipelines that target selectable platforms
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
      gtss.showToast(
        `Pipeline ${enabled ? 'enabled' : 'disabled'}`,
        enabled ? 'success' : 'info'
      );
      loadPipelines();
    }
  } catch (err) {
    gtss.showToast(err.message, 'error');
  }
}

async function runNow(id) {
  try {
    const result = await gtss.fetchJSON(`/api/pipelines/${id}/run`, {
      method: 'POST',
    });
    gtss.showToast(result.message || 'Pipeline triggered', 'success');
  } catch (err) {
    gtss.showToast(err.message, 'error');
  }
}

async function pausePipeline(id, paused) {
  try {
    await gtss.fetchJSON(`/api/pipelines/${id}/${paused ? 'pause' : 'resume'}`, {
      method: 'POST',
    });
    gtss.showToast(`Pipeline ${paused ? 'paused' : 'resumed'}`, 'success');
    loadPipelines();
  } catch (err) {
    gtss.showToast(err.message, 'error');
  }
}

async function stopPipeline(id) {
  try {
    const result = await gtss.fetchJSON(`/api/pipelines/${id}/stop`, {
      method: 'POST',
    });
    gtss.showToast(`Stop requested (${result.stopped || 0} active job(s))`, 'info');
    loadPipelines();
  } catch (err) {
    gtss.showToast(err.message, 'error');
  }
}

async function loadHistory(id) {
  try {
    const data = await gtss.fetchJSON(`/api/pipelines/${id}/history?limit=10`);
    renderHistoryModal(id, data.runs || []);
  } catch (err) {
    gtss.showToast('Failed to load history: ' + err.message, 'error');
  }
}

// ── Rendering ────────────────────────────────────────────────────────────────

function formatDate(dateStr) {
  if (!dateStr) return 'Never';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

function statusBadge(status) {
  const map = {
    completed: { bg: 'rgba(34,197,94,0.15)', color: '#22c55e', icon: '✓' },
    running: { bg: 'rgba(59,130,246,0.15)', color: '#60a5fa', icon: '⟳' },
    failed: { bg: 'rgba(248,113,113,0.15)', color: '#f87171', icon: '✗' },
    paused: { bg: 'rgba(245,158,11,0.15)', color: '#f59e0b', icon: 'Ⅱ' },
    stopped: { bg: 'rgba(148,163,184,0.14)', color: '#cbd5e1', icon: '■' },
    disabled: { bg: 'rgba(100,116,139,0.14)', color: '#94a3b8', icon: '○' },
    idle: { bg: 'rgba(148,163,184,0.12)', color: '#94a3b8', icon: '—' },
  };
  const s = map[status] || map.idle;
  return `<span style="display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:700;background:${s.bg};color:${s.color}">${s.icon} ${status || 'idle'}</span>`;
}

function actionStyle(color, enabled = true) {
  const disabled = !enabled;
  return `padding:8px 16px;border-radius:10px;border:1px solid ${disabled ? 'rgba(100,116,139,0.2)' : color.border};
    background:${disabled ? 'rgba(100,116,139,0.08)' : color.bg};color:${disabled ? '#64748b' : color.text};font-size:13px;font-weight:600;
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

function renderPipelineCard(pipeline) {
  const meta = PIPELINE_META[pipeline.id] || {};
  const limits = pipeline.limits || {};
  const enabled = Boolean(pipeline.enabled);
  const displayStatus = pipeline.state || (pipeline.paused ? 'paused' : pipeline.last_status) || (enabled ? 'idle' : 'disabled');
  const activeJobs = Array.isArray(pipeline.active_jobs) ? pipeline.active_jobs : [];
  const currentText = pipeline.current_message || pipeline.current_stage || (displayStatus === 'running' ? 'Starting...' : 'No active run right now.');
  const needsTopic = pipeline.id === 'content' && (!limits.topic || !limits.topic.trim());
  const canRun = pipeline.can_run !== undefined ? pipeline.can_run : displayStatus !== 'running' && !pipeline.paused;
  const canPause = pipeline.can_pause !== undefined ? pipeline.can_pause : enabled && !pipeline.paused;
  const canResume = pipeline.can_resume !== undefined ? pipeline.can_resume : Boolean(pipeline.paused);
  const canStop = pipeline.can_stop !== undefined ? pipeline.can_stop : displayStatus === 'running';
  const pauseAction = pipeline.paused ? 'resume' : 'pause';
  const pauseEnabled = pipeline.paused ? canResume : canPause;

  return `
  <article class="pipeline-card glass-panel animate-card" data-pipeline-id="${pipeline.id}"
    style="border-radius:24px;padding:28px 32px;border-left:4px solid ${meta.color || '#94a3b8'}">

    <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:20px;flex-wrap:wrap">
      <div style="display:flex;align-items:center;gap:12px">
        <span style="font-size:28px">${meta.icon || '◉'}</span>
        <div>
          <h2 style="margin:0;font-size:20px;font-weight:700;color:#f8fafc">${gtss.escapeHtml(pipeline.name)}</h2>
          <p style="margin:4px 0 0;font-size:13px;color:#94a3b8">${meta.stages || ''}</p>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:10px">
        ${statusBadge(displayStatus)}
        <label class="pipeline-toggle" style="position:relative;display:inline-block;width:52px;height:28px;cursor:pointer">
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
              width:22px;height:22px;border-radius:999px;background:#fff;
              transition:all 200ms;box-shadow:0 2px 6px rgba(0,0,0,0.2)
            "></span>
          </span>
        </label>
      </div>
    </div>

    ${needsTopic ? `
      <div style="padding:10px 14px;border-radius:10px;background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.25);
        margin-bottom:16px;display:flex;align-items:center;gap:8px;font-size:13px;color:#fbbf24">
        ⚠ Set a content topic before enabling this pipeline.
      </div>
    ` : ''}

    <div style="padding:12px 14px;border-radius:12px;background:rgba(15,23,42,0.45);border:1px solid rgba(148,163,184,0.12);
      margin-bottom:16px;color:#cbd5e1;font-size:13px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
      <span><strong style="color:#f8fafc">Current:</strong> ${gtss.escapeHtml(currentText)}</span>
      <span style="color:#94a3b8">${activeJobs.length ? `${activeJobs.length} active job(s)` : 'controls update in real time'}</span>
    </div>

    <div style="display:grid;gap:4px;margin-bottom:20px">
      <div style="display:flex;align-items:center;gap:24px;font-size:13px;color:#94a3b8">
        <span>Schedule</span>
      </div>
      ${renderCronPicker(pipeline.cron, pipeline.id)}
    </div>

    <div style="border-top:1px solid rgba(148,163,184,0.12);padding-top:16px;margin-bottom:16px">
      <p style="margin:0 0 10px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#64748b">
        ${pipeline.id === 'content' ? 'Content Settings' : 'Limits'}
      </p>
      ${renderLimitFields(meta, limits)}
      ${meta.platformField ? renderPlatformCheckboxes(limits.platforms, pipeline.id) : ''}
    </div>

    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;
      border-top:1px solid rgba(148,163,184,0.12);padding-top:16px">
      <div style="font-size:13px;color:#64748b">
        <span>Last run: <strong style="color:#94a3b8">${formatDate(pipeline.last_run_at)}</strong></span>
        <span style="margin-left:16px">Next run: <strong style="color:#94a3b8">${pipeline.enabled ? formatDate(pipeline.next_run_at) : 'Disabled'}</strong></span>
        <span style="margin-left:16px">Runs: <strong style="color:#94a3b8">${pipeline.run_count || 0}</strong></span>
      </div>
      <div style="display:flex;gap:8px">
        <button type="button" class="pipeline-action-btn" data-action="run" data-pipeline="${pipeline.id}"
          style="${actionStyle({ border: 'rgba(34,197,94,0.3)', bg: 'rgba(34,197,94,0.1)', text: '#22c55e' }, canRun)}" title="${canRun ? 'Run this pipeline now' : 'Cannot run while paused or already running'}"${disabledAttr(canRun)}>
          ▶ ${displayStatus === 'running' ? 'Running' : 'Run Now'}
        </button>
        <button type="button" class="pipeline-action-btn" data-action="history" data-pipeline="${pipeline.id}"
          style="padding:8px 16px;border-radius:10px;border:1px solid rgba(148,163,184,0.2);
          background:rgba(148,163,184,0.06);color:#94a3b8;font-size:13px;font-weight:600;cursor:pointer;
          transition:all 150ms" title="View run history">
          📋 History
        </button>
        <button type="button" class="pipeline-action-btn" data-action="${pauseAction}" data-pipeline="${pipeline.id}"
          style="${actionStyle({ border: 'rgba(245,158,11,0.3)', bg: 'rgba(245,158,11,0.1)', text: '#fbbf24' }, pauseEnabled)}" title="${pauseEnabled ? (pipeline.paused ? 'Resume this pipeline' : 'Pause this pipeline') : 'Pause is only available for enabled pipelines'}"${disabledAttr(pauseEnabled)}>
          ${pipeline.paused ? '▶ Resume' : 'Ⅱ Pause'}
        </button>
        <button type="button" class="pipeline-action-btn" data-action="stop" data-pipeline="${pipeline.id}"
          style="${actionStyle({ border: 'rgba(248,113,113,0.3)', bg: 'rgba(248,113,113,0.1)', text: '#f87171' }, canStop)}" title="${canStop ? 'Stop the active run' : 'No active run to stop'}"${disabledAttr(canStop)}>
          ■ ${canStop ? 'Stop' : 'Stopped'}
        </button>
        <button type="button" class="pipeline-action-btn" data-action="save" data-pipeline="${pipeline.id}"
          style="padding:8px 16px;border-radius:10px;border:1px solid rgba(14,165,233,0.3);
          background:rgba(14,165,233,0.1);color:#38bdf8;font-size:13px;font-weight:600;cursor:pointer;
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

function attachCardListeners() {
  // Toggle switches
  document.querySelectorAll('[data-toggle-pipeline]').forEach(input => {
    input.addEventListener('change', (e) => {
      togglePipeline(e.target.dataset.togglePipeline, e.target.checked);
    });
  });

  // Action buttons
  document.querySelectorAll('.pipeline-action-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      if (btn.disabled) return;
      const action = btn.dataset.action;
      const id = btn.dataset.pipeline;
      if (action === 'run') runNow(id);
      else if (action === 'history') loadHistory(id);
      else if (action === 'pause') pausePipeline(id, true);
      else if (action === 'resume') pausePipeline(id, false);
      else if (action === 'stop') stopPipeline(id);
      else if (action === 'save') savePipeline(id);
    });
  });

  // Cron preset buttons
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

      // Update active state visually
      card.querySelectorAll('.cron-preset-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      if (preset === 'custom' && cronInput) {
        cronInput.focus();
        cronInput.select();
      }
    });
  });

  // Hover effects for action buttons
  document.querySelectorAll('.pipeline-action-btn').forEach(btn => {
    btn.addEventListener('mouseenter', () => { btn.style.transform = 'translateY(-1px)'; btn.style.opacity = '0.9'; });
    btn.addEventListener('mouseleave', () => { btn.style.transform = 'translateY(0)'; btn.style.opacity = '1'; });
  });
}

function renderHistoryModal(pipelineId, runs) {
  // Remove existing modal if present
  const existing = document.getElementById('pipeline-history-modal');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'pipeline-history-modal';
  overlay.style.cssText = `position:fixed;inset:0;z-index:3000;display:grid;place-items:center;
    padding:20px;background:rgba(2,6,23,0.72);animation:fadeIn 200ms ease`;

  const isOutreach = pipelineId === 'outreach';
  const isDmCheck = pipelineId === 'dm_check';
  const title = isOutreach
    ? 'Outreach Pipeline History'
    : isDmCheck
      ? 'DM Checker History'
      : 'Content Pipeline History';

  let rowsHtml = '';
  if (runs.length === 0) {
    rowsHtml = `<tr><td colspan="5" style="padding:24px;text-align:center;color:#64748b">No runs yet</td></tr>`;
  } else {
    rowsHtml = runs.map(run => {
      if (isOutreach || isDmCheck) {
        return `<tr>
          <td style="padding:10px 12px;border-bottom:1px solid rgba(148,163,184,0.12);color:#e2e8f0;font-size:13px">#${run.id}</td>
          <td style="padding:10px 12px;border-bottom:1px solid rgba(148,163,184,0.12);color:#94a3b8;font-size:13px">${run.trigger || '—'}</td>
          <td style="padding:10px 12px;border-bottom:1px solid rgba(148,163,184,0.12)">${statusBadge(run.status)}</td>
          <td style="padding:10px 12px;border-bottom:1px solid rgba(148,163,184,0.12);color:#94a3b8;font-size:13px">${formatDate(run.started_at)}</td>
          <td style="padding:10px 12px;border-bottom:1px solid rgba(148,163,184,0.12);color:#94a3b8;font-size:13px">${formatDate(run.finished_at)}</td>
        </tr>`;
      } else {
        return `<tr>
          <td style="padding:10px 12px;border-bottom:1px solid rgba(148,163,184,0.12);color:#e2e8f0;font-size:13px">#${run.id}</td>
          <td style="padding:10px 12px;border-bottom:1px solid rgba(148,163,184,0.12);color:#94a3b8;font-size:13px">${gtss.escapeHtml(run.platforms || '—')}</td>
          <td style="padding:10px 12px;border-bottom:1px solid rgba(148,163,184,0.12)">${statusBadge(run.status)}</td>
          <td style="padding:10px 12px;border-bottom:1px solid rgba(148,163,184,0.12);color:#94a3b8;font-size:13px">${formatDate(run.created_at)}</td>
          <td style="padding:10px 12px;border-bottom:1px solid rgba(148,163,184,0.12);color:#94a3b8;font-size:12px;max-width:200px;overflow:hidden;text-overflow:ellipsis">${gtss.escapeHtml(run.last_error || run.body || '—').slice(0, 80)}</td>
        </tr>`;
      }
    }).join('');
  }

  const headers = isOutreach
    ? '<th>Run</th><th>Trigger</th><th>Status</th><th>Started</th><th>Finished</th>'
    : isDmCheck
      ? '<th>Job</th><th>Trigger</th><th>Status</th><th>Started</th><th>Finished</th>'
    : '<th>Post</th><th>Platforms</th><th>Status</th><th>Created</th><th>Details</th>';

  overlay.innerHTML = `
    <div style="width:min(720px,100%);max-height:80vh;overflow-y:auto;padding:28px;border-radius:20px;
      background:linear-gradient(180deg,rgba(15,23,42,0.98),rgba(15,23,42,0.92));
      border:1px solid rgba(148,163,184,0.2);box-shadow:0 24px 80px rgba(0,0,0,0.4)">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">
        <h3 style="margin:0;font-size:18px;font-weight:700;color:#f8fafc">${title}</h3>
        <button id="close-history-modal" type="button" style="width:32px;height:32px;border-radius:999px;
          border:1px solid rgba(148,163,184,0.2);background:rgba(148,163,184,0.06);
          color:#94a3b8;cursor:pointer;font-size:16px;display:grid;place-items:center">✕</button>
      </div>
      <table style="width:100%;border-collapse:collapse">
        <thead>
          <tr style="text-align:left">
            ${headers.split('</th>').map(h => h ? h.replace('<th>', `<th style="padding:10px 12px;border-bottom:1px solid rgba(148,163,184,0.2);
              color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;font-weight:700">`) : '').join('</th>')}
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
  `;

  document.body.appendChild(overlay);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.id === 'close-history-modal') {
      overlay.remove();
    }
  });
}

// ── Socket.IO Live Updates ───────────────────────────────────────────────────

function initPipelineSocket() {
  const sub = gtss.initSocket({
    'pipeline:status': ({ id, status, last_run_at, error }) => {
      // Update the card in-place without full reload
      const card = document.querySelector(`[data-pipeline-id="${id}"]`);
      if (!card) return;

      // Refresh the full list for accurate data
      loadPipelines();

      if (status === 'completed') {
        gtss.showToast(`Pipeline "${id}" completed successfully`, 'success');
      } else if (status === 'failed') {
        gtss.showToast(`Pipeline "${id}" failed: ${error || 'unknown error'}`, 'error');
      }
    },
    'content_pipeline:event': ({ jobId, stage, message }) => {
      // Could append to a live log panel in the future
      console.log(`[content-pipeline:${jobId}] ${stage}: ${message}`);
    },
  });
}

// ── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  loadPipelines();
  initPipelineSocket();
});
