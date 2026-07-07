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

// ── Anti-flicker interaction guard ─────────────────────────────────────────
//
// The page previously rebuilt the entire pipelines container (`innerHTML =
// ...`) on every Socket.IO status event, every progress event (debounced to
// 600ms), and every 8s poll. While the user was typing in the cron input or
// a limits field, the rebuild would destroy the focused element, dropping
// the caret and any in-flight keystrokes — making the page feel broken.
//
// To prevent this we:
//   1. Track whether the user is currently interacting with any form field
//      inside the pipelines container (focus + 800ms grace period after
//      blur, so a quick poll doesn't yank focus back).
//   2. Track whether the user has any "dirty" (unsaved) form values in the
//      config section of any card. If they do, we NEVER silently overwrite
//      the inputs — we only patch the dynamic parts (progress bar, status
//      badge, stage pills, health strip).
//   3. Patch dynamic parts in place instead of rebuilding the whole card.
//      This keeps the DOM identity stable so focus, scroll, and uncommitted
//      input values survive.
let userInteracting = false;
let interactionGraceUntil = 0;

function isUserInteracting() {
  if (userInteracting) return true;
  if (Date.now() < interactionGraceUntil) return true;
  // Defensive: check the actual focused element too, in case the focus
  // event was missed (e.g., user tabbed into a field before this script
  // attached the listener).
  const active = document.activeElement;
  if (active && active.closest && active.closest('#pipelines-container')) {
    const tag = (active.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || active.isContentEditable) {
      return true;
    }
  }
  return false;
}

function markInteracting() {
  userInteracting = true;
}
function markInteractionEnd() {
  userInteracting = false;
  // Hold off re-renders for 800ms after blur so a socket event firing the
  // instant the user tabs out doesn't yank focus back to a rebuilt node.
  interactionGraceUntil = Date.now() + 800;
}

// Attach focusin/focusout on the container (delegated — works for any
// input inside, including ones added by future re-renders). We use
// focusin/focusout because they bubble; focus/blur do not.
document.addEventListener('focusin', (e) => {
  if (e.target && e.target.closest && e.target.closest('#pipelines-container')) {
    markInteracting();
  }
});
document.addEventListener('focusout', (e) => {
  if (e.target && e.target.closest && e.target.closest('#pipelines-container')) {
    markInteractionEnd();
  }
});

// Read all "config" form values from a card so we can preserve them across
// in-place patches. Returns null if the card isn't yet rendered.
function readCardFormValues(card) {
  if (!card) return null;
  const vals = { cron: null, limits: {}, platforms: {} };
  const cronInput = card.querySelector('[data-field="cron"]');
  if (cronInput) vals.cron = cronInput.value;
  card.querySelectorAll('[data-limit-key]').forEach((el) => {
    vals.limits[el.dataset.limitKey] = el.type === 'number' ? Number(el.value) : el.value;
  });
  card.querySelectorAll('[data-platform-checkbox]').forEach((cb) => {
    vals.platforms[cb.dataset.platformCheckbox] = cb.checked;
  });
  return vals;
}

// Restore form values into a freshly-rendered card (used after a forced
// full re-render). Without this, the cron input and limit fields would
// silently reset to whatever the server returned — losing the user's
// unsaved changes.
function applyCardFormValues(card, vals) {
  if (!card || !vals) return;
  if (vals.cron != null) {
    const cronInput = card.querySelector('[data-field="cron"]');
    if (cronInput && cronInput.value !== vals.cron) cronInput.value = vals.cron;
  }
  for (const [k, v] of Object.entries(vals.limits || {})) {
    const el = card.querySelector(`[data-limit-key="${k}"]`);
    if (el && el.value !== String(v)) el.value = v;
  }
  for (const [p, checked] of Object.entries(vals.platforms || {})) {
    const cb = card.querySelector(`[data-platform-checkbox="${p}"]`);
    if (cb && cb.checked !== checked) cb.checked = checked;
  }
}

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

/**
 * Show a detailed, persistent error message for pipeline action failures.
 *
 * The previous behavior just called gtss.showToast(err.message, 'error'),
 * which disappeared after a few seconds and gave the user no way to read
 * the actual error (e.g., "Another execution is already running").
 *
 * Now we:
 *   - Show the toast (preserving existing UX).
 *   - Also log to console with full context.
 *   - If the error response includes a `hint` or `details`, render an
 *     inline banner above the affected pipeline card so the user can
 *     actually read what went wrong and what to do next.
 *   - If the hint suggests a specific recovery action (e.g., 'force_clear',
 *     'stop_first'), show a one-click button to take that action.
 */
