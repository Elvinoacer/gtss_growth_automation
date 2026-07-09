/**
 * signin-modal.js — the platform sign-in modal that lives on the web app's
 * root page ("/").
 *
 * ─── What this does ────────────────────────────────────────────────────
 *
 * Renders a modal on the dashboard that lets the user sign in to each
 * platform. The modal uses the SAME central server-side authentication
 * flow that powers /settings#platform-sessions: clicking a platform's
 * "Login / Re-authenticate" button calls
 *
 *   POST /api/sessions/authenticate/:platform
 *
 * which (in src/automation/executor.js#authenticatePlatform) launches a
 * visible automation browser, navigates to the platform's login page,
 * waits for the user to sign in, and persists the session to the
 * `platform_sessions` SQLite table.
 *
 * Because the modal uses the same endpoint as Settings → Platform
 * Sessions, the two are perfectly interchangeable: a session started
 * from the dashboard shows up in Settings (and vice versa), and the
 * sidebar status dots stay in sync via window.gtss.updateSessionDots().
 *
 * ─── Session validation sources ─────────────────────────────────────────
 *
 * The modal merges TWO sources of session state so it always reflects
 * what the /settings#platform-sessions page shows (and what the
 * automation engine will actually use at runtime):
 *
 *   1. Server-side DB sessions — /api/sessions/details
 *      The SAME endpoint the Settings page uses. Reads the
 *      `platform_sessions` SQLite table (written by the server-side
 *      authenticate flow in /api/sessions/authenticate/:platform, and
 *      by markSessionActive() during automation runs).
 *
 *   2. Bridge CDP cookies — /api/bridge/cdp/sessions
 *      Live cookie detection inside the CDP Chrome (only available
 *      inside the Electron launcher). Used as a secondary source so
 *      the modal reflects logins performed in the open CDP Chrome
 *      tab too.
 *
 * If EITHER source says the platform is logged in, the card shows
 * green.
 *
 * ─── When the modal shows ────────────────────────────────────────────────
 *
 * On page load we fetch /api/bridge/state (if reachable) AND
 * /api/sessions/details. The modal auto-shows when:
 *   - sign-in has not been completed yet (no .signin-completed sentinel),
 *     OR
 *   - any required platform session is missing in BOTH sources.
 *
 * The user can dismiss it with "Later" (it stays dismissed for this page
 * session) or "All set" (which writes the sentinel via the bridge so the
 * launcher's next Start uses the normal background flow).
 *
 * ─── Standalone mode ────────────────────────────────────────────────────
 *
 * If the web app is running standalone (npm start inside
 * gtss-growth-engine/, without the Electron launcher), the bridge on
 * 127.0.0.1:9224 won't answer. That's fine — the "Login / Re-authenticate"
 * button still works because it calls the server-side authenticate
 * endpoint directly, exactly like the Settings page does.
 *
 * ─── Gemini / Google note ───────────────────────────────────────────────
 *
 * Gemini has no dedicated login endpoint — users sign in at
 * https://gemini.google.com/ with their Google account from inside the
 * automation browser that the authenticate endpoint launches. If the
 * Google session cannot be detected here (cookies not yet picked up),
 * the user must either:
 *   (a) sign in again via Login / Re-authenticate, OR
 *   (b) provide a Gemini API key in Settings → API Configuration,
 *       which the engine will use as a fallback when no signed-in
 *       browser session is available.
 * A user-friendly hint to this effect is rendered under the grid.
 */

