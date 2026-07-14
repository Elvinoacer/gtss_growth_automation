/* global gtss */
/**
 * automation/domCapture.js — Manual DOM Recorder (DOM checkpoint capture)
 * for the Automation Control page.
 *
 * Pulled verbatim from the original automation.js IIFE (lines 78-164).
 * Includes both the loaders and the top-level event bindings that wire up
 * the DOM-capture panel (the bindings were originally at the bottom of
 * the IIFE, lines 889-892, but they belong with the DOM-capture concern
 * so they live here now).
 *
 * Exposes (via global scope):
 *   - setDomCaptureStatus(message) — sets the DOM-capture status line
 *   - loadDomTabs() — fetches open Chrome tabs for the selected platform
 *     via /api/automation/dom-captures/tabs?platform=
 *   - loadDomCaptures() — lists the most recent saved DOM checkpoints
 *     via /api/automation/dom-captures?limit=12
 *   - saveDomCapture() — POSTs a new checkpoint
 *     via /api/automation/dom-captures
 *
 * Top-level bindings (registered at script-load time, matching the
 * original IIFE behavior):
 *   - domCapturePlatform     "change"       → loadDomTabs
 *   - domCaptureRefreshTabs  "click"        → loadDomTabs
 *   - domCaptureSave         "click"        → saveDomCapture
 *   - domCaptureRefreshList  "click"        → loadDomCaptures
 *
 * Note: the original IIFE also declared a DOM-based `escapeHtml` here at
 * line 86 — it was dead code (overwritten by the regex-based version at
 * line 595, which is now in helpers.js). Not re-declared here.
 */

// ----------------------------------------------------------------
// Manual DOM Recorder
// ----------------------------------------------------------------

function setDomCaptureStatus(message) {
  if (domCaptureStatus) domCaptureStatus.textContent = message;
}

async function loadDomTabs() {
  if (!domCapturePlatform || !domCaptureTab) return;
  const platform = domCapturePlatform.value;
  domCaptureTab.disabled = true;
  domCaptureSave.disabled = true;
  domCaptureTab.innerHTML = '<option>Finding open tabs...</option>';
  setDomCaptureStatus(`Looking for open ${platform} tabs...`);
  try {
    const tabs = await fetchJSON(`/api/automation/dom-captures/tabs?platform=${encodeURIComponent(platform)}`);
    domCaptureTab.innerHTML = "";
    if (!tabs.length) {
      domCaptureTab.innerHTML = '<option value="">No matching tab open</option>';
      setDomCaptureStatus(`Open the ${platform} page in the connected Chrome session, then refresh.`);
      return;
    }
    tabs.forEach((tab) => {
      const option = document.createElement("option");
      option.value = tab.index;
      option.textContent = tab.url;
      domCaptureTab.appendChild(option);
    });
    domCaptureTab.disabled = false;
    domCaptureSave.disabled = false;
    setDomCaptureStatus(`${tabs.length} open ${platform} tab${tabs.length === 1 ? "" : "s"} found.`);
  } catch (error) {
    domCaptureTab.innerHTML = '<option value="">Could not connect to Chrome</option>';
    setDomCaptureStatus(error.message || "Could not connect to the CDP Chrome session.");
  }
}

async function loadDomCaptures() {
  if (!domCaptureList) return;
  try {
    const captures = await fetchJSON("/api/automation/dom-captures?limit=12");
    if (!captures.length) {
      domCaptureList.innerHTML = "<p>No DOM checkpoints saved yet.</p>";
      return;
    }
    domCaptureList.innerHTML = captures.map((capture) => `
      <div class="flex items-center justify-between gap-4 border border-outline-variant/70 px-3 py-2 rounded">
        <div class="min-w-0"><span class="text-on-surface font-medium">${escapeHtml(capture.label)}</span><span class="mx-2 text-outline">${escapeHtml(capture.platform)} / ${escapeHtml(capture.pipeline)}</span><span class="text-on-surface-variant">${escapeHtml(capture.url)}</span></div>
        <time class="shrink-0 text-body-xs">${escapeHtml(new Date(capture.capturedAt).toLocaleString())}</time>
      </div>`).join("");
  } catch (error) {
    domCaptureList.innerHTML = "<p>Could not load saved DOM checkpoints.</p>";
  }
}

async function saveDomCapture() {
  if (!domCapturePlatform || domCaptureSave.disabled) return;
  domCaptureSave.disabled = true;
  setDomCaptureStatus("Saving rendered DOM and screenshot...");
  try {
    const capture = await fetchJSON("/api/automation/dom-captures", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: domCapturePlatform.value,
        pipeline: domCapturePipeline.value,
        pageIndex: Number(domCaptureTab.value),
        label: domCaptureLabel.value,
      }),
    });
    setDomCaptureStatus(`Saved ${capture.label} at ${new Date(capture.capturedAt).toLocaleTimeString()}.`);
    showToast("DOM checkpoint saved.", "success");
    await loadDomCaptures();
  } catch (error) {
    setDomCaptureStatus(error.message || "Could not save DOM checkpoint.");
    showToast(error.message || "Could not save DOM checkpoint.", "error");
  } finally {
    domCaptureSave.disabled = domCaptureTab.disabled;
  }
}

// Top-level bindings — registered at script-load time (matches the
// original IIFE behavior, where these addEventListener calls sat at the
// bottom of the IIFE body and ran immediately when the IIFE executed).
domCapturePlatform?.addEventListener("change", loadDomTabs);
domCaptureRefreshTabs?.addEventListener("click", loadDomTabs);
domCaptureSave?.addEventListener("click", saveDomCapture);
domCaptureRefreshList?.addEventListener("click", loadDomCaptures);