function showPipelineActionError(pipelineId, action, err) {
  // eslint-disable-next-line no-console
  console.error(`[pipelines] Action "${action}" failed for pipeline "${pipelineId}":`, err);
  const msg = err?.message || String(err);
  const hint = err?.hint || err?.body?.hint || null;
  gtss.showToast(`${action} failed: ${msg}`, 'error', 8000);
  // Try to render an inline banner above the affected card.
  try {
    const card = document.querySelector(`[data-pipeline-id="${pipelineId}"]`);
    if (card) {
      const existing = card.querySelector('.pipeline-action-error-banner');
      if (existing) existing.remove();
      const banner = document.createElement('div');
      banner.className = 'pipeline-action-error-banner';
      banner.style.cssText = 'padding:10px 14px;border-radius:10px;background:rgba(248,113,113,0.1);border:1px solid rgba(248,113,113,0.35);margin:8px 0;font-size:12px;color:#fca5a5;display:flex;align-items:flex-start;gap:10px;cursor:pointer';

      // Map backend hints to one-click recovery actions.
      let recoveryBtnHtml = '';
      if (hint === 'force_clear' || hint === 'another_running' || hint === 'already_running') {
        recoveryBtnHtml = `<button type="button" data-recovery-action="force-clear" data-pipeline="${pipelineId}" style="margin-top:6px;padding:5px 10px;border-radius:6px;border:1px solid rgba(248,113,113,0.4);background:rgba(248,113,113,0.18);color:#fca5a5;font-size:11px;font-weight:600;cursor:pointer">✕ Force Clear &amp; Retry</button>`;
      } else if (hint === 'stop_first') {
        recoveryBtnHtml = `<button type="button" data-recovery-action="stop" data-pipeline="${pipelineId}" style="margin-top:6px;padding:5px 10px;border-radius:6px;border:1px solid rgba(248,113,113,0.4);background:rgba(248,113,113,0.18);color:#fca5a5;font-size:11px;font-weight:600;cursor:pointer">■ Stop &amp; Retry</button>`;
      } else if (hint === 'paused') {
        recoveryBtnHtml = `<button type="button" data-recovery-action="resume" data-pipeline="${pipelineId}" style="margin-top:6px;padding:5px 10px;border-radius:6px;border:1px solid rgba(245,158,11,0.4);background:rgba(245,158,11,0.18);color:#fcd34d;font-size:11px;font-weight:600;cursor:pointer">▶ Resume &amp; Retry</button>`;
      }

      banner.innerHTML = `
        <span style="font-size:14px;flex-shrink:0">⚠</span>
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;margin-bottom:2px">${gtss.escapeHtml(action)} failed</div>
          <div style="word-break:break-word">${gtss.escapeHtml(msg)}</div>
          ${recoveryBtnHtml}
        </div>
        <span style="font-size:18px;color:#64748b;flex-shrink:0;line-height:1">✕</span>
      `;
      banner.addEventListener('click', (e) => {
        // Don't dismiss if the user clicked the recovery button.
        if (e.target.tagName === 'BUTTON') return;
        banner.remove();
      });
      // Wire up the recovery button.
      const recoveryBtn = banner.querySelector('[data-recovery-action]');
      if (recoveryBtn) {
        recoveryBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const recoveryAction = recoveryBtn.dataset.recoveryAction;
          const recoveryPipelineId = recoveryBtn.dataset.pipeline;
          banner.remove();
          // Take the recovery action, then retry the original action.
          if (recoveryAction === 'force-clear') {
            forceClearPipeline(recoveryPipelineId, null);
          } else if (recoveryAction === 'stop') {
            stopPipeline(recoveryPipelineId, null);
          } else if (recoveryAction === 'resume') {
            resumePipeline(recoveryPipelineId, null);
          }
        });
      }
      // Insert at the top of the card, just inside
      card.insertBefore(banner, card.firstChild);
      // Auto-remove after 30s
      setTimeout(() => { try { banner.remove(); } catch (_) {} }, 30000);
    }
  } catch (_) {}
}

/**
 * Show a persistent success/info banner above the card for action confirmations.
 */
function showPipelineActionInfo(pipelineId, action, msg, type = 'info') {
  try {
    const card = document.querySelector(`[data-pipeline-id="${pipelineId}"]`);
    if (!card) return;
    const existing = card.querySelector('.pipeline-action-error-banner');
    if (existing) existing.remove();
    const colors = {
      info:    { bg: 'rgba(56,189,248,0.1)',  border: 'rgba(56,189,248,0.35)',  text: '#7dd3fc' },
      success: { bg: 'rgba(34,197,94,0.1)',   border: 'rgba(34,197,94,0.35)',   text: '#86efac' },
      warn:    { bg: 'rgba(245,158,11,0.1)',  border: 'rgba(245,158,11,0.35)',  text: '#fcd34d' },
    };
    const c = colors[type] || colors.info;
    const banner = document.createElement('div');
    banner.className = 'pipeline-action-error-banner';
    banner.style.cssText = `padding:10px 14px;border-radius:10px;background:${c.bg};border:1px solid ${c.border};margin:8px 0;font-size:12px;color:${c.text};display:flex;align-items:flex-start;gap:10px;cursor:pointer`;
    banner.innerHTML = `
      <span style="font-size:14px;flex-shrink:0">${type === 'success' ? '✓' : type === 'warn' ? '⚠' : 'ℹ'}</span>
      <div style="flex:1;min-width:0">
        <div style="font-weight:700;margin-bottom:2px">${gtss.escapeHtml(action)}</div>
        <div style="word-break:break-word">${gtss.escapeHtml(msg)}</div>
      </div>
      <span style="font-size:18px;color:#64748b;flex-shrink:0;line-height:1">✕</span>
    `;
    banner.addEventListener('click', () => banner.remove());
    card.insertBefore(banner, card.firstChild);
    setTimeout(() => { try { banner.remove(); } catch (_) {} }, 15000);
  } catch (_) {}
}

