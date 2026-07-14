/**
 * DM Queue — Profile URL Normalisation & Cross-Lead Deduplication
 * Canonicalises social profile URLs (LinkedIn / X / Facebook / Instagram) to
 * a lowercase, protocol-free, trailing-slash-free, query-param-free string,
 * and produces every realistic stored variant so that the same physical person
 * can be matched across lead records whose URLs were saved with or without
 * https / www / slash.
 *
 * Extracted from the original dmQueue.js for maintainability.
 */

/**
 * Normalises a social profile URL to a canonical, lowercase, protocol-free,
 * trailing-slash-free, query-param-free string used for cross-lead deduplication.
 *
 * Examples that all collapse to the same value:
 *   https://www.linkedin.com/in/brian/
 *   https://linkedin.com/in/brian?trk=abc
 *   HTTPS://WWW.LINKEDIN.COM/IN/BRIAN
 *
 * @param {string} url
 * @returns {string} Normalised URL or '' if input is falsy
 */
function normalizeProfileUrl(url) {
  if (!url) return "";
  return String(url)
    .toLowerCase()
    .trim()
    .split("?")[0] // drop query params (trk=, originalSubdomain=, etc.)
    .replace(/\/+$/, "") // drop trailing slashes
    .replace(/^https?:\/\/(www\.)?/, ""); // drop protocol + optional www
}

/**
 * Returns every realistic stored form of a normalised profile URL so we can
 * match across leads whose URLs were saved with or without https/www/slash.
 *
 * @param {string} normalized - Output of normalizeProfileUrl()
 * @returns {string[]}
 */
function buildProfileUrlVariants(normalized) {
  const base = normalized.replace(/\/+$/, "");
  return [
    base,
    base + "/",
    "https://" + base,
    "https://" + base + "/",
    "https://www." + base,
    "https://www." + base + "/",
  ];
}

module.exports = {
  normalizeProfileUrl,
  buildProfileUrlVariants,
};
