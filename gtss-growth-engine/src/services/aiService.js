const logger = require("../utils/logger");
const { generateTextViaGeminiWeb } = require("../automation/geminiWeb");

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES_PER_MODEL = 2;

function cleanGeminiText(text) {
  return String(text || "")
    .trim()
    .replace(/^```(?:json|text)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .replace(/^["']|["']$/g, "")
    .trim();
}

/**
 * Calls the Gemini API with fallback models.
 * @param {string} prompt The text prompt to send to Gemini.
 * @returns {Promise<{text: string, source: string, model?: string}>}
 */
async function callGeminiTextViaApi(prompt, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set in environment");

  const primaryModel = process.env.GEMINI_MODEL || "gemini-2.0-flash";
  const modelsToTry = [
    ...new Set([
      primaryModel,
      "gemini-2.0-flash",
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
      "gemini-flash-latest",
    ]),
  ];

  let lastError;
  for (const model of modelsToTry) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    for (let attempt = 0; attempt < MAX_RETRIES_PER_MODEL; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
          signal: controller.signal,
        });

        clearTimeout(timer);

        if (!response.ok) {
          const errorBody = await response.text().catch(() => "");
          const isRetryableModel = [429, 404, 503].includes(response.status);
          lastError = new Error(
            `Gemini API error ${response.status} for model ${model}: ${errorBody}`,
          );
          lastError.status = response.status;

          if (isRetryableModel) {
            logger.warn("GEMINI", `Error ${response.status} for model ${model}`, {
              attempt: attempt + 1,
              error: errorBody,
            });
            if (attempt < MAX_RETRIES_PER_MODEL - 1) {
              await new Promise((resolve) =>
                setTimeout(resolve, 1000 * Math.pow(2, attempt)),
              );
              continue;
            }
            break;
          }

          throw lastError;
        }

        let data;
        try {
          data = await response.json();
        } catch (err) {
          const parseError = new Error("Invalid JSON in Gemini response");
          parseError.status = "parse_failed";
          throw parseError;
        }

        const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!rawText) throw new Error("Empty response from Gemini API");

        return { text: cleanGeminiText(rawText), source: "api", model };
      } catch (err) {
        clearTimeout(timer);

        if (err.name === "AbortError") {
          logger.warn(
            "GEMINI",
            `Request timed out after ${timeoutMs}ms for model ${model}`,
            { attempt: attempt + 1 },
          );
          lastError = new Error(
            `Gemini request timed out after ${timeoutMs}ms (model: ${model})`,
          );
          lastError.status = "timeout";
          break;
        }

        if ([429, 404, 503].includes(Number(err.status))) {
          logger.warn("GEMINI", `Fallback triggered for model ${model}`, {
            attempt: attempt + 1,
            error: err.message,
          });
          lastError = err;
          if (attempt < MAX_RETRIES_PER_MODEL - 1) {
            await new Promise((resolve) =>
              setTimeout(resolve, 1000 * Math.pow(2, attempt)),
            );
            continue;
          }
          break;
        }

        throw err;
      }
    }
  }

  throw lastError || new Error("All Gemini models exhausted");
}

/**
 * Gemini text generation with the same cascade used by Generate All:
 *   1. Gemini API (multi-model retries)
 *   2. Gemini Web (browser session) — unless disableWebFallback
 * Callers that still fail after Web should apply their own emergency
 * template path (message generation stamps template-fallback).
 *
 * NOTE: Timeouts and parse failures used to skip Web. That made bulk
 * "Retry Fallbacks" look API-only when the free tier was slow/429'd into
 * timeouts. Web is now always attempted after any API failure.
 */
async function callGeminiText(prompt, options = {}) {
  const onProgress =
    typeof options.onProgress === "function" ? options.onProgress : null;

  let apiErr = null;
  try {
    if (onProgress) onProgress({ stage: "api", message: "Trying Gemini API..." });
    const apiResult = await callGeminiTextViaApi(prompt, options);
    if (onProgress) {
      onProgress({
        stage: "api_ok",
        message: `Gemini API ok (${apiResult.model || "model"})`,
        source: "api",
        model: apiResult.model,
      });
    }
    return apiResult;
  } catch (err) {
    apiErr = err;
  }

  if (options.disableWebFallback) {
    throw apiErr;
  }

  logger.warn("GEMINI", "API path failed, falling back to Gemini Web", {
    error: apiErr?.message,
    status: apiErr?.status,
  });
  if (onProgress) {
    onProgress({
      stage: "web",
      message: `Gemini API failed (${apiErr?.status || "error"}); trying Gemini Web browser...`,
      error: apiErr?.message,
    });
  }

  try {
    const text = await generateTextViaGeminiWeb(prompt, (event, message, data) => {
      logger.db("info", "content", "gemini_web_text", message || event, {
        event,
        ...(data || {}),
      });
      if (onProgress) {
        onProgress({
          stage: "web_event",
          event,
          message: message || event,
          data: data || null,
        });
      }
    });
    logger.info("GEMINI", "Text generated via Gemini Web fallback");
    if (onProgress) {
      onProgress({
        stage: "web_ok",
        message: "Gemini Web ok",
        source: "web",
      });
    }
    return { text: cleanGeminiText(text), source: "web" };
  } catch (webErr) {
    logger.warn("GEMINI", "Gemini Web fallback also failed", {
      apiError: apiErr?.message,
      webError: webErr?.message,
    });
    if (onProgress) {
      onProgress({
        stage: "web_failed",
        message: `Gemini Web failed: ${webErr.message}`,
        error: webErr.message,
      });
    }
    // Prefer the web error when both failed so operators see the browser
    // path issue; keep api cause for diagnostics.
    const combined = new Error(
      `Gemini API and Web both failed. API: ${apiErr?.message || "n/a"}; Web: ${webErr.message}`,
    );
    combined.status = webErr.status || apiErr?.status || "all_sources_failed";
    combined.apiError = apiErr;
    combined.webError = webErr;
    throw combined;
  }
}

function unwrapGeminiText(result) {
  if (result && typeof result === "object" && "text" in result) {
    return String(result.text || "");
  }
  return String(result || "");
}

module.exports = {
  callGeminiText,
  callGeminiTextViaApi,
  cleanGeminiText,
  unwrapGeminiText,
};
