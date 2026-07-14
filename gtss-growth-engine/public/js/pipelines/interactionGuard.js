/**
 * pipelines/interactionGuard.js — Anti-flicker focus tracking & form-value
 * snapshot/restore helpers.
 *
 * The page previously rebuilt the entire pipelines container on every
 * Socket.IO event and every 8s poll, which destroyed the focused element
 * while the user was typing — dropping the caret and in-flight keystrokes.
 *
 * To prevent this we:
 *   1. Track whether the user is currently interacting with any form field
 *      inside the pipelines container (focus + 800ms grace period after
 *      blur, so a quick poll doesn't yank focus back).
 *   2. Track whether the user has any "dirty" (unsaved) form values in the
 *      config section of any card. If they do, we NEVER silently overwrite
 *      the inputs — we only patch the dynamic parts (progress bar, status
 *      badge, stage pills, health strip).
 *   3. Patch dynamic parts in place instead of rebuilding the whole card.
 *      This keeps the DOM identity stable so focus, scroll, and uncommitted
 *      input values survive.
 */

/* global gtss */

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
  const vals = { cron: null, limits: {}, platforms: {}, perPlatform: {} };
  const cronInput = card.querySelector('[data-field="cron"]');
  if (cronInput) vals.cron = cronInput.value;
  card.querySelectorAll('[data-limit-key]').forEach((el) => {
    vals.limits[el.dataset.limitKey] = el.type === 'number' ? Number(el.value) : el.value;
  });
  card.querySelectorAll('[data-platform-checkbox]').forEach((cb) => {
    vals.platforms[cb.dataset.platformCheckbox] = cb.checked;
  });
  card.querySelectorAll('[data-per-platform-key]').forEach((el) => {
    const key = el.dataset.perPlatformKey;
    const platform = el.dataset.platform;
    if (!vals.perPlatform[key]) vals.perPlatform[key] = {};
    vals.perPlatform[key][platform] = Number(el.value) || 0;
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
  for (const [key, platformMap] of Object.entries(vals.perPlatform || {})) {
    for (const [platform, value] of Object.entries(platformMap)) {
      const el = card.querySelector(`[data-per-platform-key="${key}"][data-platform="${platform}"]`);
      if (el && el.value !== String(value)) el.value = value;
    }
  }
}