/**
 * Wrap any pipeline action in a button-loading state + structured error
 * handling + immediate reload. Returns the raw fetch promise so callers
 * can chain on success.
 *
 * Optimistic feedback: when the action is one of run/restart/resume/pause/stop,
 * we patch the affected card's action buttons immediately so the user sees
 * instant state feedback instead of waiting for the server round-trip.
 *
 * On success: reload pipelines immediately + again after 1s so the user
 * sees the new state without waiting for the socket event.
 *
 * On error: do NOT reload (the state hasn't changed, so reloading would
 * just flicker the UI). The error is shown via the inline banner.
 */
async function withActionFeedback(pipelineId, action, btn, fetchPromise) {
  if (btn) {
    btn.disabled = true;
    btn.dataset.originalHtml = btn.innerHTML;
    btn.dataset.gtssLoading = '1';
    btn.innerHTML = `<span class="spinner" style="display:inline-block;animation:spin 1.4s linear infinite">⟳</span> ${btn.innerHTML}`;
    btn.style.opacity = '0.7';
  }
  // ── Optimistic state patch ───────────────────────────────────────────
  // Flip the cached pipeline state immediately so the action buttons
  // (Run/Stop/Pause) update their labels + disabled state before the
  // server even responds. The next loadPipelines() will reconcile with
  // ground truth.
  const optimistic = optimisticStateForAction(pipelineId, action);
  if (optimistic) {
    const pipeline = pipelinesData.find((p) => p.id === pipelineId);
    if (pipeline) {
      Object.assign(pipeline, optimistic);
      const card = document.querySelector(`[data-pipeline-id="${pipelineId}"]`);
      if (card) patchPipelineCardInPlace(card, pipeline, { preserveLoadingButton: btn });
    }
  }
  let succeeded = false;
  try {
    const result = await fetchPromise;
    if (result && result.message) {
      const type = result.ok === false ? 'warn' : 'success';
      gtss.showToast(result.message, type, 6000);
      showPipelineActionInfo(pipelineId, action, result.message, type);
    }
    succeeded = true;
    return result;
  } catch (err) {
    showPipelineActionError(pipelineId, action, err);
    throw err;
  } finally {
    if (btn) {
      btn.disabled = false;
      if (btn.dataset.originalHtml) {
        btn.innerHTML = btn.dataset.originalHtml;
        delete btn.dataset.originalHtml;
      }
      delete btn.dataset.gtssLoading;
      btn.style.opacity = '';
    }
    // Only reload on success — on error, the state hasn't changed,
    // so reloading would just flicker the UI without helping the user.
    if (succeeded) {
      loadPipelines();
      setTimeout(loadPipelines, 1000);
    } else {
      // On error, still patch the card back to its pre-optimistic state
      // so the UI doesn't lie about what happened.
      const pipeline = pipelinesData.find((p) => p.id === pipelineId);
      if (pipeline) {
        // Revert the optimistic state by reloading from the server.
        loadPipelines();
      }
    }
  }
}

/**
 * Map a user action to the optimistic state patch we should apply to the
 * cached pipeline. Returns null for actions that don't have a clear
 * optimistic state (e.g., save, history, logs).
 */
