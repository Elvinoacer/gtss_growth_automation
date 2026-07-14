/**
 * signin-modal/renderCards.js — Platform-card rendering and the related label
 * / badge updaters.
 *
 * Includes: renderGrid (renders the per-platform cards and wires the
 * Login / Re-authenticate buttons), updateDoneButton, updateCdpStateLabel,
 * updateBridgeNote.
 *
 * Original signin-modal.js was 656 lines; this is one of its thematic splits.
 */

"use strict";

// ─── Render the platform cards ─────────────────────────────────────────

function renderGrid() {
  const grid = modalEl.querySelector("#gtss-signin-grid");
  if (!grid) return;
  grid.innerHTML = PLATFORMS.map((p) => {
    const state = sessionState[p.key] || { loggedIn: false };
    const loggedIn = Boolean(state.loggedIn);
    const cardCls = [
      "gtss-signin-card",
      p.required ? "required" : "",
      loggedIn ? "logged-in" : "",
    ].filter(Boolean).join(" ");
    const stateText = loggedIn ? "Signed in" : "Not signed in yet";
    const stateCls = loggedIn ? "logged-in" : "not-logged-in";
    const check = loggedIn ? "✓" : "○";

    // Action button — mirrors the Settings → Platform Sessions flow
    // exactly. The button always calls the central server-side
    // /api/sessions/authenticate/:platform endpoint (the same one
    // settings.js's authenticatePlatform() calls), which launches the
    // automation browser, lets the user log in, and persists the
    // session. This works whether or not the GTSS launcher / bridge
    // is running, so the dashboard modal behaves identically to the
    // Settings#platform-sessions page.
    let actionBtn;
    if (loggedIn) {
      actionBtn = `<button class="gtss-signin-btn-open" data-platform="${p.key}" title="${escapeHtml(p.hint)}" disabled>✓ Done</button>`;
    } else {
      actionBtn = `<button class="gtss-signin-btn-open" data-platform="${p.key}" title="${escapeHtml(p.hint)}">Login / Re-authenticate</button>`;
    }

    const geminiBadge = p.geminiNote
      ? `<div class="gtss-signin-subhint">Needs a signed-in Gemini session, or set a Gemini API key in Settings as fallback.</div>`
      : "";

    return `
      <div class="${cardCls}" data-platform="${p.key}">
        <div class="gtss-signin-logo" style="background:${p.iconBg}">${escapeHtml(p.icon)}</div>
        <div class="gtss-signin-info">
          <div class="gtss-signin-name">
            ${escapeHtml(p.label)}
            ${p.required ? '<span class="gtss-signin-pill">Required</span>' : ""}
          </div>
          <div class="gtss-signin-state ${stateCls}">${stateText}</div>
          ${geminiBadge}
        </div>
        ${actionBtn}
        <div class="gtss-signin-check ${stateCls}">${check}</div>
      </div>
    `;
  }).join("");

  // Wire up the Login / Re-authenticate buttons. This mirrors
  // settings.js's authenticatePlatform() exactly: same endpoint
  // (POST /api/sessions/authenticate/:platform), same in-flight
  // UX (disable + "Opening browser..."), same post-success refresh
  // (reload server sessions, re-render grid, update sidebar dots),
  // same toast copy.
  grid.querySelectorAll(".gtss-signin-btn-open[data-platform]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const key = btn.dataset.platform;
      const platform = PLATFORMS.find((p) => p.key === key);
      if (!platform) return;
      const originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Opening browser...";
      try {
        await window.gtss.fetchJSON(
          `/api/sessions/authenticate/${key}`,
          { method: "POST" },
        );
        showToast(`${platform.label} session saved`, "success");
        // Refresh the server-side session state, re-render the
        // grid, and update the sidebar dots — same as settings.
        await pollOnce();
        if (window.gtss && typeof window.gtss.updateSessionDots === "function") {
          window.gtss.updateSessionDots();
        }
      } catch (err) {
        showToast(err.message || `Could not authenticate ${platform.label}.`, "error");
      } finally {
        const state = sessionState[key];
        if (!state || !state.loggedIn) {
          btn.disabled = false;
        }
        btn.textContent = originalText;
      }
    });
  });
}

function updateDoneButton() {
  const btn = modalEl.querySelector("#gtss-signin-done");
  if (!btn) return;
  // Always enabled — the user can finish even if some optional platforms
  // aren't signed in. The tooltip tells them what's still missing.
  btn.disabled = false;
  const requiredMissing = PLATFORMS.filter(
    (p) => p.required && !(sessionState[p.key] && sessionState[p.key].loggedIn),
  );
  if (requiredMissing.length === 0) {
    btn.title = "All required sessions detected.";
  } else {
    btn.title = `Still missing: ${requiredMissing.map((p) => p.label).join(", ")}. You can finish anyway and sign in later from Settings.`;
  }
}

function updateCdpStateLabel(running) {
  const el = modalEl.querySelector("#gtss-signin-cdp-state");
  if (!el) return;
  // The modal uses the central server-side authenticate flow (same
  // as Settings → Platform Sessions), so the bridge / CDP Chrome
  // status is informational only — login works regardless.
  if (!bridgeBase) {
    el.textContent = "Standalone mode — login launches the automation browser server-side.";
    return;
  }
  el.textContent = running
    ? "Automation Chrome: running (visible, port 9222)."
    : "Automation Chrome: not running — login will launch it automatically.";
}

function updateBridgeNote() {
  const el = modalEl.querySelector("#gtss-signin-bridge-note");
  if (!el) return;
  el.hidden = !!bridgeBase;
}
