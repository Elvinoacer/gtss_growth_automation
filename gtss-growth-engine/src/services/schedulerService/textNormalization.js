/**
 * Scheduler Service — Caption/Body Text Normalization
 * decodeHtmlEntities, normalizeLinkedInText, normalizePlainPostText,
 * truncateForLimit, preparePlatformPostBody — text cleanup helpers that
 * strip markdown / smart quotes / HTML entities, enforce per-platform
 * character limits (LinkedIn 3000, X 280, etc.), and dispatch on
 * platform to produce the body that actually gets typed into the
 * composer.
 * Extracted from the original schedulerService.js for maintainability.
 */

const { POST_CHAR_LIMITS } = require("./constants");

function decodeHtmlEntities(text) {
  const entityMap = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };

  return String(text ?? "").replace(
    /&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g,
    (match, entity) => {
      if (entity.startsWith("#x") || entity.startsWith("#X")) {
        const codePoint = Number.parseInt(entity.slice(2), 16);
        return Number.isNaN(codePoint)
          ? match
          : String.fromCodePoint(codePoint);
      }

      if (entity.startsWith("#")) {
        const codePoint = Number.parseInt(entity.slice(1), 10);
        return Number.isNaN(codePoint)
          ? match
          : String.fromCodePoint(codePoint);
      }

      return entityMap[entity] || match;
    },
  );
}

function normalizeLinkedInText(text) {
  let normalized = decodeHtmlEntities(text)
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00A0/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/!\[([^\]]*)\]\((.*?)\)/g, "$1")
    .replace(/\[([^\]]+)\]\((.*?)\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/^\s*[-*+•]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[\u200B-\u200D\uFEFF]/g, "");

  normalized = normalized
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // Enforce LinkedIn's 3000-char published limit. Without this, an
  // oversized AI-generated body would silently disable the Post button
  // (LinkedIn's composer flips the button red and unclickable above 3000)
  // and the publish step would time out at the click. Truncating here with
  // an ellipsis keeps the post under the limit and the click responsive.
  const LINKEDIN_LIMIT = POST_CHAR_LIMITS.linkedin || 3000;
  if (normalized.length > LINKEDIN_LIMIT) {
    const suffix = "…";
    const hardLimit = LINKEDIN_LIMIT - suffix.length;
    // Try to break on a word boundary in the last 15% of the limit so we
    // don't cut a word in half.
    const candidate = normalized.slice(0, hardLimit);
    const lastWs = candidate.search(/\s+\S*$/);
    const cutAt = lastWs > Math.floor(hardLimit * 0.85) ? lastWs : hardLimit;
    normalized = `${candidate.slice(0, cutAt).replace(/[.,;:!?-]+$/g, "")}${suffix}`;
  }

  return normalized;
}

function normalizePlainPostText(text) {
  return decodeHtmlEntities(text)
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00A0/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    // Strip markdown link/image syntax so we never post literal `[text](url)`
    // or `[link](link)` to platforms that don't render markdown (X, IG, FB).
    // Previously only LinkedIn's normalizer did this, so AI-generated
    // captions with markdown links leaked through to the other platforms.
    .replace(/!\[([^\]]*)\]\((.*?)\)/g, "$1")
    .replace(/\[([^\]]+)\]\((.*?)\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/^\s*[-*+•]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncateForLimit(text, limit) {
  const normalized = normalizePlainPostText(text);
  if (normalized.length <= limit) return normalized;

  const suffix = "...";
  const hardLimit = Math.max(0, limit - suffix.length);
  let candidate = normalized.slice(0, hardLimit).trimEnd();
  const lastWhitespace = candidate.search(/\s+\S*$/);
  if (lastWhitespace > Math.floor(limit * 0.72)) {
    candidate = candidate.slice(0, lastWhitespace).trimEnd();
  }

  return `${candidate.replace(/[.,;:!?-]+$/g, "")}${suffix}`.slice(0, limit);
}

function preparePlatformPostBody(platform, body) {
  const normalizedPlatform = String(platform || "").toLowerCase();

  if (normalizedPlatform === "linkedin") {
    return normalizeLinkedInText(body);
  }

  if (normalizedPlatform === "x") {
    return truncateForLimit(body, POST_CHAR_LIMITS.x);
  }

  const normalized = normalizePlainPostText(body);

  if (normalizedPlatform === "facebook") {
    // Facebook opens hashtag suggestion overlays while the caret sits at the
    // end of a tag. A trailing space commits the tag and keeps Post clickable.
    return /(^|\s)#[\p{L}\p{N}_]+$/u.test(normalized)
      ? `${normalized} `
      : normalized;
  }

  return normalized;
}

module.exports = {
  decodeHtmlEntities,
  normalizeLinkedInText,
  normalizePlainPostText,
  truncateForLimit,
  preparePlatformPostBody,
};