function optimisticStateForAction(pipelineId, action) {
  const base = { id: pipelineId };
  switch (action) {
    case 'Run Now':
    case 'Restart':
      return {
        ...base,
        state: 'running',
        paused: false,
        progress: 0,
        current_message: action === 'Restart' ? 'Restarting…' : 'Starting…',
        active_execution_id: null,
      };
    case 'Stop':
      return { ...base, state: 'stopping', current_message: 'Stopping…' };
    case 'Pause':
      return { ...base, state: 'paused', paused: true, current_message: 'Pausing…' };
    case 'Resume':
      return { ...base, state: 'resuming', paused: false, current_message: 'Resuming…' };
    default:
      return null;
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

async function runNow(id, btn) {
  try {
    await withActionFeedback(id, 'Run Now', btn,
      gtss.fetchJSON(`/api/pipelines/${id}/run`, { method: 'POST' })
    );
  } catch (_) { /* error already shown by withActionFeedback */ }
}

async function restartPipeline(id, btn) {
  // Confirm only if there's an active execution that would be killed.
  // If the pipeline is idle, restart is equivalent to Run Now — no need
  // to confirm.
  const pipeline = pipelinesData.find((p) => p.id === id);
  const hasActive = pipeline && (pipeline.active_execution_id || pipeline.state === 'running' || pipeline.state === 'paused' || pipeline.state === 'resuming' || pipeline.state === 'stopping' || pipeline.state === 'retrying');
  if (hasActive) {
    if (!confirm(`Restart pipeline "${id}"?\n\nThis will stop the current run (if any) and start a fresh execution from the first step. If the pipeline is paused, the pause flag will also be cleared.`)) return;
  }
  try {
    await withActionFeedback(id, 'Restart', btn,
      gtss.fetchJSON(`/api/pipelines/${id}/restart`, { method: 'POST' })
    );
  } catch (_) { /* error already shown */ }
}

async function pausePipeline(id, btn) {
  try {
    await withActionFeedback(id, 'Pause', btn,
      gtss.fetchJSON(`/api/pipelines/${id}/pause`, { method: 'POST' })
    );
  } catch (_) { /* error already shown */ }
}

async function resumePipeline(id, btn) {
  try {
    await withActionFeedback(id, 'Resume', btn,
      gtss.fetchJSON(`/api/pipelines/${id}/resume`, { method: 'POST' })
    );
  } catch (_) { /* error already shown */ }
}

// Legacy alias — kept for any callers that still use the old
// (id, paused, btn) signature. Prefer pausePipeline / resumePipeline.
async function pausePipelineLegacy(id, paused, btn) {
  return paused ? pausePipeline(id, btn) : resumePipeline(id, btn);
}

async function stopPipeline(id, btn) {
  if (!confirm(`Stop the active execution of pipeline "${id}"?\n\nThis will gracefully terminate the current run (and kill any background jobs that don't respond to the abort signal within a few seconds). Checkpoints for completed stages will be preserved so you can Resume from Checkpoint later.`)) return;
  try {
    await withActionFeedback(id, 'Stop', btn,
      gtss.fetchJSON(`/api/pipelines/${id}/stop`, { method: 'POST' })
    );
  } catch (_) { /* error already shown */ }
}

async function retryStage(id, stage, executionId, btn) {
  try {
    await withActionFeedback(id, 'Retry Stage', btn,
      gtss.fetchJSON(`/api/pipelines/${id}/retry-stage`, {
        method: 'POST',
        body: JSON.stringify({ stage, executionId }),
      })
    );
  } catch (_) { /* error already shown */ }
}

async function resumeFromCheckpoint(id, executionId, btn) {
  // No confirm — this is a non-destructive recovery action, and the
  // server's response will tell the user what happened. Adding a
  // confirm dialog here was the original "buttons don't work" complaint
  // (the user would click the button, see a dialog, click OK, and then
  // nothing visible would happen because the action was async).
  try {
    // We send `force: true` so that if there's a stuck "running" execution
    // in memory (the user's main complaint: pipeline shows Running forever
    // even though no real work is happening), the server will clear it
    // first and then proceed with the resume. This avoids the previous
    // "Another execution is already running" dead-end.
    await withActionFeedback(id, 'Resume from Checkpoint', btn,
      gtss.fetchJSON(`/api/pipelines/${id}/resume-from-checkpoint`, {
        method: 'POST',
        body: JSON.stringify({ executionId, force: true }),
      })
    );
  } catch (_) { /* error already shown */ }
}

/**
 * Force-clear a stuck execution.
 *
 * Use this when a pipeline shows "Running" forever but no real progress is
 * being made (the runner died without ever calling markExecutionFailed /
 * markExecutionCompleted). After force-clearing, the user can immediately
 * Run / Retry / Resume.
 *
 * The backend now:
 *   - Kills any registered jobRegistry jobs for this pipeline.
 *   - Marks ALL stuck DB rows as 'failed' (not just the latest one).
 *   - Clears the schedule-level pause flag, so subsequent runs work.
 *   - Returns detailed info about what was cleared.
 */
async function forceClearPipeline(id, btn) {
  if (!confirm(`Force-clear pipeline "${id}"?\n\nThis will:\n  • Mark the current execution (and any stuck DB rows) as 'failed'\n  • Kill any background jobs registered for this pipeline\n  • Clear the pause flag\n  • Reset the pipeline to idle so you can Run / Retry / Resume\n\nUse this when the pipeline is stuck on "Running" forever and Retry / Resume / Stop are all refusing to work.`)) return;
  try {
    await withActionFeedback(id, 'Force Clear', btn,
      gtss.fetchJSON(`/api/pipelines/${id}/force-clear`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'manual-ui' }),
      })
    );
  } catch (_) { /* error already shown */ }
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

