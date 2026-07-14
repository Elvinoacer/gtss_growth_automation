/**
 * pipelines/feedback.js — Inline banners, action feedback, and button
 * loading/success/error state helpers.
 *
 * These complement the pipeline action handlers (run / pause / resume / stop /
 * save / etc.) by giving the user unambiguous visual confirmation that their
 * click was registered and either succeeded or failed.
 */

/* global gtss */

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

// ── Button-level feedback helpers ───────────────────────────────────────────
//
// These complement withActionFeedback() for the buttons that don't go through
// it (Save, toggle, History, Logs, cron presets). They give the user an
// immediate, unambiguous visual signal that their click was registered and
// either succeeded or failed — exactly the "visual confirmation" that was
// missing on the Pipeline page.

/**
 * Briefly show a success state on a button ("✓ <label>") so the user sees
 * a concrete confirmation that the action completed, instead of the button
 * just silently snapping back to its default label.
 *
 * After `durationMs` the original innerHTML is restored.
 *
 * Safe to call on a button that has already been restored by
 * withActionFeedback's finally block — this just layers a transient
 * success flash on top.
 */
function showButtonSuccess(btn, label = 'Done', durationMs = 1400) {
  if (!btn) return;
  const prev = btn.innerHTML;
  const prevClass = btn.className;
  const prevBorder = btn.style.borderColor;
  const prevBg = btn.style.background;
  const prevColor = btn.style.color;

  btn.classList.add('pipeline-btn--success');
  btn.style.borderColor = 'rgba(34,197,94,0.5)';
  btn.style.background = 'rgba(34,197,94,0.16)';
  btn.style.color = '#4ade80';
  btn.innerHTML = `<span aria-hidden="true">✓</span> ${gtss.escapeHtml(label)}`;

  setTimeout(() => {
    btn.classList.remove('pipeline-btn--success');
    btn.innerHTML = prev;
    btn.className = prevClass;
    btn.style.borderColor = prevBorder;
    btn.style.background = prevBg;
    btn.style.color = prevColor;
  }, durationMs);
}

/**
 * Wrap a plain button click in: loading spinner → (await fn) → success
 * pulse or error toast. This is the lightweight sibling of
 * withActionFeedback() for actions that don't need the optimistic-state
 * patch or the inline error banner (e.g. Save, History, Logs, Refresh).
 *
 * @param {HTMLElement} btn  - the clicked button
 * @param {string} actionLabel - human label for error messages
 * @param {Function} fn - async function returning the result
 * @param {object} [opts]
 * @param {string} [opts.successLabel] - label for the transient success state
 * @param {boolean} [opts.silent] - if true, don't show a toast on error (caller handles it)
 * @returns {Promise<*>} result of fn
 */
async function withButtonFeedback(btn, actionLabel, fn, opts = {}) {
  const { successLabel = 'Done', silent = false } = opts;
  if (btn && !btn.disabled) {
    btn.disabled = true;
    btn.dataset.originalHtml = btn.innerHTML;
    btn.dataset.gtssLoading = '1';
    btn.classList.add('pipeline-btn--loading');
    btn.innerHTML = `<span class="spinner" style="display:inline-block;animation:spin 1.4s linear infinite">⟳</span> ${btn.innerHTML}`;
    btn.style.opacity = '0.7';
  }
  let succeeded = false;
  try {
    const result = await fn();
    succeeded = true;
    if (btn) {
      // Restore first, then layer the success flash on the default look.
      btn.innerHTML = btn.dataset.originalHtml || btn.innerHTML;
      delete btn.dataset.originalHtml;
      delete btn.dataset.gtssLoading;
      btn.classList.remove('pipeline-btn--loading');
      btn.style.opacity = '';
      btn.disabled = false;
      showButtonSuccess(btn, successLabel, 1400);
    }
    return result;
  } catch (err) {
    if (btn) {
      btn.innerHTML = btn.dataset.originalHtml || btn.innerHTML;
      delete btn.dataset.originalHtml;
      delete btn.dataset.gtssLoading;
      btn.classList.remove('pipeline-btn--loading');
      btn.style.opacity = '';
      btn.disabled = false;
      // Brief error flash so the user sees the button "rejected" the click.
      btn.classList.add('pipeline-btn--error');
      setTimeout(() => btn.classList.remove('pipeline-btn--error'), 900);
    }
    if (!silent) {
      gtss.showToast(`${actionLabel} failed: ${err?.message || err}`, 'error', 7000);
    }
    throw err;
  }
}
