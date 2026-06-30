/**
 * LinkedIn DM Diagnostics Module
 *
 * Captures structured DOM state snapshots at each critical step of the
 * messaging flow for post-mortem debugging. All operations are no-ops
 * when LINKEDIN_DM_DEBUG is not set to "true" — zero overhead in production.
 *
 * Usage:
 *   const diag = require('./linkedinDiagnostics');
 *   diag.capture(page, 'after-message-click');
 *   diag.capture(page, 'editor-found');
 *   // ... at end of flow:
 *   diag.flush(profileUrl);
 */

const fs = require("fs");
const path = require("path");
const logger = require("../utils/logger");

function isEnabled() {
  return process.env.LINKEDIN_DM_DEBUG === "true";
}

// Accumulated snapshots for the current DM attempt
let _steps = [];
let _sessionStart = null;

/**
 * Capture a DOM state snapshot at a labeled step.
 *
 * Collects:
 * - All visible editors (tag, class, aria-label, rect, contenteditable, disabled, text)
 * - All visible "send"-like buttons (tag, class, aria-label, disabled, rect)
 * - Active overlays/modals
 * - document.activeElement identity
 * - Current URL, document.hasFocus() state
 *
 * @param {object} page      - Playwright page instance
 * @param {string} stepName  - Human-readable label for this snapshot
 * @param {object} [extra]   - Optional extra metadata to attach
 * @param {object} [messagingFrame] - Optional interop-iframe Frame to also capture
 */