function renderPipelines(pipelines) {
  const container = document.getElementById('pipelines-container');
  if (!container) return;

  if (!pipelines || pipelines.length === 0) {
    // Always OK to show empty state — there are no form fields to lose.
    container.innerHTML = gtss.renderEmptyState(null, 'No pipelines configured.');
    return;
  }

  // ── Anti-flicker path: in-place patch ─────────────────────────────────
  //
  // If the container already has the right number of cards AND none of the
  // pipeline ids have changed, we patch each card in place instead of
  // rebuilding the whole container. This preserves:
  //   - focus on whatever input the user is typing in
  //   - the user's uncommitted form values in the config section
  //   - scroll position (browser handles it naturally because the DOM
  //     nodes aren't being recreated)
  //   - the expansion state of the <details> sections
  //
  // We only fall back to a full rebuild when the SET of pipelines has
  // changed (e.g., a new pipeline was added on the server) or when the
  // user is NOT currently interacting (so a periodic refresh can pick up
  // structural changes like a changed stage list).
  const existingCards = container.querySelectorAll('[data-pipeline-id]');
  const existingIds = Array.from(existingCards).map((c) => c.dataset.pipelineId);
  const newIds = pipelines.map((p) => p.id);
  const sameSet =
    existingIds.length === newIds.length &&
    newIds.every((id, i) => id === existingIds[i]);

  if (sameSet) {
    // Patch each card in place.
    pipelines.forEach((p) => {
      const card = container.querySelector(`[data-pipeline-id="${p.id}"]`);
      if (!card) return;
      patchPipelineCardInPlace(card, p);
    });
    // The global health strip is independent — always safe to refresh.
    renderGlobalHealthStrip();
    return;
  }

  // ── Full rebuild path ─────────────────────────────────────────────────
  //
  // Either this is the first render, or the set of pipelines changed.
  // Before replacing, snapshot any in-flight form values per-card so we
  // can restore them after the rebuild (the user might have been mid-edit
  // when a new pipeline appeared).
  const savedFormValues = {};
  existingCards.forEach((card) => {
    const id = card.dataset.pipelineId;
    savedFormValues[id] = readCardFormValues(card);
  });

  // Preserve scroll position — innerHTML reset will reset it otherwise.
  const scrollY = window.scrollY;

  container.innerHTML = pipelines.map(renderPipelineCard).join('');
  attachCardListeners();

  // Restore form values for any card that survived the rebuild.
  pipelines.forEach((p) => {
    if (savedFormValues[p.id]) {
      const card = container.querySelector(`[data-pipeline-id="${p.id}"]`);
      applyCardFormValues(card, savedFormValues[p.id]);
    }
  });

  // Restore scroll. Avoid smooth — instant is what the user expects when
  // they didn't initiate a scroll.
  window.scrollTo(0, scrollY);
}

/**
 * Patch the dynamic parts of a pipeline card in place, using the
 * data-slot anchors emitted by renderPipelineCard().
 *
 * What counts as "dynamic" (worth re-rendering on every refresh):
 *   - status badge (state can change idle → running → completed)
 *   - progress section (progress %, current message, current stage)
 *   - stage pills (which stages are done / active / failed)
 *   - dynamic banners (failed-stage / running / likely-stuck)
 *   - health section (only if its <details> is open)
 *   - footer "last run / next run / runs" counters
 *
 * What is NOT patched (preserved as-is):
 *   - the entire "Schedule & Configuration" <details> section (cron input,
 *     limit inputs, platform checkboxes) — so the user's unsaved changes
 *     and focus survive
 *   - the <details> open/closed state
 *   - the toggle switch (unless enabled state changed)
 *
 * If any expected slot is missing (e.g., the card was rendered by an
 * older version of renderPipelineCard), we bail out and let the caller
 * fall back to a full re-render.
 */
