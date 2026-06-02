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

async function callGeminiText(prompt, options = {}) {
  try {
    return await callGeminiTextViaApi(prompt, options);
  } catch (apiErr) {
    if (options.disableWebFallback || apiErr.status === "timeout" || apiErr.status === "parse_failed") {
      throw apiErr;
    }
    logger.warn("GEMINI", "All API text models exhausted, falling back to Gemini Web", {
      error: apiErr.message,
    });
    const text = await generateTextViaGeminiWeb(prompt, (event, message, data) => {
      logger.db("info", "content", "gemini_web_text", message || event, {
        event,
        ...(data || {}),
      });
    });
    logger.info("GEMINI", "Text generated via Gemini Web fallback");
    return { text: cleanGeminiText(text), source: "web" };
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