async function capture(page, stepName, extra = {}, messagingFrame = null) {
  if (!isEnabled()) return;
  if (!page || page.isClosed()) return;

  if (!_sessionStart) {
    _sessionStart = Date.now();
  }

  const timestamp = new Date().toISOString();
  const elapsed = Date.now() - _sessionStart;

  let snapshot = null;
  try {
    snapshot = await page
      .evaluate(() => {
        const visible = (el) => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.visibility !== "hidden" &&
            style.display !== "none" &&
            Number(style.opacity || "1") > 0
          );
        };

        const describeEl = (el) => {
          const rect = el.getBoundingClientRect();
          return {
            tag: el.tagName.toLowerCase(),
            id: el.id || null,
            className: (el.className || "").toString().slice(0, 200),
            ariaLabel: el.getAttribute("aria-label") || null,
            placeholder:
              el.getAttribute("placeholder") ||
              el.getAttribute("data-placeholder") ||
              null,
            role: el.getAttribute("role") || null,
            contenteditable: el.getAttribute("contenteditable") || null,
            disabled:
              el.disabled ||
              el.getAttribute("aria-disabled") === "true" ||
              false,
            type: el.getAttribute("type") || null,
            rect: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              w: Math.round(rect.width),
              h: Math.round(rect.height),
            },
            text: (el.innerText || el.textContent || el.value || "")
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 150),
            pointerEvents: window.getComputedStyle(el).pointerEvents,
          };
        };

        // 1. Editors
        const editorSelectors = [
          '.msg-form__contenteditable[contenteditable="true"]',
          '.msg-form [contenteditable="true"]',
          ".msg-form textarea",
          '[role="dialog"] [contenteditable="true"]',
          '[role="dialog"] textarea',
          '[role="dialog"] [role="textbox"]',
          '.msg-overlay-conversation-bubble [contenteditable="true"]',
          ".msg-overlay-conversation-bubble textarea",
          '[contenteditable="true"]',
          '[role="textbox"]',
          "textarea",
        ];
        const editorsSeen = new Set();
        const editors = [];
        for (const sel of editorSelectors) {
          for (const el of document.querySelectorAll(sel)) {
            if (editorsSeen.has(el)) continue;
            editorsSeen.add(el);
            if (!visible(el)) continue;
            editors.push({
              ...describeEl(el),
              matchedSelector: sel,
              isFocused:
                document.activeElement === el ||
                el.contains(document.activeElement),
            });
          }
        }

        // 2. Send/submit buttons
        const buttonSelectors = [
          "button.msg-form__send-button",
          '.msg-form button[type="submit"]',
          'button[aria-label="Send"]',
          'button[aria-label="Send message"]',
          'button[aria-label*="Send" i]',
        ];
        const buttonsSeen = new Set();
        const buttons = [];
        for (const sel of buttonSelectors) {
          for (const el of document.querySelectorAll(sel)) {
            if (buttonsSeen.has(el)) continue;
            buttonsSeen.add(el);
            if (!visible(el)) continue;
            buttons.push({
              ...describeEl(el),
              matchedSelector: sel,
            });
          }
        }

        // 3. Overlays/modals
        const overlaySelectors = [
          ".msg-overlay-conversation-bubble",
          ".msg-convo-wrapper",
          ".msg-form",
          '[role="dialog"]',
          ".artdeco-modal",
        ];
        const overlaysSeen = new Set();
        const overlays = [];
        for (const sel of overlaySelectors) {
          for (const el of document.querySelectorAll(sel)) {
            if (overlaysSeen.has(el)) continue;
            overlaysSeen.add(el);
            if (!visible(el)) continue;
            const rect = el.getBoundingClientRect();
            overlays.push({
              selector: sel,
              className: (el.className || "").toString().slice(0, 200),
              ariaLabel: el.getAttribute("aria-label") || null,
              rect: {
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                w: Math.round(rect.width),
                h: Math.round(rect.height),
              },
              hasEditor: Boolean(
                el.querySelector(
                  '[contenteditable="true"], textarea, [role="textbox"]',
                ),
              ),
              hasSendButton: Boolean(
                el.querySelector(
                  'button.msg-form__send-button, button[aria-label*="Send" i], button[type="submit"]',
                ),
              ),
              textSnippet: (el.innerText || "")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 200),
            });
          }
        }

        // 4. Active element
        const activeEl = document.activeElement;
        const activeElement = activeEl
          ? describeEl(activeEl)
          : { tag: "none" };

        return {
          url: window.location.href,
          hasFocus: document.hasFocus(),
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          editors,
          buttons,
          overlays,
          activeElement,
        };
      })
      .catch((err) => ({
        error: `evaluate failed: ${err.message}`,
      }));
  } catch (err) {
    snapshot = { error: `capture failed: ${err.message}` };
  }

  // Optionally capture screenshot
  let screenshotPath = null;
  if (process.env.LINKEDIN_DM_DEBUG_SCREENSHOTS === "true") {
    try {
      const artifactsDir = resolveArtifactsDir();
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const safeName = stepName.replace(/[^a-z0-9_-]/gi, "_").slice(0, 40);
      screenshotPath = path.join(
        artifactsDir,
        `${ts}-linkedin-dm-${safeName}.png`,
      );
      await page.screenshot({ path: screenshotPath }).catch(() => {
        screenshotPath = null;
      });
    } catch (_) {
      screenshotPath = null;
    }
  }

  // Optionally capture state from the messaging iframe too
  let iframeSnapshot = null;
  if (messagingFrame) {
    try {
      iframeSnapshot = await messagingFrame
        .evaluate(() => {
          const visible = (el) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              style.visibility !== "hidden" &&
              style.display !== "none" &&
              Number(style.opacity || "1") > 0
            );
          };
          const describeEl = (el) => {
            const rect = el.getBoundingClientRect();
            return {
              tag: el.tagName.toLowerCase(),
              id: el.id || null,
              className: (el.className || "").toString().slice(0, 120),
              ariaLabel: el.getAttribute("aria-label") || null,
              placeholder: el.getAttribute("placeholder") || el.getAttribute("data-placeholder") || null,
              role: el.getAttribute("role") || null,
              contenteditable: el.getAttribute("contenteditable") || null,
              disabled: el.disabled || el.getAttribute("aria-disabled") === "true" || false,
              type: el.getAttribute("type") || null,
              rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
              text: (el.innerText || el.textContent || el.value || "").replace(/\s+/g, " ").trim().slice(0, 100),
              pointerEvents: window.getComputedStyle(el).pointerEvents,
            };
          };
          const editors = [...document.querySelectorAll('[contenteditable="true"],[role="textbox"],textarea')]
            .filter(visible).map(describeEl);
          const buttons = [...document.querySelectorAll('button[aria-label*="Send" i],button[type="submit"],button:has-text("Send")')]
            .filter(visible).map(describeEl);
          const activeEl = document.activeElement;
          return {
            url: window.location.href,
            hasFocus: document.hasFocus(),
            editors,
            buttons,
            activeElement: activeEl ? describeEl(activeEl) : { tag: "none" },
          };
        })
        .catch((err) => ({ error: `iframe evaluate failed: ${err.message}` }));
    } catch (err) {
      iframeSnapshot = { error: `iframe capture failed: ${err.message}` };
    }
  }

  _steps.push({
    step: stepName,
    timestamp,
    elapsedMs: elapsed,
    snapshot,
    iframeSnapshot: iframeSnapshot || undefined,
    screenshotPath,
    ...extra,
  });
}

