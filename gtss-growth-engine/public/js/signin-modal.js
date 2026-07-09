/**
 * signin-modal.js — the platform sign-in modal that lives on the web app's
 * root page ("/").
 *
 * ─── What this replaces ──────────────────────────────────────────────────
 *
 * The sign-in modal used to live inside the Electron launcher (desktop
 * renderer). It opened platform login pages in the user's DEFAULT browser
 * via shell.openExternal — which meant fresh cookies never reached the CDP
 * Chrome that actually runs automation (not until a profile clone ran).
 *
 * ─── How it works now ────────────────────────────────────────────────────
 *
 * The modal is rendered here, on the dashboard. When the user clicks a
 * platform's "Open in Chrome" button, we call the bridge HTTP server
 * (desktop/main/bridge-server.js, port 9224) which:
 *
 *   1. Makes sure the CDP Chrome is running VISIBLY (starts it if needed,
 *      or restarts it visibly if it was headless).
 *   2. Opens the platform's login URL in a new tab of that CDP Chrome.
 *
 * Because login happens inside the CDP Chrome — the same browser that
 * automation uses — cookies land in the right profile immediately. We
 * poll the bridge's /api/bridge/cdp/sessions endpoint every few seconds
 * and update each platform card optimistically (green ✓) the moment a
 * session cookie is detected. No profile-clone round-trip, no "sign in
 * again after restarting the app".
 *
 * ─── When the modal shows ────────────────────────────────────────────────
 *
 * On page load we fetch /api/bridge/state. The modal auto-shows when:
 *   - sign-in has not been completed yet (no .signin-completed sentinel),
 *     OR
 *   - any required platform session is missing.
 *
 * The user can dismiss it with "Later" (it stays dismissed for this page
 * session) or "All set" (which writes the sentinel via the bridge so the
 * launcher's next Start uses the normal background flow).
 *
 * ─── Fallback when the bridge isn't reachable ───────────────────────────
 *
 * If the web app is running standalone (npm start inside
 * gtss-growth-engine/, without the Electron launcher), the bridge on
 * 127.0.0.1:9224 won't answer. In that case we hide the modal silently —
 * standalone users sign in via the Settings → Platform Sessions page,
 * which uses the server-side authenticate flow.
 */

