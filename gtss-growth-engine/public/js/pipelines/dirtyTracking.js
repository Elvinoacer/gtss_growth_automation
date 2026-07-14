/**
 * pipelines/dirtyTracking.js — Dirty-state tracking for the Save button.
 *
 * When the user edits the cron expression, a limit field, or a platform
 * checkbox, the Save button gets a "dirty" indicator (a small pulsing dot)
 * so it's obvious there are unsaved changes. The indicator clears on a
 * successful save.
 *
 * This directly addresses the user's complaint that there was no visual
 * confirmation of state — previously the Save button looked identical
 * whether or not there were pending changes, so the user had no way to
 * know whether they needed to click it.
 */

/* global gtss */

function getCardSaveBtn(card) {
  if (!card) return null;
  return card.querySelector('[data-action="save"]');
}

function markCardDirty(card, isDirty) {
  if (!card) return;
  const btn = getCardSaveBtn(card);
  if (!btn) return;
  if (isDirty) {
    card.dataset.dirty = '1';
    btn.classList.add('pipeline-save-btn--dirty');
    btn.title = 'You have unsaved changes — click to save them.';
  } else {
    delete card.dataset.dirty;
    btn.classList.remove('pipeline-save-btn--dirty');
    btn.title = 'Save changes';
  }
}

/**
 * Snapshot the "clean" form values for a card right after render / save,
 * so we can compare against the live values to detect dirtiness.
 */
function snapshotCardCleanValues(card) {
  if (!card) return;
  const snap = { cron: null, limits: {}, platforms: {}, perPlatform: {} };
  const cronInput = card.querySelector('[data-field="cron"]');
  if (cronInput) snap.cron = cronInput.value;
  card.querySelectorAll('[data-limit-key]').forEach((el) => {
    snap.limits[el.dataset.limitKey] = el.type === 'number' ? Number(el.value) : el.value;
  });
  card.querySelectorAll('[data-platform-checkbox]').forEach((cb) => {
    snap.platforms[cb.dataset.platformCheckbox] = cb.checked;
  });
  card.querySelectorAll('[data-per-platform-key]').forEach((el) => {
    const key = el.dataset.perPlatformKey;
    const platform = el.dataset.platform;
    if (!snap.perPlatform[key]) snap.perPlatform[key] = {};
    snap.perPlatform[key][platform] = Number(el.value) || 0;
  });
  card.__gtssCleanSnapshot = snap;
}

/**
 * Compare the live form values of a card against the snapshot taken by
 * snapshotCardCleanValues(), and mark the card dirty/clean accordingly.
 */
function recheckCardDirty(card) {
  if (!card || !card.__gtssCleanSnapshot) return;
  const snap = card.__gtssCleanSnapshot;
  let dirty = false;
  const cronInput = card.querySelector('[data-field="cron"]');
  if (cronInput && cronInput.value !== snap.cron) dirty = true;
  if (!dirty) {
    card.querySelectorAll('[data-limit-key]').forEach((el) => {
      const v = el.type === 'number' ? Number(el.value) : el.value;
      if (snap.limits[el.dataset.limitKey] !== v) dirty = true;
    });
  }
  if (!dirty) {
    card.querySelectorAll('[data-platform-checkbox]').forEach((cb) => {
      if (snap.platforms[cb.dataset.platformCheckbox] !== cb.checked) dirty = true;
    });
  }
  if (!dirty) {
    card.querySelectorAll('[data-per-platform-key]').forEach((el) => {
      const key = el.dataset.perPlatformKey;
      const platform = el.dataset.platform;
      const v = Number(el.value) || 0;
      if (!snap.perPlatform[key] || snap.perPlatform[key][platform] !== v) dirty = true;
    });
  }
  markCardDirty(card, dirty);
}

/**
 * Attach input/change listeners to every config field inside a card so
 * dirtiness is detected the moment the user edits anything. Called after
 * every full re-render (attachCardListeners) and is idempotent.
 */
function attachDirtyTracking(card) {
  if (!card || card.__gtssDirtyBound === '1') return;
  card.__gtssDirtyBound = '1';
  const fields = card.querySelectorAll('[data-field="cron"], [data-limit-key], [data-platform-checkbox], [data-per-platform-key]');
  fields.forEach((f) => {
    const evt = f.type === 'checkbox' ? 'change' : 'input';
    f.addEventListener(evt, () => recheckCardDirty(card));
  });
}