/**
 * Resolve a writable artifacts directory.
 *
 * Tries the configured `AUTOMATION_ARTIFACTS_DIR` first. If that directory
 * cannot be created (e.g. the user pointed it at /var/log/... without root
 * permissions), falls back to `./artifacts/automation` under the process
 * working directory. This is critical because flush() is called from a
 * `finally` block in sendDirectMessage — if mkdirSync throws here, the
 * exception replaces the original outcome (e.g. `premium_required`) and
 * the executor sees a "failed" outcome instead of the real one.
 */
function resolveArtifactsDir() {
  const configured = process.env.AUTOMATION_ARTIFACTS_DIR;
  const candidates = [
    configured,
    path.resolve(process.cwd(), "artifacts", "automation"),
  ].filter(Boolean);

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    } catch (err) {
      logger.warn("LINKEDIN_DIAG", `Artifacts dir unwritable: ${dir} (${err.message})`);
    }
  }
  // Last resort: return the configured/default path without creating it.
  // writeFileSync below will fail and be caught by its own try/catch.
  return path.resolve(configured || "./artifacts/automation");
}

/**
 * Write all accumulated step snapshots to a timestamped JSON file
 * and reset the internal buffer for the next DM attempt.
 *
 * @param {string} profileUrl - The LinkedIn profile URL being messaged
 */
function flush(profileUrl) {
  if (!isEnabled()) return null;
  if (_steps.length === 0) return null;

  // CRITICAL: never let mkdir/file failures escape this function — it runs
  // inside a `finally` block in sendDirectMessage, and any throw here would
  // replace the original outcome (e.g. premium_required / sent / failed)
  // with an EACCES exception, causing the executor to misclassify the
  // action as a hard failure and potentially abort the whole run.
  let artifactsDir;
  try {
    artifactsDir = resolveArtifactsDir();
  } catch (err) {
    logger.warn("LINKEDIN_DIAG", `Could not resolve artifacts dir: ${err.message}`);
    _steps = [];
    _sessionStart = null;
    return null;
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(artifactsDir, `${ts}-linkedin-dm-diagnostics.json`);

  const report = {
    profileUrl,
    sessionStart: _sessionStart
      ? new Date(_sessionStart).toISOString()
      : null,
    totalSteps: _steps.length,
    steps: _steps,
  };

  try {
    fs.writeFileSync(filePath, JSON.stringify(report, null, 2), "utf8");
    logger.info("LINKEDIN_DIAG", `Diagnostics written to ${filePath}`, {
      profileUrl,
      steps: _steps.length,
    });
  } catch (err) {
    logger.warn("LINKEDIN_DIAG", `Failed to write diagnostics: ${err.message}`);
  }

  // Reset
  _steps = [];
  _sessionStart = null;

  return filePath;
}

/**
 * List recent diagnostics files from the artifacts directory.
 *
 * @param {number} [limit=20] - Max files to return
 * @returns {Array<{filename, path, sizeBytes, modifiedAt}>}
 */
function listRecentDiagnostics(limit = 20) {
  const artifactsDir = path.resolve(
    process.env.AUTOMATION_ARTIFACTS_DIR || "./artifacts/automation",
  );

  try {
    const files = fs
      .readdirSync(artifactsDir)
      .filter((f) => f.includes("linkedin-dm-diagnostics") && f.endsWith(".json"))
      .map((f) => {
        const fullPath = path.join(artifactsDir, f);
        const stat = fs.statSync(fullPath);
        return {
          filename: f,
          path: fullPath,
          sizeBytes: stat.size,
          modifiedAt: stat.mtime.toISOString(),
        };
      })
      .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
      .slice(0, limit);

    return files;
  } catch (_) {
    return [];
  }
}

/**
 * Read and parse a diagnostics file.
 *
 * @param {string} filePath - Absolute path to the diagnostics JSON file
 * @returns {object|null}
 */
function readDiagnosticsFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {
    return null;
  }
}

module.exports = {
  capture,
  flush,
  listRecentDiagnostics,
  readDiagnosticsFile,
  isEnabled,
};
