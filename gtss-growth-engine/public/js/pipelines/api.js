/**
 * pipelines/api.js — Backend API calls + pipeline action handlers.
 *
 * Each action (run / restart / pause / resume / stop / retry / resume-from-
 * checkpoint / force-clear / save / toggle / loadExecutions / loadLogs)
 * wraps its fetch in withActionFeedback() or withButtonFeedback() so the
 * user gets loading spinners, success flashes, and inline error banners.
 */

/* global gtss */

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

  const saveBtn = getCardSaveBtn(card);

  const cronInput = card.querySelector('[data-field="cron"]');
  const payload = { cron: cronInput ? cronInput.value : undefined };

  const limits = {};
  card.querySelectorAll('[data-limit-key]').forEach(el => {
    const key = el.dataset.limitKey;
    limits[key] = el.type === 'number' ? Number(el.value) : el.value;
  });

  // Collect per-platform fields (e.g. max_follows_per_platform) into a single
  // object keyed by the data-per-platform-key attribute.
  const perPlatformGroups = {};
  card.querySelectorAll('[data-per-platform-key]').forEach(el => {
    const key = el.dataset.perPlatformKey;
    const platform = el.dataset.platform;
    if (!perPlatformGroups[key]) perPlatformGroups[key] = {};
    perPlatformGroups[key][platform] = Number(el.value) || 0;
  });
  for (const [key, value] of Object.entries(perPlatformGroups)) {
    limits[key] = value;
  }

  if (id === 'outreach' || id === 'content' || id === 'dm_check' || id === 'mass_follow') {
    const checked = [];
    card.querySelectorAll('[data-platform-checkbox]').forEach(cb => {
      if (cb.checked) checked.push(cb.dataset.platformCheckbox);
    });
    limits.platforms = checked;
  }

  payload.limits = limits;

  // Validate cron expression client-side so we can give immediate feedback
  // (a red error flash on the Save button + a toast) instead of waiting
  // for the server round-trip. A cron field with visible content but no
  // tokens is almost certainly a mistake.
  if (payload.cron != null && payload.cron.trim() !== '' && payload.cron.trim().split(/\s+/).length < 5) {
    gtss.showToast('Cron expression needs 5 fields (min hour day month weekday).', 'error', 6000);
    if (saveBtn) {
      saveBtn.classList.add('pipeline-btn--error');
      setTimeout(() => saveBtn.classList.remove('pipeline-btn--error'), 900);
    }
    return;
  }

  try {
    const result = await withButtonFeedback(saveBtn, 'Save', () =>
      gtss.fetchJSON(`/api/pipelines/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      })
    , { successLabel: 'Saved', silent: true });
    if (result.ok) {
      gtss.showToast('Pipeline settings saved', 'success');
      // Clear dirty state immediately AND re-snapshot the clean values
      // from the inputs as they are now (== what the user just saved).
      // Without the re-snapshot, the next in-place patch would compare
      // the live inputs against the pre-save snapshot and falsely flag
      // the card as dirty again.
      markCardDirty(card, false);
      snapshotCardCleanValues(card);
      loadPipelines();
    } else {
      // Server returned a non-ok body without throwing.
      const msg = result.error || 'Save failed';
      gtss.showToast(msg, 'error', 6000);
    }
  } catch (err) {
    // withButtonFeedback already flashed the error state; show the toast here
    // with the full server message (which may include a hint).
    gtss.showToast(err?.message || 'Save failed', 'error', 6000);
  }
}

async function togglePipeline(id, enabled) {
  // The toggle switch flips visually the instant the user clicks it (native
  // checkbox behavior). We need to give the user feedback that the change
  // is being persisted, and — critically — revert the switch if the
  // server rejects the change. Without the revert, the UI would lie about
  // the pipeline's enabled state.
  const card = document.querySelector(`[data-pipeline-id="${id}"]`);
  const toggleInput = card?.querySelector(`[data-toggle-pipeline="${id}"]`);
  const slider = toggleInput?.parentElement?.querySelector('.pipeline-toggle-slider');

  // Mark the toggle as "pending" so the slider shows a spinner overlay
  // and the user knows the request is in flight.
  if (slider) slider.classList.add('pipeline-toggle--pending');

  // Optimistically update the visual style of the slider to match the new state
  if (slider) {
    slider.style.background = enabled ? '#22c55e' : 'rgba(148,163,184,0.3)';
    slider.style.boxShadow = enabled ? '0 0 12px rgba(34,197,94,0.3)' : 'none';
    const knob = slider.querySelector('span');
    if (knob) {
      knob.style.left = enabled ? '' : '3px';
      knob.style.right = enabled ? '3px' : '';
    }
  }

  try {
    const result = await gtss.fetchJSON(`/api/pipelines/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    });
    if (result.ok) {
      gtss.showToast(`Pipeline ${enabled ? 'enabled' : 'disabled'}`, enabled ? 'success' : 'info');
      loadPipelines();
    } else {
      // Server returned a non-ok body — revert the switch.
      throw new Error(result.error || 'Toggle failed');
    }
  } catch (err) {
    // Revert the checkbox to its previous state so the UI doesn't lie.
    if (toggleInput) toggleInput.checked = !enabled;
    // Re-render the slider visuals to match the reverted state.
    if (slider) {
      slider.style.background = !enabled ? '#22c55e' : 'rgba(148,163,184,0.3)';
      slider.style.boxShadow = !enabled ? '0 0 12px rgba(34,197,94,0.3)' : 'none';
      const knob = slider.querySelector('span');
      if (knob) {
        knob.style.left = !enabled ? '' : '3px';
        knob.style.right = !enabled ? '3px' : '';
      }
    }
    gtss.showToast(`Could not ${enabled ? 'enable' : 'disable'} pipeline: ${err?.message || err}`, 'error', 7000);
  } finally {
    if (slider) {
      // Keep the pending class briefly so the revert animation is visible,
      // then remove it.
      setTimeout(() => slider.classList.remove('pipeline-toggle--pending'), 250);
    }
  }
}

