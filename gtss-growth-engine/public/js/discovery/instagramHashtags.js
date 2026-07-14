/**
 * discovery/instagramHashtags.js — Instagram discovery strategy panel:
 * hashtag chips, geolocation dropdown, strategy radios, and the debounced
 * hashtag-persistence logic.
 *
 * The Discovery page surfaces an Instagram-specific UI when the user
 * checks the Instagram platform box. The panel supports 4 strategies
 * (hashtag / geolocation / competitor / suggested); this file owns the
 * hashtag-chip portion + the strategy-radio switch logic + the debounced
 * save-back to /api/discovery/keywords.
 *
 * Exposes (via global scope):
 *   - selectedHashtags, defaultHashtags, igKeywordsLoaded,
 *     igHashtagsHydrating, saveHashtagsTimer
 *       — module-private state vars (kept in the global lexical env so the
 *         chip-add/remove handlers can mutate them)
 *   - loadInstagramDiscoveryKeywords() — async; idempotent — fetches the
 *         saved IG config from /api/discovery/keywords and hydrates the
 *         hashtag chips + geolocation <select> + strategy radios
 *   - scheduleHashtagSave()            — debounced (500ms) save trigger;
 *         no-op while igHashtagsHydrating is true (so hydrating default
 *         tags from the server doesn't fire a save back)
 *   - saveInstagramHashtags()          — async; POSTs the current hashtag
 *         snapshot to /api/discovery/keywords (partial instagram update)
 *   - addHashtagChip(tag)              — append a hashtag chip (de-duped,
 *         leading-# stripped), re-render, schedule save
 *   - removeHashtagChip(tag)           — remove a hashtag chip, re-render,
 *         schedule save
 *   - renderHashtagChips()             — re-render the chip container
 *         from `selectedHashtags`
 *
 * Depends on (from discovery/helpers.js, loaded earlier):
 *   - escapeHtml
 * Depends on (from window.gtss, available via app.js):
 *   - fetchJSON, showToast
 */

let selectedHashtags = [];
let defaultHashtags = [];
let igKeywordsLoaded = false;
// True while we are hydrating hashtag chips from the saved config so that the
// chip add/remove handlers don't fire a save back to the server for every
// default tag we restore.
let igHashtagsHydrating = false;
let saveHashtagsTimer = null;

async function loadInstagramDiscoveryKeywords() {
  if (igKeywordsLoaded) return;
  try {
    const data = await window.gtss.fetchJSON("/api/discovery/keywords");

    igHashtagsHydrating = true;
    // 1. Populate Hashtags
    if (data.instagram && Array.isArray(data.instagram.hashtags)) {
      defaultHashtags = data.instagram.hashtags;
      // Populate starting chips from defaults
      defaultHashtags.forEach(tag => {
        addHashtagChip(tag);
      });
    }
    igHashtagsHydrating = false;

    // 2. Populate Geolocation Select Dropdown
    const select = document.getElementById("ig-location-select");
    if (select && data.instagram && Array.isArray(data.instagram.geolocations)) {
      select.innerHTML = data.instagram.geolocations
        .map(loc => `<option value="${loc.id}">${escapeHtml(loc.name)}</option>`)
        .join("");
    }

    // Bind hashtag input
    const hashtagInput = document.getElementById("hashtag-chip-input");
    if (hashtagInput) {
      hashtagInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          addHashtagChip(hashtagInput.value);
          hashtagInput.value = "";
        }
      });
    }

    // Bind strategy radios
    const strategyRadios = document.querySelectorAll('input[name="ig-strategy"]');
    strategyRadios.forEach(radio => {
      radio.addEventListener("change", (e) => {
        const activeStrategy = e.target.value;

        document.getElementById("ig-hashtag-panel").classList.toggle("active", activeStrategy === "hashtag");
        document.getElementById("ig-geolocation-panel").classList.toggle("active", activeStrategy === "geolocation");
        document.getElementById("ig-competitor-panel").classList.toggle("active", activeStrategy === "competitor");
        document.getElementById("ig-suggested-panel").classList.toggle("active", activeStrategy === "suggested");
      });
    });

    igKeywordsLoaded = true;
  } catch (error) {
    igHashtagsHydrating = false;
    console.error("Failed to load Instagram discovery keywords", error);
  }
}

// Debounced (500ms) persistence of the current Instagram hashtag selection.
// POSTs only the instagram.hashtags slice to /api/discovery/keywords — the
// backend route now accepts a partial instagram update without requiring the
// `keywords` array.
function scheduleHashtagSave() {
  if (igHashtagsHydrating) return;
  if (saveHashtagsTimer) clearTimeout(saveHashtagsTimer);
  saveHashtagsTimer = setTimeout(() => {
    saveHashtagsTimer = null;
    saveInstagramHashtags().catch((err) =>
      console.error("saveInstagramHashtags failed", err),
    );
  }, 500);
}

async function saveInstagramHashtags() {
  // Snapshot the array so a rapid add/remove race doesn't POST stale data.
  const snapshot = [...selectedHashtags];
  try {
    await window.gtss.fetchJSON("/api/discovery/keywords", {
      method: "POST",
      body: JSON.stringify({ instagram: { hashtags: snapshot } }),
    });
    // Only show the "saved" toast if the chips still reflect the snapshot we
    // just persisted (otherwise another save is already in flight).
    if (
      saveHashtagsTimer === null &&
      snapshot.length === selectedHashtags.length &&
      snapshot.every((t, i) => selectedHashtags[i] === t)
    ) {
      window.gtss.showToast("✓ Hashtags saved", "success");
    }
  } catch (error) {
    console.error("Failed to save Instagram hashtags", error);
    window.gtss.showToast("Failed to save hashtags", "error");
  }
}

function addHashtagChip(tag) {
  tag = tag.trim().replace(/^#/, "");
  if (!tag || selectedHashtags.includes(tag)) return;
  selectedHashtags.push(tag);
  renderHashtagChips();
  scheduleHashtagSave();
}

function removeHashtagChip(tag) {
  selectedHashtags = selectedHashtags.filter(t => t !== tag);
  renderHashtagChips();
  scheduleHashtagSave();
}

function renderHashtagChips() {
  const container = document.getElementById("hashtag-chip-container");
  const input = document.getElementById("hashtag-chip-input");
  if (!container) return;

  const chipEls = container.querySelectorAll(".chip");
  chipEls.forEach(el => el.remove());

  selectedHashtags.forEach(tag => {
    const span = document.createElement("span");
    span.className = "chip";
    span.innerHTML = `#${escapeHtml(tag)} <span class="chip-remove" data-tag="${escapeHtml(tag)}">✕</span>`;

    span.querySelector(".chip-remove").addEventListener("click", () => {
      removeHashtagChip(tag);
    });

    container.insertBefore(span, input);
  });
}