(function () {
  "use strict";

  // The bridge port must match desktop/main/bridge-server.js
  // (DEFAULT_PORT = 9224). We try a small list of ports in case 9224 was
  // taken and the bridge auto-incremented.
  const BRIDGE_PORTS = [9224, 9225, 9226, 9227];
  let bridgeBase = null;

  async function findBridge() {
    if (bridgeBase) return bridgeBase;
    for (const port of BRIDGE_PORTS) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/bridge/health`, {
          method: "GET",
        });
        if (res.ok) {
          bridgeBase = `http://127.0.0.1:${port}`;
          return bridgeBase;
        }
      } catch (_) {
        // Port not answering — try the next.
      }
    }
    return null;
  }

  async function bridgeFetch(path, options) {
    const base = await findBridge();
    if (!base) throw new Error("Bridge not reachable");
    const res = await fetch(`${base}${path}`, options);
    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
    }
    if (!res.ok) {
      throw new Error((data && data.error) || `HTTP ${res.status}`);
    }
    return data;
  }

  // ─── Platform definitions ──────────────────────────────────────────────
  //
  // Mirrors the list in desktop/main/bridge-server.js. We keep a local
  // copy so the modal can render instantly without waiting for the
  // bridge's /state response (we still cross-check against the bridge's
  // `platforms` field when it arrives).
  const PLATFORMS = [
    {
      key: "google",
      label: "Google / Gemini",
      icon: "G",
      iconBg: "#4285f4",
      required: true,
      hint: "Open Gemini and sign in with your Google account. Needed for AI image generation.",
    },
    {
      key: "linkedin",
      label: "LinkedIn",
      icon: "in",
      iconBg: "#0077b5",
      required: true,
      hint: "Open LinkedIn and sign in. Needed for LinkedIn outreach.",
    },
    {
      key: "facebook",
      label: "Facebook",
      icon: "f",
      iconBg: "#1877f2",
      required: false,
      hint: "Open Facebook and sign in.",
    },
    {
      key: "x",
      label: "X (Twitter)",
      icon: "𝕏",
      iconBg: "#000000",
      required: false,
      hint: "Open X and sign in.",
    },
    {
      key: "instagram",
      label: "Instagram",
      icon: "IG",
      iconBg: "#e1306c",
      required: false,
      hint: "Open Instagram and sign in. Needed for Instagram warmup & posting.",
    },
  ];

  let sessionState = {};
  let signinCompleted = false;
  let modalDismissed = false;
  let pollTimer = null;
  let modalEl = null;

  // ─── Modal markup ──────────────────────────────────────────────────────

  function buildModal() {
    const backdrop = document.createElement("div");
    backdrop.id = "gtss-signin-backdrop";
    backdrop.className = "gtss-signin-backdrop";
    backdrop.setAttribute("role", "dialog");
    backdrop.setAttribute("aria-modal", "true");
    backdrop.setAttribute("aria-labelledby", "gtss-signin-title");
    backdrop.innerHTML = `
      <div class="gtss-signin-modal">
        <div class="gtss-signin-head">
          <h2 id="gtss-signin-title">Sign in to your accounts</h2>
          <button type="button" class="gtss-signin-close" aria-label="Close">×</button>
        </div>
        <div class="gtss-signin-body">
          <p class="gtss-signin-intro">
            Sign in to each platform inside the <strong>automation Chrome</strong>
            (the same browser that runs your outreach). Click
            <strong>Open in Chrome</strong> — a tab opens in the Chrome window
            at port 9222 where you can log in. Sessions are detected
            automatically and marked green below. No separate browser sign-in,
            no profile clone needed.
          </p>
          <div class="gtss-signin-status">
            <span id="gtss-signin-cdp-state">Chrome: checking…</span>
            <button type="button" id="gtss-signin-refresh" class="gtss-signin-btn-secondary">Refresh</button>
          </div>
          <div id="gtss-signin-grid" class="gtss-signin-grid"></div>
          <p class="gtss-signin-note">
            <strong>Tip:</strong> if a session you just signed in still shows
            “Not signed in”, click <em>Refresh</em> — cookie detection can take
            a few seconds. <strong>Google / Gemini</strong> has no dedicated
            login page; the <em>Open in Chrome</em> button opens Gemini itself
            — sign in there with your Google account.
          </p>
        </div>
        <div class="gtss-signin-foot">
          <button type="button" id="gtss-signin-later" class="gtss-signin-btn-secondary">Later</button>
          <button type="button" id="gtss-signin-done" class="gtss-signin-btn-primary">All set</button>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);
    return backdrop;
  }

  function ensureModal() {
    if (!modalEl) {
      modalEl = buildModal();
      wireModalEvents();
    }
    return modalEl;
  }

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
      return `
        <div class="${cardCls}" data-platform="${p.key}">
          <div class="gtss-signin-logo" style="background:${p.iconBg}">${escapeHtml(p.icon)}</div>
          <div class="gtss-signin-info">
            <div class="gtss-signin-name">
              ${escapeHtml(p.label)}
              ${p.required ? '<span class="gtss-signin-pill">Required</span>' : ""}
            </div>
            <div class="gtss-signin-state ${stateCls}">${stateText}</div>
          </div>
          <button class="gtss-signin-btn-open"
                  data-platform="${p.key}"
                  title="${escapeHtml(p.hint)}"
                  ${loggedIn ? "disabled" : ""}>
            ${loggedIn ? "✓ Done" : "Open in Chrome"}
          </button>
          <div class="gtss-signin-check ${stateCls}">${check}</div>
        </div>
      `;
    }).join("");

    // Wire up Open buttons.
    grid.querySelectorAll(".gtss-signin-btn-open").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const key = btn.dataset.platform;
        const platform = PLATFORMS.find((p) => p.key === key);
        if (!platform) return;
        const original = btn.textContent;
        btn.disabled = true;
        btn.textContent = "Opening…";
        try {
          const res = await bridgeFetch("/api/bridge/cdp/open-login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ platform: key }),
          });
          if (res.ok) {
            showToast(`${platform.label} login opened in the automation Chrome — sign in there.`, "info");
            // Optimistic: poll immediately so the green check appears ASAP.
            pollOnce();
          } else {
            showToast(`Could not open ${platform.label}: ${res.error || "unknown error"}`, "error");
          }
        } catch (err) {
          showToast(`Bridge unreachable: ${err.message}. Is the GTSS launcher running?`, "error");
        } finally {
          btn.textContent = original;
          const state = sessionState[key];
          if (!state || !state.loggedIn) btn.disabled = false;
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
    el.textContent = running
      ? "Chrome: running (visible, port 9222)"
      : "Chrome: not running — click a platform to launch it.";
  }

  // ─── Polling ───────────────────────────────────────────────────────────

  async function pollOnce() {
    try {
      const res = await bridgeFetch("/api/bridge/cdp/sessions");
      if (!res || !res.sessions) {
        updateCdpStateLabel(false);
        return;
      }
      updateCdpStateLabel(true);
      // Preserve previously-detected logins (avoid flicker).
      const next = {};
      for (const p of PLATFORMS) {
        const fresh = res.sessions[p.key];
        const prev = sessionState[p.key];
        if (fresh && fresh.loggedIn) {
          next[p.key] = fresh;
        } else if (prev && prev.loggedIn) {
          next[p.key] = prev;
        } else if (fresh) {
          next[p.key] = fresh;
        }
      }
      sessionState = next;
      renderGrid();
      updateDoneButton();
    } catch (_) {
      // Bridge unreachable — leave the grid as-is.
    }
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollOnce();
    pollTimer = setInterval(pollOnce, 4000);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // ─── Show / hide ───────────────────────────────────────────────────────

  function showModal() {
    ensureModal();
    modalEl.classList.add("visible");
    modalEl.setAttribute("aria-hidden", "false");
    renderGrid();
    updateDoneButton();
    pollOnce();
    startPolling();
  }

  function hideModal() {
    if (!modalEl) return;
    modalEl.classList.remove("visible");
    modalEl.setAttribute("aria-hidden", "true");
    // Keep polling briefly so the sidebar dots catch up after dismiss.
    setTimeout(stopPolling, 5000);
  }

  // ─── Events ────────────────────────────────────────────────────────────

  function wireModalEvents() {
    modalEl.querySelector(".gtss-signin-close").addEventListener("click", () => {
      modalDismissed = true;
      hideModal();
    });
    modalEl.querySelector("#gtss-signin-later").addEventListener("click", () => {
      modalDismissed = true;
      hideModal();
    });
    modalEl.querySelector("#gtss-signin-done").addEventListener("click", async () => {
      // Mark sign-in complete so the launcher's next Start uses the
      // normal (background) flow instead of the first-time visible flow.
      try {
        await bridgeFetch("/api/bridge/signin/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
      } catch (_) {
        // Non-fatal — the user can still dismiss the modal.
      }
      signinCompleted = true;
      hideModal();
      showToast("All set! Future Starts will run Chrome in the background. You can change this in Settings.", "success");
    });
    modalEl.querySelector("#gtss-signin-refresh").addEventListener("click", () => {
      pollOnce();
    });
    // Click on the backdrop (outside the modal) closes it.
    modalEl.addEventListener("click", (e) => {
      if (e.target === modalEl) {
        modalDismissed = true;
        hideModal();
      }
    });
  }

  // ─── Init ──────────────────────────────────────────────────────────────

  async function init() {
    // Don't run on non-dashboard pages — the modal is only for "/".
    if (window.location.pathname !== "/" && window.location.pathname !== "/dashboard") {
      return;
    }

    const base = await findBridge();
    if (!base) {
      // Bridge not reachable (standalone server, or launcher not running).
      // Silently skip — standalone users sign in via Settings.
      return;
    }

    let state;
    try {
      state = await bridgeFetch("/api/bridge/state");
    } catch (_) {
      return;
    }
    if (!state || !state.ok) return;

    signinCompleted = !!state.signinCompleted;
    if (state.sessions) {
      sessionState = state.sessions;
    }

    // Decide whether to auto-show.
    const requiredMissing = PLATFORMS.filter(
      (p) =>
        p.required &&
        !(sessionState[p.key] && sessionState[p.key].loggedIn),
    );
    const shouldShow = !signinCompleted || requiredMissing.length > 0;

    if (shouldShow && !modalDismissed) {
      showModal();
    }

    // Expose a manual re-open handle on window.gtss so other parts of the
    // web app (e.g., a "Sign in to accounts" link) can pop the modal.
    window.gtss = window.gtss || {};
    window.gtss.openSigninModal = showModal;
  }

  function escapeHtml(text) {
    if (typeof text !== "string") return String(text || "");
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function showToast(message, type) {
    if (window.gtss && typeof window.gtss.showToast === "function") {
      window.gtss.showToast(message, type, 5000);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