async function runNow(id, btn) {
  // Show a pre-run confirmation modal so the user can review and tweak all
  // settings (including browser visibility) before the pipeline fires.
  const confirmed = await openRunConfirmationModal(id);
  if (!confirmed) return;
  try {
    await withActionFeedback(id, 'Run Now', btn,
      gtss.fetchJSON(`/api/pipelines/${id}/run`, { method: 'POST', body: JSON.stringify(confirmed) })
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
    const confirmed = await gtss.showConfirmDialog({
      title: `Restart "${id}"?`,
      body: `This will stop the current run (if any) and start a fresh execution from the first step. If the pipeline is paused, the pause flag will also be cleared.\n\nCheckpoints from the previous run will be discarded.`,
      confirmLabel: '↻ Restart',
      cancelLabel: 'Cancel',
      danger: true,
      icon: '↻',
    });
    if (!confirmed) return;
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
  const confirmed = await gtss.showConfirmDialog({
    title: `Stop pipeline "${id}"?`,
    body: `This will gracefully terminate the current run (and kill any background jobs that don't respond to the abort signal within a few seconds).\n\nCheckpoints for completed stages will be preserved so you can Resume from Checkpoint later.`,
    confirmLabel: '■ Stop',
    cancelLabel: 'Cancel',
    danger: true,
    icon: '■',
  });
  if (!confirmed) return;
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
  const confirmed = await gtss.showConfirmDialog({
    title: `Force-clear pipeline "${id}"?`,
    body: `This will:\n  • Mark the current execution (and any stuck DB rows) as 'failed'\n  • Kill any background jobs registered for this pipeline\n  • Clear the pause flag\n  • Reset the pipeline to idle so you can Run / Retry / Resume\n\nUse this when the pipeline is stuck on "Running" forever and Retry / Resume / Stop are all refusing to work.`,
    confirmLabel: '✕ Force Clear',
    cancelLabel: 'Cancel',
    danger: true,
    icon: '⚠',
  });
  if (!confirmed) return;
  try {
    await withActionFeedback(id, 'Force Clear', btn,
      gtss.fetchJSON(`/api/pipelines/${id}/force-clear`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'manual-ui' }),
      })
    );
  } catch (_) { /* error already shown */ }
}

async function loadExecutions(id, btn) {
  // Use withButtonFeedback so the History button shows a spinner while we
  // fetch, then a brief success flash. Previously the button gave no
  // feedback at all — the user clicked and had to wait and hope.
  try {
    await withButtonFeedback(btn, 'Load history', () =>
      gtss.fetchJSON(`/api/pipelines/${id}/executions?limit=15`)
    , { successLabel: 'Loaded', silent: true }).then((data) => {
      renderExecutionsModal(id, data.executions || []);
    });
  } catch (err) {
    gtss.showToast('Failed to load executions: ' + (err?.message || err), 'error');
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

async function openLogsModal(id, btn) {
  // Show a loading state on the Logs button while we open the modal and
  // fetch the initial batch of logs.
  const root = document.getElementById('pipeline-modal-root');
  root.innerHTML = renderLogsModalShell(id);
  attachLogsModalListeners(id);
  try {
    await withButtonFeedback(btn, 'Load logs', () =>
      loadLogs(id, { limit: 200 })
    , { successLabel: 'Loaded', silent: true }).then((data) => {
      refreshLogsModal(id, data);
    });
  } catch (err) {
    // loadLogs already shows a toast; just clear the modal loading text.
    const list = document.getElementById('logs-list');
    if (list) list.innerHTML = `<div style="padding:24px;text-align:center;color:#f87171">Failed to load logs.</div>`;
  }
}
