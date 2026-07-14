/**
 * renderer/sessions.js — CDP Chrome session-health badge + hint card.
 *
 * Polls window.gtss.cdp.checkSessions() on a 10s interval to see which
 * platforms (LinkedIn, X, Instagram, Facebook, Google/Gemini) the
 * automation Chrome is signed into. The result drives:
 *   - A topbar badge ("X/N connected") — green/yellow/red at a glance.
 *   - A small hint card in the Control tab that appears when sessions are
 *     missing, with a "Sign in…" button that opens the web app (where the
 *     full sign-in modal lives and can drive logins inside the CDP Chrome
 *     via the bridge server).
 *
 * The launcher does NOT render the full sign-in modal anymore. That moved
 * to the web app so logins happen in the right browser.
 *
 * Extracted from the original renderer.js for maintainability.
 */

/* global window */

const SESSION_PLATFORMS = [
  { key: "google",    label: "Google / Gemini", required: true },
  { key: "linkedin",  label: "LinkedIn",        required: true },
  { key: "facebook",  label: "Facebook",        required: false },
  { key: "x",         label: "X (Twitter)",     required: false },
  { key: "instagram", label: "Instagram",       required: false },
];

let sessionState = {};
let sessionPollTimer = null;

function updateSessionsHealthBadge() {
  const badge = $("#sessions-health-badge");
  if (!badge) return;
  const total = SESSION_PLATFORMS.length;
  const connected = SESSION_PLATFORMS.filter(
    (p) => sessionState[p.key] && sessionState[p.key].loggedIn,
  ).length;
  const required = SESSION_PLATFORMS.filter((p) => p.required);
  const requiredConnected = required.filter(
    (p) => sessionState[p.key] && sessionState[p.key].loggedIn,
  ).length;

  badge.classList.remove("ok", "warn", "error");
  let label;
  if (connected === total) {
    badge.classList.add("ok");
    label = `${connected}/${total} connected`;
    badge.title = "All platforms are connected.";
  } else if (requiredConnected === required.length) {
    badge.classList.add("ok");
    label = `${connected}/${total} connected`;
    badge.title = "All required platforms connected. Optional ones can be signed in later from the web app.";
  } else if (connected === 0) {
    badge.classList.add("error");
    label = `0/${total} connected`;
    badge.title = "No platforms connected. Click to open the web app and sign in.";
  } else {
    badge.classList.add("warn");
    label = `${connected}/${total} connected`;
    badge.title = `${total - connected} platform${total - connected === 1 ? "" : "s"} still need sign-in. Click to open the web app.`;
  }
  const labelEl = badge.querySelector(".sessions-badge-label");
  if (labelEl) labelEl.textContent = label;
  badge.classList.remove("hidden");
}

function updateSessionsHealthCard() {
  const card = $("#sessions-health");
  if (!card) return;
  const missing = SESSION_PLATFORMS.filter(
    (p) => !(sessionState[p.key] && sessionState[p.key].loggedIn),
  );
  if (missing.length === 0) {
    card.classList.add("ok");
    card.classList.remove("hidden");
    $("#sessions-health-icon").textContent = "✓";
    $("#sessions-health-title").textContent = "All sessions detected";
    $("#sessions-health-meta").textContent = "LinkedIn, Facebook, Instagram, and Google Gemini are signed in.";
    $("#sessions-health-open").textContent = "View";
  } else {
    card.classList.remove("ok");
    card.classList.remove("hidden");
    $("#sessions-health-icon").textContent = "!";
    $("#sessions-health-title").textContent = "Missing browser sessions";
    const requiredMissing = missing.filter((p) => p.required);
    const label = requiredMissing.length > 0 ? requiredMissing : missing;
    $("#sessions-health-meta").textContent =
      `Sign in to: ${label.map((p) => p.label).join(", ")}. Click to open the web app — the sign-in modal there opens each login inside the automation Chrome.`;
    $("#sessions-health-open").textContent = "Sign in…";
  }
}

async function pollSessionsOnce() {
  try {
    const res = await window.gtss.cdp.checkSessions();
    if (!res || !res.ok || !res.sessions) return;
    // Preserve previously-detected logins (avoid flicker on transient failures).
    const next = {};
    for (const p of SESSION_PLATFORMS) {
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
    updateSessionsHealthCard();
    updateSessionsHealthBadge();
  } catch (_) {
    // Silent — polling failures are expected.
  }
}

function startSessionPolling() {
  if (sessionPollTimer) clearInterval(sessionPollTimer);
  pollSessionsOnce();
  sessionPollTimer = setInterval(pollSessionsOnce, 10000);
}

function stopSessionPolling() {
  if (sessionPollTimer) {
    clearInterval(sessionPollTimer);
    sessionPollTimer = null;
  }
}

// The Control-tab hint card + the topbar badge both open the web app
// when clicked. The full sign-in modal lives there (on the root page)
// and can drive logins inside the CDP Chrome via the bridge server.
$("#sessions-health-open")?.addEventListener("click", async () => {
  // If the server is running, open the web app in the user's default
  // browser (or inside the CDP Chrome if that's where they already are).
  // The sign-in modal will auto-show on the root page if sessions are
  // missing.
  await window.gtss.openInBrowser();
});
$("#sessions-health-badge")?.addEventListener("click", async () => {
  await window.gtss.openInBrowser();
});

// After Start, give the server + CDP a moment to come up, then poll
// sessions and start the slow background poll so the badge stays fresh.
let _postStartPoll = null;
$("#start-btn").addEventListener("click", () => {
  updateSessionsHealthBadge();
  if (_postStartPoll) clearTimeout(_postStartPoll);
  _postStartPoll = setTimeout(async () => {
    _postStartPoll = null;
    await pollSessionsOnce();
    startSessionPolling();
  }, 6000);
});
