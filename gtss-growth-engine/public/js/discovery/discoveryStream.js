/**
 * discovery/discoveryStream.js — Live log + Socket.IO/legacy SSE listener
 * + start/stop/resume for the discovery flow.
 *
 * Exposes (via global scope):
 *   - appendLog(event)         — append a single log line to #live-log
 *   - formatEventMessage(event)
 *                              — turn a discovery event into a short
 *                                human-readable string (connected / done /
 *                                JSON fallback)
 *   - enterRunningState(jobId, platforms, statusText)
 *                              — switch the page from the idle discovery
 *                                form to the running-panel view, then
 *                                open the live stream
 *   - resumeActiveDiscovery()  — async; called once on page load. If a
 *                                discovery job is currently running
 *                                (started from this tab, another tab, or
 *                                before a refresh), rehydrates the running
 *                                panel and reattaches the live Socket.IO
 *                                listener instead of showing the idle
 *                                form as if nothing were happening.
 *   - startDiscovery(event)    — async; form-submit handler that reads
 *                                the keyword + platform + max-leads +
 *                                IG strategy inputs, validates them, and
 *                                POSTs /api/discovery/start
 *   - openDiscoveryStream(jobId)
 *                              — open the Socket.IO + legacy SSE
 *                                listener for a discovery job (handles
 *                                captcha / done / stopped / error events
 *                                + the result-summary card on done)
 *   - stopDiscovery()          — async; POST /api/discovery/stop/:jobId
 *
 * Depends on (from discovery/state.js, loaded earlier):
 *   - discoveryState, platformLabels
 * Depends on (from discovery/helpers.js, loaded earlier):
 *   - selectedPlatforms, platformBadge (NOT — only used by history.js,
 *     but kept in helpers for clarity)
 * Depends on (from discovery/results.js, loaded later):
 *   - loadResults
 * Depends on (from discovery/history.js, loaded later):
 *   - loadHistory
 * Depends on (from window.gtss, available via app.js):
 *   - fetchJSON, showToast, getSocket, initSSE, formatPlatformLabel
 *
 * NOTE: This file is loaded BEFORE results.js and history.js in the
 * loader order, but function declarations are hoisted and looked up at
 * call time — `loadResults` and `loadHistory` are only ever called from
 * inside the `onDiscoveryEvent` callback (which runs much later, after
 * every split file has finished loading), so this is safe.
 */

function appendLog(event) {
  const log = document.getElementById("live-log");
  const type = event.type || "info";
  const classType = type === "done" ? "success" : type;
  const line = document.createElement("div");
  line.className = `log-${classType}`;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${event.message || formatEventMessage(event)}`;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function formatEventMessage(event) {
  if (event.type === "connected") return "Connected to discovery stream";
  if (event.type === "done") {
    const result = event.result || {};
    return `Discovery complete: ${result.new || 0} new, ${result.duplicates || 0} duplicates`;
  }
  return JSON.stringify(event);
}

function enterRunningState(jobId, platforms, statusText) {
  discoveryState.currentJobId = jobId;
  // Track which platforms were scanned so the completion summary can list
  // them after the SSE done event arrives.
  discoveryState.currentPlatforms = [...platforms];
  document.getElementById("discovery-form").style.display = "none";
  document.getElementById("result-summary").classList.remove("visible");
  document.getElementById("running-panel").classList.add("visible");
  document.getElementById("running-text").textContent = statusText;
  openDiscoveryStream(jobId);
}

// Called once on page load. If a discovery job is currently running (started
// from this tab, another tab, or before a refresh), rehydrate the running
// panel and reattach the live Socket.IO listener instead of showing the idle
// form as if nothing were happening.
async function resumeActiveDiscovery() {
  try {
    const status = await window.gtss.fetchJSON("/api/discovery/active");
    if (!status.active) return;

    const platforms =
      Array.isArray(status.platforms) && status.platforms.length
        ? status.platforms
        : selectedPlatforms();
    const platformNames = platforms
      .map((platform) => platformLabels[platform] || window.gtss.formatPlatformLabel(platform) || platform)
      .join(", ");

    document.getElementById("live-log").innerHTML = "";
    appendLog({
      type: "info",
      message: `Reconnected to discovery job ${status.jobId} (already running)`,
    });
    enterRunningState(
      status.jobId,
      platforms,
      `Discovering leads on ${platformNames}...`,
    );
  } catch (error) {
    // Non-fatal — if this check fails, the page still works as an idle
    // discovery form; the user can just see the job's own next event.
    console.error("Failed to check active discovery job", error);
  }
}

async function startDiscovery(event) {
  event.preventDefault();

  let keyword = document.getElementById("keyword-input").value.trim();
  const platforms = selectedPlatforms();
  const maxLeads = Number(
    document.getElementById("max-leads-input").value || 20,
  );

  if (platforms.length === 0) {
    window.gtss.showToast("Select at least one platform", "warning");
    return;
  }

  const hasInstagram = platforms.includes("instagram");
  let ig_auto_warmup = false;

  if (hasInstagram) {
    const activeStrategy = document.querySelector('input[name="ig-strategy"]:checked')?.value || "hashtag";
    ig_auto_warmup = document.getElementById("ig-auto-warmup").checked;

    if (activeStrategy === "hashtag") {
      if (selectedHashtags.length === 0) {
        window.gtss.showToast("Please add at least one Instagram Hashtag chip.", "warning");
        return;
      }
      keyword = `#${selectedHashtags[0]}`;
    } else if (activeStrategy === "geolocation") {
      const select = document.getElementById("ig-location-select");
      if (!select || !select.value) {
        window.gtss.showToast("Please select a location.", "warning");
        return;
      }
      const option = select.options[select.selectedIndex];
      keyword = `geolocation:${select.value}:${option.text}`;
    } else if (activeStrategy === "competitor") {
      const usernameInput = document.getElementById("ig-competitor-username");
      const cleaned = usernameInput ? usernameInput.value.trim().replace(/^@/, "") : "";
      if (!cleaned) {
        window.gtss.showToast("Please enter a competitor username.", "warning");
        return;
      }
      const maxScrape = Number(document.getElementById("ig-competitor-max").value || 25);
      keyword = `competitor:${cleaned}`;
    } else if (activeStrategy === "suggested") {
      keyword = "competitor:suggested";
    }
  } else {
    if (!keyword) {
      window.gtss.showToast("Keyword is required", "warning");
      return;
    }
  }

  try {
    const response = await window.gtss.fetchJSON("/api/discovery/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keyword, platforms, maxLeads, ig_auto_warmup }),
    });

    document.getElementById("live-log").innerHTML = "";
    appendLog({
      type: "info",
      message: `Discovery job ${response.jobId} started`,
    });
    enterRunningState(
      response.jobId,
      platforms,
      `Discovering leads on ${platforms.map((platform) => platformLabels[platform]).join(", ")}...`,
    );
  } catch (error) {
    window.gtss.showToast(error.message, "error");
  }
}

