/**
 * pipelines/socket.js — Socket.IO live-update handlers for the Pipelines page.
 *
 * Debounce rapid socket events so a flurry of progress/status updates doesn't
 * trigger dozens of concurrent /api/pipelines reloads. The previous behavior
 * called loadPipelines() on EVERY progress event AND every status event,
 * which caused UI flicker and re-renders while the user was mid-click or
 * mid-typing — losing the caret, dropping in-flight keystrokes, and yanking
 * focus back to a freshly-rebuilt button.
 *
 * Strategy:
 *   - pipeline:progress events do an IMMEDIATE in-place patch of just the
 *     progress section + stage pills + status badge. No fetch, no full
 *     reload. This gives snappy UX without disturbing form fields.
 *   - pipeline:status events still trigger a debounced full reload, but
 *     the reload itself goes through renderPipelines() which now prefers
 *     in-place patching when the set of pipelines hasn't changed — so even
 *     a status event mid-typing won't disturb the user's form values.
 *   - Both event types coalesce so at most one reload is in flight per
 *     800ms.
 */

/* global gtss */

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