(function () {
  "use strict";

  // The bridge port must match desktop/main/bridge-server.js
  // (DEFAULT_PORT = 9224). We try a small list of ports in case 9224 was
  // taken and the bridge auto-incremented.
  const BRIDGE_PORTS = [9224, 9225, 9226, 9227];
  let bridgeBase = null;
  let bridgeChecked = false;

  async function findBridge() {
    if (bridgeChecked) return bridgeBase;
    bridgeChecked = true;
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
  //
  // `serverKeys` lists the keys the server-side /api/sessions/details
  // endpoint might use for the same platform. The automation engine
  // uses `gemini` for Gemini (see src/automation/geminiWeb.js) while the
  // bridge uses `google`; we accept either so the modal reflects the
  // right state regardless of which flow last touched the session.
  const PLATFORMS = [
    {
      key: "google",
      label: "Google / Gemini",
      icon: "G",
      iconBg: "#4285f4",
      required: true,
      hint: "Open Gemini and sign in with your Google account. Needed for AI image generation.",
      serverKeys: ["google", "gemini"],
      geminiNote: true,
    },
    {
      key: "linkedin",
      label: "LinkedIn",
      icon: "in",
      iconBg: "#0077b5",
      required: true,
      hint: "Open LinkedIn and sign in. Needed for LinkedIn outreach.",
      serverKeys: ["linkedin"],
    },
    {
      key: "facebook",
      label: "Facebook",
      icon: "f",
      iconBg: "#1877f2",
      required: false,
      hint: "Open Facebook and sign in.",
      serverKeys: ["facebook"],
    },
    {
      key: "x",
      label: "X (Twitter)",
      icon: "𝕏",
      iconBg: "#000000",
      required: false,
      hint: "Open X and sign in.",
      serverKeys: ["x", "twitter"],
    },
    {
      key: "instagram",
      label: "Instagram",
      icon: "IG",
      iconBg: "#e1306c",
      required: false,
      hint: "Open Instagram and sign in. Needed for Instagram warmup & posting.",
      serverKeys: ["instagram"],
    },
  ];

  let sessionState = {};
  let signinCompleted = false;
  let modalDismissed = false;
  let pollTimer = null;
  let modalEl = null;

  // ─── Server-side session detection ─────────────────────────────────────
  //
  // Same endpoint the /settings#platform-sessions page uses. Returns a
  // map of platformKey -> { status, last_active, is_valid }. We translate
  // that into the { loggedIn } shape the modal expects, and merge it
  // with the bridge's live cookie state.
  async function loadServerSessions() {
    try {
      const res = await fetch("/api/sessions/details", {
        method: "GET",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return {};
      const data = await res.json();
      if (!data || typeof data !== "object") return {};
      const out = {};
      for (const p of PLATFORMS) {
        let found = null;
        for (const sk of p.serverKeys) {
          const row = data[sk];
          if (row && row.is_valid && row.status === "active") {
            found = row;
            break;
          }
        }
        if (found) {
          out[p.key] = {
            loggedIn: true,
            source: "server",
            lastActive: found.last_active || null,
          };
        }
      }
      return out;
    } catch (_) {
      return {};
    }
  }

  // Merge two session-state maps. If either source says logged-in, the
  // platform is considered logged-in. We preserve the freshest
  // metadata.
  function mergeSessions(serverState, bridgeState) {
    const next = {};
    for (const p of PLATFORMS) {
      const s = serverState[p.key];
      const b = bridgeState[p.key];
      if (s && s.loggedIn) {
        next[p.key] = s;
      } else if (b && b.loggedIn) {
        next[p.key] = b;
      } else if (b) {
        next[p.key] = b;
      } else if (s) {
        next[p.key] = s;
      } else {
        next[p.key] = { loggedIn: false };
      }
    }
    return next;
  }

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
            Click <strong>Login / Re-authenticate</strong> on any platform to
            open its login page in the automation browser. Sign in there — the
            session is saved automatically and the card turns green below.
            This is the exact same flow that powers
            <a href="/settings#platform-sessions">Settings → Platform Sessions</a>,
            so sessions started here show up there (and vice versa).
          </p>
          <div class="gtss-signin-status">
            <span id="gtss-signin-cdp-state">Checking session status…</span>
            <button type="button" id="gtss-signin-refresh" class="gtss-signin-btn-secondary">Refresh</button>
          </div>
          <div id="gtss-signin-grid" class="gtss-signin-grid"></div>
          <p class="gtss-signin-note">
            <strong>Tip:</strong> if a session you just signed in still shows
            “Not signed in”, click <em>Refresh</em> — server-side session
            detection can take a few seconds to catch up. <strong>Google /
            Gemini</strong> has no dedicated login page; the
            <em>Login / Re-authenticate</em> button opens Gemini itself — sign
            in there with your Google account. If you cannot sign in through
            the automation browser, you can also set a
            <em>Gemini API key</em> in
            <a href="/settings#api-configuration">Settings → API Configuration</a>
            — the engine will use it as a fallback when no signed-in browser
            session is available.
          </p>
          <p class="gtss-signin-note gtss-signin-note-bridge-off" id="gtss-signin-bridge-note" hidden>
            <strong>Standalone mode:</strong> the GTSS launcher isn't running,
            but you can still sign in here — <em>Login / Re-authenticate</em>
            launches the automation browser server-side, exactly like the
            <a href="/settings#platform-sessions">Platform Sessions</a> section
            on the Settings page does.
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

  // ─── Polling ───────────────────────────────────────────────────────────
  //
  // Every poll we fetch BOTH:
  //   - /api/sessions/details (server-side DB state — always available
  //     as long as the web app server is up), and
  //   - /api/bridge/cdp/sessions (live CDP cookies — only if bridge is
  //     reachable AND Chrome is running).
  // We merge the two so a session saved by either flow shows up green.

  async function pollOnce() {
    // Always fetch the server-side state in parallel with the bridge.
    const serverPromise = loadServerSessions();
    const bridgePromise = (async () => {
      if (!bridgeBase) return null;
      try {
        return await bridgeFetch("/api/bridge/cdp/sessions");
      } catch (_) {
        return null;
      }
    })();

    const [serverState, bridgeRes] = await Promise.all([serverPromise, bridgePromise]);

    let bridgeState = {};
    if (bridgeRes && bridgeRes.sessions) {
      updateCdpStateLabel(true);
      bridgeState = bridgeRes.sessions;
    } else {
      updateCdpStateLabel(false);
    }

    // Merge: preserve previously-detected logins (avoid flicker if one
    // source temporarily drops), but let a fresh positive from either
    // source flip the card green immediately.
    const next = mergeSessions(serverState, bridgeState);
    for (const p of PLATFORMS) {
      const prev = sessionState[p.key];
      const fresh = next[p.key];
      if (prev && prev.loggedIn && fresh && !fresh.loggedIn) {
        // Keep the previous "logged in" verdict — don't flicker off
        // just because the bridge momentarily returned no cookies.
        next[p.key] = prev;
      }
    }
    sessionState = next;
    renderGrid();
    updateDoneButton();
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
    updateBridgeNote();
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
      if (bridgeBase) {
        try {
          await bridgeFetch("/api/bridge/signin/complete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          });
        } catch (_) {
          // Non-fatal — the user can still dismiss the modal.
        }
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

    // Probe the bridge in parallel with the server-side session check.
    // We don't return early if the bridge is unreachable — the modal
    // can still be useful in standalone mode by routing the user to
    // /settings#platform-sessions.
    const [base, serverState] = await Promise.all([
      findBridge(),
      loadServerSessions(),
    ]);

    if (serverState) {
      sessionState = mergeSessions(serverState, sessionState);
    }

    let state = null;
    if (base) {
      try {
        state = await bridgeFetch("/api/bridge/state");
      } catch (_) {
        state = null;
      }
    }

    if (state && state.ok) {
      signinCompleted = !!state.signinCompleted;
      if (state.sessions) {
        // Merge bridge sessions on top of server sessions.
        sessionState = mergeSessions(serverState, state.sessions);
      }
    }

    // Decide whether to auto-show. We use the merged sessionState so
    // the modal opens whenever a required platform isn't signed in
    // according to EITHER source — matching what the Settings page
    // would show.
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
    // Expose a refresh handle so Settings → "Re-open sign-in modal"
    // can re-probe sessions after a successful authenticate().
    window.gtss.refreshSigninModal = pollOnce;
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