function openDiscoveryStream(jobId) {
  if (discoveryState.eventSource) {
    discoveryState.eventSource.close();
  }

  // Legacy SSE to trigger backend stream
  discoveryState.eventSource = window.gtss.initSSE(
    `/api/discovery/stream/${jobId}`,
    () => {},
  );

  // Socket.IO listener for real-time events
  const socket = window.gtss.getSocket();
  if (!socket) return;

  function onDiscoveryEvent(event) {
    if (event.jobId && String(event.jobId) !== String(jobId)) return;
    appendLog(event);

    if (event.type === "captcha") {
      appendLog({
        type: "captcha",
        message: event.message || "CAPTCHA detected, automation paused",
      });
    }

    if (event.type === "done") {
      const result = event.result || {};
      document.getElementById("running-panel").classList.remove("visible");
      document.getElementById("discovery-form").style.display = "";
      document.getElementById("result-summary").classList.add("visible");
      // Compose the richer completion summary: success badge + new/duplicate
      // counts + platforms scanned, plus a "Proceed to Qualification" CTA
      // (the CTA markup lives in discovery.html).
      const scannedKeys =
        discoveryState.currentPlatforms && discoveryState.currentPlatforms.length
          ? discoveryState.currentPlatforms
          : selectedPlatforms();
      const platformsScanned = scannedKeys.map(
        (key) =>
          platformLabels[key] ||
          window.gtss.formatPlatformLabel(key) ||
          key,
      );
      document.getElementById("result-summary-text").textContent =
        `Discovery Complete: ${result.new || 0} new leads found`;
      document.getElementById("result-summary-detail").textContent =
        `Scanned: ${platformsScanned.length ? platformsScanned.join(", ") : "—"} · ${result.duplicates || 0} duplicates skipped`;
      window.gtss.showToast(
        `Discovery complete: ${result.new || 0} new leads found`,
        "success",
      );
      cleanup();
      loadResults();
      loadHistory();
    }

    if (event.type === "stopped") {
      discoveryState.running = false;
      document.getElementById("running-panel").classList.remove("visible");
      document.getElementById("discovery-form").style.display = "";
      window.gtss.showToast("Discovery stopped.", "warn");
      cleanup();
      loadHistory();
    }

    if (event.type === "error") {
      window.gtss.showToast(event.message || "Discovery failed", "error");
      document.getElementById("running-panel").classList.remove("visible");
      document.getElementById("discovery-form").style.display = "";
      cleanup();
    }
  }

  function cleanup() {
    socket.off('discovery:event', onDiscoveryEvent);
    if (discoveryState.eventSource) {
      discoveryState.eventSource.close();
      discoveryState.eventSource = null;
    }
  }

  socket.on('discovery:event', onDiscoveryEvent);
}

async function stopDiscovery() {
  if (!discoveryState.currentJobId) {
    window.gtss.showToast("No active discovery to stop.", "warn");
    return;
  }

  try {
    await window.gtss.fetchJSON(
      `/api/discovery/stop/${discoveryState.currentJobId}`,
      { method: "POST" },
    );
    appendLog({
      type: "warning",
      message: "Stop requested. Current browser action may finish first.",
    });
  } catch (error) {
    window.gtss.showToast(error.message, "error");
  }
}