function patchPipelineCardInPlace(card, pipeline, opts = {}) {
  if (!card || !pipeline) return false;

  const meta = PIPELINE_META[pipeline.id] || {};
  const enabled = Boolean(pipeline.enabled);
  const displayStatus = pipeline.state || (pipeline.paused ? 'paused' : pipeline.last_status) || (enabled ? 'idle' : 'disabled');
  const hasFailedStage = pipeline.state === 'failed';
  const isRunningLike = ['running', 'stopping', 'resuming', 'retrying'].includes(displayStatus);

  // 1. Status badge.
  const badgeSlot = card.querySelector('[data-slot="status-badge"]');
  if (badgeSlot) {
    badgeSlot.innerHTML = statusBadge(displayStatus);
  }

  // 1b. Card border + running class — visual signal that the pipeline is live.
  const targetBorderColor = isRunningLike ? '#22c55e' : (meta.color || '#94a3b8');
  card.style.borderLeftColor = targetBorderColor;
  if (isRunningLike) card.classList.add('pipeline-card--running');
  else card.classList.remove('pipeline-card--running');

  // 2. Toggle switch state (only patch if changed — preserves click handler).
  const toggleInput = card.querySelector('[data-toggle-pipeline]');
  if (toggleInput && toggleInput.checked !== enabled) {
    toggleInput.checked = enabled;
    const slider = toggleInput.parentElement.querySelector('.pipeline-toggle-slider');
    if (slider) {
      slider.style.background = enabled ? '#22c55e' : 'rgba(148,163,184,0.3)';
      slider.style.boxShadow = enabled ? '0 0 12px rgba(34,197,94,0.3)' : 'none';
      const knob = slider.querySelector('span');
      if (knob) {
        // Reset both, then set the side that should be 3px.
        knob.style.left = enabled ? '' : '3px';
        knob.style.right = enabled ? '3px' : '';
      }
    }
  }

  // 3. Progress section.
  const progressSlot = card.querySelector('[data-slot="progress-section"]');
  if (progressSlot) {
    progressSlot.innerHTML = renderProgressSection(pipeline);
  }

  // 4. Stage pills.
  const stageSlot = card.querySelector('[data-slot="stage-progress"]');
  if (stageSlot) {
    stageSlot.innerHTML = renderStageProgress(meta, pipeline);
  }

  // 5. Dynamic banners (failed-stage / running / likely-stuck).
  const bannersSlot = card.querySelector('[data-slot="dynamic-banners"]');
  if (bannersSlot) {
    const newHtml = renderDynamicBanners(pipeline, displayStatus, hasFailedStage);
    // Only swap if the content actually changed — avoids nuking
    // freshly-attached click handlers on action buttons inside the
    // banners when the state hasn't moved.
    if (bannersSlot.dataset.signature !== String(newHtml).length) {
      bannersSlot.innerHTML = newHtml;
      bannersSlot.dataset.signature = String(newHtml).length;
      // Re-attach action listeners for the freshly-inserted buttons.
      attachActionBtnListeners(bannersSlot);
    }
  }

  // 6. Footer counters (last run / next / runs).
  const footerSlot = card.querySelector('[data-slot="footer-stats"]');
  if (footerSlot) {
    footerSlot.innerHTML = `
      <span>Last run: <strong style="color:#94a3b8">${formatRelative(pipeline.last_run_at)}</strong></span>
      <span>Next: <strong style="color:#94a3b8">${pipeline.enabled ? formatRelative(pipeline.next_run_at) : 'Disabled'}</strong></span>
      <span>Runs: <strong style="color:#94a3b8">${pipeline.run_count || 0}</strong></span>
    `;
  }

  // 7. Health section (only if the <details> is open — otherwise no need
  // to re-render something the user can't see, and it would just waste
  // CPU on a page that already has too many cards re-rendering).
  const healthSlot = card.querySelector('[data-health-section]');
  if (healthSlot) {
    const details = healthSlot.closest('details');
    if (details && details.open) {
      healthSlot.innerHTML = renderHealthSection(pipeline);
    }
  }

  // 8. Action buttons — re-render the row so labels (Start ↔ Running… ↔
  //    Stopping…) and disabled state (Run disabled while running, Stop
  //    enabled while running) stay in sync with the live pipeline state.
  //    This was the single biggest UX complaint: after clicking Run, the
  //    button stayed labelled "Run Now" and re-enabled, so the user had
  //    no idea whether the pipeline was actually running.
  const actionsSlot = card.querySelector('[data-slot="action-buttons"]');
  if (actionsSlot) {
    // Find the button currently in a loading state (if any) so we don't
    // clobber its spinner while the fetch is still in flight.
    const loadingBtn = actionsSlot.querySelector('[data-gtss-loading="1"]');
    const preserveLoadingAction = loadingBtn ? loadingBtn.dataset.action : null;

    const newActionsHtml = renderActionButtons(pipeline);
    actionsSlot.innerHTML = newActionsHtml;
    attachActionBtnListeners(actionsSlot);

    // If we just nuked a button that was mid-fetch, restore its loading
    // appearance on the freshly-rendered counterpart so the spinner
    // doesn't vanish mid-click.
    if (preserveLoadingAction && opts && opts.preserveLoadingButton) {
      const freshBtn = actionsSlot.querySelector(`[data-action="${preserveLoadingAction}"]`);
      if (freshBtn) {
        freshBtn.disabled = true;
        freshBtn.dataset.gtssLoading = '1';
        freshBtn.dataset.originalHtml = freshBtn.innerHTML;
        freshBtn.innerHTML = `<span class="spinner" style="display:inline-block;animation:spin 1.4s linear infinite">⟳</span> ${freshBtn.innerHTML}`;
        freshBtn.style.opacity = '0.7';
        // Rewire the original button reference so the finally block in
        // withActionFeedback still clears the right element.
        // (We can't reassign the const, but we can transplant its dataset
        //  and let the finally block operate on the new button by id.)
        opts.preserveLoadingButton.dataset.action = preserveLoadingAction;
      }
    }
  }

  // Note: We deliberately DO NOT touch the "Schedule & Configuration"
  // <details> section here — the user might be mid-edit in the cron input
  // or a limit field. The server-side values will be reconciled the next
  // time the user clicks Save.

  return true;
}

/**
 * Attach click listeners to .pipeline-action-btn buttons inside a scope.
 * Used after patching the dynamic-banners slot, because innerHTML
 * replacement strips the listeners that attachCardListeners() originally
 * wired up. Other listeners (toggle, cron preset, details summary) are
 * NOT re-attached here because they live outside the patched slots.
 */
