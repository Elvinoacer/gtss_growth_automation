/**
 * pipelines/renderCard.js — Render a single pipeline card and its sub-pieces.
 *
 * Each `render*` function returns an HTML string. `renderPipelineCard` is the
 * top-level entry point called by renderPipelines.js. The other functions
 * render the slots (status badge, progress, stages, banners, action buttons)
 * that patchPipelineCardInPlace() can swap out independently.
 */

/* global gtss */

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
    } else if (field.type === 'per_platform') {
      // Per-platform max-follows: one number input per platform, stored as a
      // single JSON object { instagram: N, x: N, ... } under field.key.
      const perPlatform = (val && typeof val === 'object') ? val : {};
      html += `<div style="padding:8px 0">
        <label style="color:#94a3b8;font-size:13px;display:block;margin-bottom:6px">${field.label}
          <span style="color:#64748b;font-size:11px;font-weight:400">— 0 = use global ceiling</span>
        </label>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px">
          ${ALL_PLATFORMS.map(p => `
            <div style="display:flex;align-items:center;gap:6px;padding:6px 10px;border-radius:8px;border:1px solid rgba(148,163,184,0.18);background:rgba(15,23,42,0.4)">
              <span style="color:#94a3b8;font-size:12px;flex:1">${gtss.formatPlatformLabel(p)}</span>
              <input type="number" data-per-platform-key="${field.key}" data-platform="${p}"
                value="${perPlatform[p] !== undefined ? perPlatform[p] : 0}" min="0" max="500"
                style="width:60px;padding:4px 6px;border-radius:6px;border:1px solid rgba(148,163,184,0.22);
                background:rgba(15,23,42,0.6);color:#e2e8f0;font-size:13px;text-align:center"
              />
            </div>
          `).join('')}
        </div>
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
        ? ['instagram', 'linkedin', 'x', 'facebook']
        : pipelineId === 'mass_follow'
          ? ['instagram', 'x', 'linkedin', 'facebook']
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

/**
 * Render the three dynamic banners that can appear above the details
 * sections of a pipeline card:
 *   1. "Last execution failed at stage X" banner (with Retry / Resume / Force-Clear)
 *   2. "Pipeline is running" banner (with Force-Clear for stuck runs)
 *   3. "Pipeline appears stuck" banner (with Force-Clear Now)
 *
 * Consolidated into one function so the in-place patcher can refresh
 * them as a single slot — without touching the surrounding form fields.
 */
function renderDynamicBanners(pipeline, displayStatus, hasFailedStage) {
  const parts = [];

  if (hasFailedStage) {
    parts.push(`
      <div style="padding:10px 14px;border-radius:10px;background:rgba(248,113,113,0.08);border:1px solid rgba(248,113,113,0.3);
        margin:10px 0;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
        <div style="display:flex;align-items:center;gap:8px;font-size:12px;color:#fca5a5">
          <span>✗ Last execution failed${pipeline.failed_stage ? ` at stage "${pipeline.failed_stage}"` : ''}.</span>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button type="button" class="pipeline-action-btn" data-action="retry-stage" data-pipeline="${pipeline.id}" data-stage="${pipeline.failed_stage || ''}"
            style="${actionStyle({ border: 'rgba(167,139,250,0.3)', bg: 'rgba(167,139,250,0.1)', text: '#a78bfa' }, true)}" title="Retry the failed stage (or start over from the first stage if no failed stage is recorded)">
            ↻ Retry Failed Step
          </button>
          <button type="button" class="pipeline-action-btn" data-action="resume-checkpoint" data-pipeline="${pipeline.id}"
            style="${actionStyle({ border: 'rgba(34,197,94,0.3)', bg: 'rgba(34,197,94,0.1)', text: '#4ade80' }, true)}" title="Resume from the last successful checkpoint (auto force-clears any stuck state)">
            ⏵ Resume from Checkpoint
          </button>
          <button type="button" class="pipeline-action-btn" data-action="force-clear" data-pipeline="${pipeline.id}"
            style="${actionStyle({ border: 'rgba(248,113,113,0.4)', bg: 'rgba(248,113,113,0.12)', text: '#f87171' }, true)}" title="Force-clear this execution so a new run can start. Use this if Retry / Resume are erroring.">
            ✕ Force Clear
          </button>
        </div>
      </div>
    `);
  }

  if (displayStatus === 'running' && !hasFailedStage) {
    parts.push(`
      <div style="padding:10px 14px;border-radius:10px;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.25);
        margin:10px 0;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
        <div style="display:flex;align-items:center;gap:8px;font-size:12px;color:#fbbf24">
          <span>⏳ Pipeline is running${pipeline.active_execution_id ? ` (execution ${String(pipeline.active_execution_id).slice(0,8)})` : ''}. If it appears stuck, use Force Clear to reset and start over.</span>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button type="button" class="pipeline-action-btn" data-action="force-clear" data-pipeline="${pipeline.id}"
            style="${actionStyle({ border: 'rgba(248,113,113,0.4)', bg: 'rgba(248,113,113,0.12)', text: '#f87171' }, true)}" title="Force-clear the current execution. Use this only if the pipeline is stuck on Running forever.">
            ✕ Force Clear Stuck Run
          </button>
        </div>
      </div>
    `);
  }

  if (pipeline.likely_stuck) {
    parts.push(`
      <div style="padding:12px 14px;border-radius:10px;background:rgba(248,113,113,0.1);border:1px solid rgba(248,113,113,0.4);
        margin:10px 0;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
        <div style="display:flex;align-items:center;gap:8px;font-size:12px;color:#fca5a5;flex:1;min-width:0">
          <span style="font-size:14px;flex-shrink:0">⚠</span>
          <span style="word-break:break-word"><strong>This pipeline appears stuck.</strong> The schedule-level state is "${displayStatus}" but there is no live runner in memory. Click <strong>Force Clear</strong> to reset and recover — this also kills any orphaned background jobs and clears the pause flag.</span>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button type="button" class="pipeline-action-btn" data-action="force-clear" data-pipeline="${pipeline.id}"
            style="${actionStyle({ border: 'rgba(248,113,113,0.4)', bg: 'rgba(248,113,113,0.18)', text: '#fca5a5' }, true)}" title="Force-clear the stuck execution. Marks DB rows as 'failed', kills background jobs, clears pause flag.">
            ✕ Force Clear Now
          </button>
        </div>
      </div>
    `);
  }

  return parts.join('');
}

/**
 * Render the action button row for a pipeline card.
 *
 * Extracted into its own function so the in-place patcher can refresh
 * button labels + disabled state without rebuilding the whole card.
 * The buttons are wrapped in a `data-slot="action-buttons"` span so
 * the patcher can swap them out atomically.
 */
function renderActionButtons(pipeline) {
  const meta = PIPELINE_META[pipeline.id] || {};
  const limits = pipeline.limits || {};
  const enabled = Boolean(pipeline.enabled);
  const displayStatus = pipeline.state || (pipeline.paused ? 'paused' : pipeline.last_status) || (enabled ? 'idle' : 'disabled');
  const needsTopic = pipeline.id === 'content' && (!limits.topic || !limits.topic.trim());
  const canRun = pipeline.can_run !== undefined ? pipeline.can_run : displayStatus !== 'running' && !pipeline.paused;
  const canPause = pipeline.can_pause !== undefined ? pipeline.can_pause : enabled && !pipeline.paused;
  const canResume = pipeline.can_resume !== undefined ? pipeline.can_resume : Boolean(pipeline.paused);
  const canStop = pipeline.can_stop !== undefined ? pipeline.can_stop : displayStatus === 'running' || displayStatus === 'stopping' || displayStatus === 'resuming' || displayStatus === 'retrying';
  const isRunningLike = ['running', 'stopping', 'resuming', 'retrying'].includes(displayStatus);
  const pauseAction = pipeline.paused ? 'resume' : 'pause';
  const pauseEnabled = pipeline.paused ? canResume : canPause;

  // Dynamic labels: when running, the primary button becomes "Running…";
  // when stopping, the Stop button becomes "Stopping…". This gives the
  // user a clear visual signal of what's happening right now.
  const runLabel = isRunningLike ? (displayStatus === 'stopping' ? '⟳ Stopping…' : '● Running…') : '▶ Start';
  const stopLabel = displayStatus === 'stopping' ? '⟳ Stopping…' : '■ Stop';
  const pauseLabel = pipeline.paused ? '▶ Resume' : 'Ⅱ Pause';

  return `
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button type="button" class="pipeline-action-btn" data-action="run" data-pipeline="${pipeline.id}"
          style="${actionStyle({ border: isRunningLike ? 'rgba(148,163,184,0.3)' : 'rgba(34,197,94,0.3)', bg: isRunningLike ? 'rgba(148,163,184,0.08)' : 'rgba(34,197,94,0.1)', text: isRunningLike ? '#94a3b8' : '#22c55e' }, canRun)}" title="${canRun ? 'Start this pipeline now' : 'Cannot start while paused, disabled, or already running'}"${disabledAttr(canRun)}>
          ${runLabel}
        </button>
        <button type="button" class="pipeline-action-btn" data-action="restart" data-pipeline="${pipeline.id}"
          style="${actionStyle({ border: 'rgba(56,189,248,0.3)', bg: 'rgba(56,189,248,0.1)', text: '#38bdf8' }, true)}" title="Stop current run (if any) and start fresh">
          ↻ Restart
        </button>
        <button type="button" class="pipeline-action-btn" data-action="${pauseAction}" data-pipeline="${pipeline.id}"
          style="${actionStyle({ border: 'rgba(245,158,11,0.3)', bg: 'rgba(245,158,11,0.1)', text: '#fbbf24' }, pauseEnabled)}" title="${pauseEnabled ? (pipeline.paused ? 'Resume this pipeline' : 'Pause this pipeline') : 'Pause is only available for enabled pipelines'}"${disabledAttr(pauseEnabled)}>
          ${pauseLabel}
        </button>
        <button type="button" class="pipeline-action-btn" data-action="stop" data-pipeline="${pipeline.id}"
          style="${actionStyle({ border: 'rgba(248,113,113,0.3)', bg: 'rgba(248,113,113,0.1)', text: '#f87171' }, canStop)}" title="${canStop ? 'Stop the active run' : 'No active run to stop'}"${disabledAttr(canStop)}>
          ${stopLabel}
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
        ${meta.isMassFollow ? `
        <button type="button" class="pipeline-action-btn" data-action="manage-targets" data-pipeline="${pipeline.id}"
          style="padding:8px 14px;border-radius:10px;border:1px solid rgba(168,85,247,0.35);
          background:rgba(168,85,247,0.1);color:#c4b5fd;font-size:12px;font-weight:600;cursor:pointer;
          transition:all 150ms" title="Add, import, review, and clear follow targets">
          🎯 Manage Targets
        </button>` : ''}
        <button type="button" class="pipeline-action-btn" data-action="save" data-pipeline="${pipeline.id}"
          style="padding:8px 14px;border-radius:10px;border:1px solid rgba(14,165,233,0.3);
          background:rgba(14,165,233,0.1);color:#38bdf8;font-size:12px;font-weight:600;cursor:pointer;
          transition:all 150ms" title="Save changes">
          💾 Save
        </button>
      </div>`;
}

function renderPipelineCard(pipeline) {
  const meta = PIPELINE_META[pipeline.id] || {};
  const limits = pipeline.limits || {};
  const enabled = Boolean(pipeline.enabled);
  const displayStatus = pipeline.state || (pipeline.paused ? 'paused' : pipeline.last_status) || (enabled ? 'idle' : 'disabled');
  const needsTopic = pipeline.id === 'content' && (!limits.topic || !limits.topic.trim());
  const isRunningLike = ['running', 'stopping', 'resuming', 'retrying'].includes(displayStatus);

  // Card border pulses left-edge color while running, for at-a-glance status.
  const borderColor = isRunningLike ? '#22c55e' : (meta.color || '#94a3b8');

  return `
  <article class="pipeline-card glass-panel animate-card${isRunningLike ? ' pipeline-card--running' : ''}" data-pipeline-id="${pipeline.id}"
    style="border-radius:24px;padding:24px 28px;border-left:4px solid ${borderColor}">

    <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:18px;flex-wrap:wrap">
      <div style="display:flex;align-items:center;gap:12px;min-width:0">
        <span style="font-size:26px">${meta.icon || '◉'}</span>
        <div style="min-width:0">
          <h2 style="margin:0;font-size:19px;font-weight:700;color:#f8fafc">${gtss.escapeHtml(pipeline.name)}</h2>
          <p style="margin:3px 0 0;font-size:12px;color:#94a3b8">${meta.stages?.map(s => meta.stageLabels?.[s] || s).join(' → ') || ''}</p>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:10px">
        <span data-slot="status-badge">${statusBadge(displayStatus)}</span>
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

    <div data-slot="progress-section">${renderProgressSection(pipeline)}</div>

    <div data-slot="stage-progress">${renderStageProgress(meta, pipeline)}</div>

    <div data-slot="dynamic-banners">
      ${renderDynamicBanners(pipeline, displayStatus, pipeline.state === 'failed')}
    </div>

    <details class="pipeline-section" ${expandedPipelines.has(pipeline.id) ? 'open' : ''} data-pipeline-section="${pipeline.id}" style="margin-top:8px">
      <summary style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;cursor:pointer">
        <span style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:#cbd5e1">
          <span class="chevron" style="color:#64748b">▸</span>
          Pipeline Health & Metrics
        </span>
        <span style="font-size:11px;color:#64748b">click to ${expandedPipelines.has(pipeline.id) ? 'collapse' : 'expand'}</span>
      </summary>
      <div data-health-section="${pipeline.id}" style="padding-top:4px">
        ${renderHealthSection(pipeline)}
      </div>
    </details>

    <details class="pipeline-section" open data-pipeline-section="${pipeline.id}-config" style="margin-top:8px">
      <summary style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;cursor:pointer">
        <span style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:#cbd5e1">
          <span class="chevron" style="color:#64748b">▸</span>
          Schedule & Configuration
        </span>
        <span style="font-size:11px;color:#64748b">click to collapse</span>
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
      <div data-slot="footer-stats" style="font-size:11px;color:#64748b;display:flex;gap:14px;flex-wrap:wrap">
        <span>Last run: <strong style="color:#94a3b8">${formatRelative(pipeline.last_run_at)}</strong></span>
        <span>Next: <strong style="color:#94a3b8">${pipeline.enabled ? formatRelative(pipeline.next_run_at) : 'Disabled'}</strong></span>
        <span>Runs: <strong style="color:#94a3b8">${pipeline.run_count || 0}</strong></span>
      </div>
      <div data-slot="action-buttons">
        ${renderActionButtons(pipeline)}
      </div>
    </div>
  </article>`;
}
