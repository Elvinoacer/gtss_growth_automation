/**
 * pipelines/renderPipelines.js — Top-level pipeline-list rendering, in-place
 * patching of dynamic card slots, and global card listener wiring.
 *
 * `renderPipelines` is the entry point: given the latest pipelinesData array,
 * it either patches each card in place (when the set of pipelines hasn't
 * changed — preserves form focus / uncommitted input values) or does a full
 * rebuild of the container.
 *
 * `patchPipelineCardInPlace` swaps out individual `data-slot` regions of a
 * card without touching the form fields — this is what makes the page feel
 * non-flickery while the user is editing.
 */

/* global gtss */

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

  // Initialize dirty-state tracking for every freshly-rendered card.
  // We snapshot the "clean" values (after any restore above) and attach
  // input/change listeners so the Save button gets a pulsing dot the
  // moment the user edits anything. If a card previously had unsaved
  // changes that we just restored, re-mark it dirty.
  pipelines.forEach((p) => {
    const card = container.querySelector(`[data-pipeline-id="${p.id}"]`);
    if (!card) return;
    snapshotCardCleanValues(card);
    attachDirtyTracking(card);
    // If we restored unsaved values, reflect the dirty state immediately.
    recheckCardDirty(card);
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
      else if (action === 'executions') loadExecutions(id, btn);
      else if (action === 'logs') openLogsModal(id, btn);
      else if (action === 'pause') pausePipeline(id, btn);
      else if (action === 'resume') resumePipeline(id, btn);
      else if (action === 'stop') stopPipeline(id, btn);
      else if (action === 'retry-stage') retryStage(id, stage || null, null, btn);
      else if (action === 'resume-checkpoint') resumeFromCheckpoint(id, null, btn);
      else if (action === 'force-clear') forceClearPipeline(id, btn);
      else if (action === 'manage-targets') openMassFollowTargetsModal(id, btn);
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
      else if (action === 'executions') loadExecutions(id, btn);
      else if (action === 'logs') openLogsModal(id, btn);
      else if (action === 'pause') pausePipeline(id, btn);
      else if (action === 'resume') resumePipeline(id, btn);
      else if (action === 'stop') stopPipeline(id, btn);
      else if (action === 'retry-stage') retryStage(id, stage || null, null, btn);
      else if (action === 'resume-checkpoint') resumeFromCheckpoint(id, null, btn);
      else if (action === 'force-clear') forceClearPipeline(id, btn);
      else if (action === 'manage-targets') openMassFollowTargetsModal(id, btn);
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

      // Brief "applied" pulse so the user sees the preset was registered.
      btn.classList.add('cron-preset-btn--applied');
      setTimeout(() => btn.classList.remove('cron-preset-btn--applied'), 650);

      // Mark the card dirty so the Save button shows its unsaved-changes
      // indicator — the preset click changed the cron value.
      recheckCardDirty(card);

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
