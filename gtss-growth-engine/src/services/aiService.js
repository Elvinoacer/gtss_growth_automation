const logger = require("../utils/logger");
const { generateTextViaGeminiWeb } = require("../automation/geminiWeb");

/**
 * Calls the Gemini API with fallback models.
 * @param {string} prompt The text prompt to send to Gemini.
 * @returns {Promise<{text: string, source: string, model?: string}>}
 */
async function callGeminiTextViaApi(prompt) {
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

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        if (response.status === 429 || response.status === 404 || errorBody.includes("429") || errorBody.includes("404")) {
          logger.warn("GEMINI", `Error ${response.status} for model ${model}, trying next`, { error: errorBody });
          lastError = new Error(`Gemini API error ${response.status} for model ${model}: ${errorBody}`);
          continue; // Try next model
        }
        const finalError = new Error(`Gemini API error ${response.status}: ${errorBody}`);
        finalError.status = response.status;
        throw finalError;
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

      // Strip any code fences
      let cleaned = rawText.trim();
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
      cleaned = cleaned.replace(/^["']|["']$/g, "");

      return { text: cleaned.trim(), source: "api", model };
    } catch (err) {
      lastError = err;
      if (err.message.includes("429") || err.message.includes("404")) {
        logger.warn("GEMINI", `Fallback triggered for model ${model}`, { error: err.message });
        continue; // Try next model
      }
      throw err; // For other errors, throw immediately
    }
  }

  throw lastError;
}

async function callGeminiText(prompt) {
  try {
    return await callGeminiTextViaApi(prompt);
  } catch (apiErr) {
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
    return { text: String(text || "").trim(), source: "web" };
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
  unwrapGeminiText,
};
