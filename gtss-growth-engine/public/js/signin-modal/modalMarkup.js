/**
 * signin-modal/modalMarkup.js — Modal DOM construction (buildModal) and the
 * lazy ensureModal singleton accessor that wires events on first creation.
 *
 * Original signin-modal.js was 656 lines; this is one of its thematic splits.
 */

"use strict";

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