function attachActionBtnListeners(scope) {
  if (!scope) return;
  scope.querySelectorAll('.pipeline-action-btn').forEach((btn) => {
    if (btn.dataset.gtssBound === '1') return;
    btn.dataset.gtssBound = '1';
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      const action = btn.dataset.action;
      const id = btn.dataset.pipeline;
      const stage = btn.dataset.stage;
      if (action === 'run') runNow(id, btn);
      else if (action === 'restart') restartPipeline(id, btn);
      else if (action === 'executions') loadExecutions(id);
      else if (action === 'logs') openLogsModal(id);
      else if (action === 'pause') pausePipeline(id, btn);
      else if (action === 'resume') resumePipeline(id, btn);
      else if (action === 'stop') stopPipeline(id, btn);
      else if (action === 'retry-stage') retryStage(id, stage || null, null, btn);
      else if (action === 'resume-checkpoint') resumeFromCheckpoint(id, null, btn);
      else if (action === 'force-clear') forceClearPipeline(id, btn);
      else if (action === 'save') savePipeline(id);
    });
    btn.addEventListener('mouseenter', () => { btn.style.transform = 'translateY(-1px)'; btn.style.opacity = '0.9'; });
    btn.addEventListener('mouseleave', () => { btn.style.transform = 'translateY(0)'; btn.style.opacity = '1'; });
  });
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
      if (action === 'run') runNow(id, btn);
      else if (action === 'restart') restartPipeline(id, btn);
      else if (action === 'executions') loadExecutions(id);
      else if (action === 'logs') openLogsModal(id);
      else if (action === 'pause') pausePipeline(id, btn);
      else if (action === 'resume') resumePipeline(id, btn);
      else if (action === 'stop') stopPipeline(id, btn);
      else if (action === 'retry-stage') retryStage(id, stage || null, null, btn);
      else if (action === 'resume-checkpoint') resumeFromCheckpoint(id, null, btn);
      else if (action === 'force-clear') forceClearPipeline(id, btn);
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
                <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
                  <button type="button" class="pipeline-action-btn" data-action="retry-stage-detail" data-pipeline="${pipelineId}" data-exec="${execution.id}" data-stage="${execution.failed_stage}"
                    style="${actionStyle({ border: 'rgba(167,139,250,0.3)', bg: 'rgba(167,139,250,0.1)', text: '#a78bfa' }, true)}">↻ Retry Failed Step (${execution.failed_stage})</button>
                  <button type="button" class="pipeline-action-btn" data-action="resume-checkpoint-detail" data-pipeline="${pipelineId}" data-exec="${execution.id}"
                    style="${actionStyle({ border: 'rgba(34,197,94,0.3)', bg: 'rgba(34,197,94,0.1)', text: '#4ade80' }, true)}">⏵ Resume from Checkpoint</button>
                  <button type="button" class="pipeline-action-btn" data-action="force-clear-detail" data-pipeline="${pipelineId}"
                    style="${actionStyle({ border: 'rgba(248,113,113,0.4)', bg: 'rgba(248,113,113,0.12)', text: '#f87171' }, true)}" title="Force-clear any stuck execution so a new run can start">✕ Force Clear Stuck Run</button>
                </div>
              ` : `
                <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
                  <button type="button" class="pipeline-action-btn" data-action="retry-stage-detail" data-pipeline="${pipelineId}" data-exec="${execution.id}" data-stage=""
                    style="${actionStyle({ border: 'rgba(167,139,250,0.3)', bg: 'rgba(167,139,250,0.1)', text: '#a78bfa' }, true)}" title="Retry from the first stage (no failed_stage was recorded)">↻ Retry from Start</button>
                  <button type="button" class="pipeline-action-btn" data-action="resume-checkpoint-detail" data-pipeline="${pipelineId}" data-exec="${execution.id}"
                    style="${actionStyle({ border: 'rgba(34,197,94,0.3)', bg: 'rgba(34,197,94,0.1)', text: '#4ade80' }, true)}">⏵ Resume from Checkpoint</button>
                  <button type="button" class="pipeline-action-btn" data-action="force-clear-detail" data-pipeline="${pipelineId}"
                    style="${actionStyle({ border: 'rgba(248,113,113,0.4)', bg: 'rgba(248,113,113,0.12)', text: '#f87171' }, true)}" title="Force-clear any stuck execution so a new run can start">✕ Force Clear Stuck Run</button>
                </div>
              `}
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
      const stage = btn.dataset.stage || null;
      retryStage(pid, stage, eid, btn);
      overlay.remove();
    });
  });
  overlay.querySelectorAll('[data-action="resume-checkpoint-detail"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const pid = btn.dataset.pipeline;
      const eid = btn.dataset.exec;
      resumeFromCheckpoint(pid, eid, btn);
      overlay.remove();
    });
  });
  overlay.querySelectorAll('[data-action="force-clear-detail"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const pid = btn.dataset.pipeline;
      forceClearPipeline(pid, btn);
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

// Debounce rapid socket events so a flurry of progress/status updates doesn't
// trigger dozens of concurrent /api/pipelines reloads. The previous behavior
// called loadPipelines() on EVERY progress event AND every status event,
// which caused UI flicker and re-renders while the user was mid-click or
// mid-typing — losing the caret, dropping in-flight keystrokes, and yanking
// focus back to a freshly-rebuilt button.
//
// Strategy:
//   - pipeline:progress events do an IMMEDIATE in-place patch of just the
//     progress section + stage pills + status badge. No fetch, no full
//     reload. This gives snappy UX without disturbing form fields.
//   - pipeline:status events still trigger a debounced full reload, but
//     the reload itself goes through renderPipelines() which now prefers
//     in-place patching when the set of pipelines hasn't changed — so even
//     a status event mid-typing won't disturb the user's form values.
//   - Both event types coalesce so at most one reload is in flight per
//     800ms.
let progressReloadTimer = null;
function scheduleProgressReload() {
  if (progressReloadTimer) return;
  progressReloadTimer = setTimeout(() => {
    progressReloadTimer = null;
    // loadPipelines() now does in-place patching when possible — so this
    // is cheap and non-destructive even if the user is mid-typing.
    loadPipelines();
  }, 800);
}

/**
 * Apply a pipeline:progress socket event as an immediate in-place patch
 * to the affected card. This gives the user instant feedback (progress
 * bar moves, current message updates) without waiting for the debounced
 * reload. We update the cached pipelinesData entry first, then call
 * patchPipelineCardInPlace() to refresh just the dynamic slots.
 */
function applyProgressEventInPlace({ pipeline_id, execution_id, stage, message, progress, completed_steps, total_steps }) {
  if (!pipeline_id) return;
  const pipeline = pipelinesData.find((p) => p.id === pipeline_id);
  if (!pipeline) {
    // Card not yet rendered — let the debounced reload pick it up.
    scheduleProgressReload();
    return;
  }
  // Update the cached entry in place so the next full reload sees the
  // freshest values too.
  if (stage !== undefined) pipeline.current_stage = stage;
  if (message !== undefined) pipeline.current_message = message;
  if (progress !== undefined) pipeline.progress = progress;
  if (completed_steps !== undefined) pipeline.completed_steps = completed_steps;
  if (total_steps !== undefined) pipeline.total_steps = total_steps;
  if (execution_id !== undefined) pipeline.active_execution_id = execution_id;
  if (progress !== undefined && pipeline.state !== 'failed' && pipeline.state !== 'paused') {
    // If progress is moving and we weren't already marked running, mark
    // running now — the in-place patch will reflect it in the status badge.
    if (progress > 0 && progress < 100 && pipeline.state !== 'running') {
      pipeline.state = 'running';
    }
  }

  // Patch the card in place. The patcher is non-destructive — it only
  // touches the dynamic slots (status badge, progress, stages, banners,
  // footer) and leaves form fields alone. So this is safe to call while
  // the user is typing.
  const card = document.querySelector(`[data-pipeline-id="${pipeline_id}"]`);
  if (card) {
    patchPipelineCardInPlace(card, pipeline);
  }
  // Also refresh the global health strip — progress events don't change
  // health metrics, but the live dot state might.
  renderGlobalHealthStrip();
}

function initPipelineSocket() {
  const sub = gtss.initSocket({
    'pipeline:status': ({ id, status, state, error, last_run_at }) => {
      if (!id) return;
      // Coalesce rapid status events into a single debounced reload. The
      // reload itself is non-destructive (in-place patch when possible),
      // but we still don't want 5 of them firing in 200ms.
      scheduleProgressReload();
      if (status === 'completed') {
        gtss.showToast(`Pipeline "${id}" completed successfully`, 'success');
      } else if (status === 'failed') {
        const errMsg = error || 'unknown error';
        gtss.showToast(`Pipeline "${id}" failed: ${errMsg}`, 'error', 8000);
        showPipelineActionInfo(id, 'Pipeline Failed', errMsg, 'warn');
      } else if (state === 'paused') {
        gtss.showToast(`Pipeline "${id}" paused`, 'info');
      } else if (state === 'resuming' || status === 'resumed') {
        gtss.showToast(`Pipeline "${id}" resuming…`, 'info');
      } else if (state === 'stopped') {
        gtss.showToast(`Pipeline "${id}" stopped`, 'info');
      }
    },
    'pipeline:progress': (payload) => {
      // Immediate in-place patch for snappy UX — no fetch, no full reload.
      applyProgressEventInPlace(payload);
      // Also schedule a debounced reload to pick up anything the in-place
      // patch couldn't update (e.g., new health metrics, completion of
      // adjacent pipelines).
      scheduleProgressReload();
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

  // Polling fallback: refresh pipelines every 15 seconds as a safety net.
  // The previous 8s interval was too aggressive — combined with socket
  // events it caused the page to re-render twice in quick succession,
  // which the user perceived as "flickering while typing". Now we poll
  // less aggressively (15s) and rely on the socket for instant updates.
  // The polling itself is non-destructive (in-place patch) so even when
  // it does fire mid-typing, the user won't notice.
  //
  // If the socket connection drops, the user still gets updates within
  // 15s — acceptable for a defensive fallback.
  setInterval(loadPipelines, 15_000);
});
