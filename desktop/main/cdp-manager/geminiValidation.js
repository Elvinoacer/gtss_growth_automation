/**
 * cdp-manager/geminiValidation.js — Lightweight Gemini API key validation.
 *
 * Originally part of the monolithic desktop/main/cdp-manager.js. Exposes
 * validateGeminiApiKey(), which is invoked from the renderer during
 * onboarding (and from the Settings page later) so the user gets
 * immediate ✅/❌ feedback rather than having to start the server and
 * trigger a real Gemini call to find out.
 *
 * Validation strategy: hit the list-models endpoint, which is
 *   - cheap (returns a small JSON list),
 *   - doesn't consume quota,
 *   - returns 400 for malformed keys, 401/403 for invalid keys, 200 for valid.
 *
 * We treat 429 (quota exceeded) as VALID — the key itself is fine, the
 * user just hit their rate limit. We treat network errors as "unknown"
 * rather than "invalid" so a flaky connection doesn't falsely reject a
 * good key.
 */

"use strict";

async function validateGeminiApiKey(apiKey) {
  if (!apiKey || typeof apiKey !== "string") {
    return { ok: false, valid: false, reason: "API key is empty." };
  }
  const key = apiKey.trim();
  if (!key) {
    return { ok: false, valid: false, reason: "API key is empty." };
  }
  // Quick sanity check — every real AI Studio key starts with "AIza".
  if (!key.startsWith("AIza")) {
    return {
      ok: true,
      valid: false,
      reason: "That doesn't look like a Gemini API key (should start with 'AIza').",
    };
  }
  if (key.length < 30) {
    return {
      ok: true,
      valid: false,
      reason: "API key is too short — Gemini keys are usually ~39 characters.",
    };
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (res.status === 200) {
      return { ok: true, valid: true, reason: "API key is valid." };
    }
    // 429 = quota exceeded. The key itself is valid; the user just hit a
    // rate limit. Per requirements, we treat this as VALID.
    if (res.status === 429) {
      return {
        ok: true,
        valid: true,
        reason: "API key is valid (quota currently exceeded — ignored per validation policy).",
      };
    }
    if (res.status === 400) {
      return { ok: true, valid: false, reason: "Google rejected the key as malformed." };
    }
    if (res.status === 401 || res.status === 403) {
      let bodyText = "";
      try {
        bodyText = await res.text();
      } catch (_) {}
      const snippet = bodyText ? ` — ${bodyText.slice(0, 200)}` : "";
      return {
        ok: true,
        valid: false,
        reason: `Invalid API key (HTTP ${res.status})${snippet}`,
      };
    }
    return {
      ok: true,
      valid: false,
      reason: `Unexpected response from Google (HTTP ${res.status}).`,
    };
  } catch (err) {
    clearTimeout(timer);
    const isAbort = err && (err.name === "AbortError" || err.code === "ABORT_ERR");
    return {
      ok: false,
      valid: false,
      reason: isAbort
        ? "Validation timed out — check your internet connection and try again."
        : `Could not reach Google to validate the key: ${err.message || err}`,
    };
  }
}

module.exports = { validateGeminiApiKey };
