/**
 * Discovery Service — LinkedIn Search Extraction & Optional-Field Normalisers
 * Helpers that turn LinkedIn people-search result anchors into normalised lead
 * records, plus the optional text/integer/flag normalisers consumed by the
 * persistence layer (persistence.js) when building a DB-ready lead record.
 * Extracted from the original discoveryService.js for maintainability.
 */

const { cleanText } = require("./textParsing");

/**
 * Normalise a LinkedIn profile URL: must contain /in/, drop query + hash,
 * strip trailing slash. Returns null if the URL is not a LinkedIn /in/ profile.
 */
function normalizeLinkedInProfileUrl(url) {
  try {
    const parsed = new URL(url, "https://www.linkedin.com");
    if (!parsed.pathname.includes("/in/")) return null;
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch (_) {
    return null;
  }
}

/**
 * Trim a value to a clean text string. Returns null for falsy / whitespace-only
 * inputs (so the DB column defaults to NULL rather than "").
 */
function normalizeOptionalText(value) {
  const text = cleanText(value);
  return text ? text : null;
}

/**
 * Coerce a value to a finite integer, or null. Used for follower / post counts.
 */
function normalizeOptionalInteger(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

/**
 * Coerce a value to a 0/1 flag. Accepts the strings "1/true/yes/y" -> 1 and
 * "0/false/no/n" -> 0, plus truthy/falsy coercion for any other type. Returns
 * null for empty input.
 */
function normalizeOptionalFlag(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return null;
    if (["1", "true", "yes", "y"].includes(normalized)) return 1;
    if (["0", "false", "no", "n"].includes(normalized)) return 0;
  }

  return value ? 1 : 0;
}

/**
 * In-page DOM scrape: walk every LinkedIn /in/ anchor, climb to its closest
 * list-item / entity-result card, extract name + role + location + company
 * from the card's text lines, and return a list of lead-shaped objects.
 * Subsequent .map() in extractLinkedInSearchResults() normalises the
 * profile_url via normalizeLinkedInProfileUrl and drops any that come back null.
 */
async function extractLinkedInSearchResults(page, max) {
  const rawLeads = await page.evaluate((limit) => {
    function clean(value) {
      return String(value || "")
        .replace(/\s+/g, " ")
        .trim();
    }

    function profileUrlFrom(anchor) {
      try {
        const url = new URL(anchor.getAttribute("href"), window.location.origin);
        if (!url.pathname.includes("/in/")) return null;
        url.search = "";
        url.hash = "";
        return url.toString().replace(/\/$/, "");
      } catch (_) {
        return null;
      }
    }

    function cardFor(anchor) {
      return (
        anchor.closest("li") ||
        anchor.closest("[data-view-name]") ||
        anchor.closest(".entity-result") ||
        anchor.parentElement
      );
    }

    function linesFor(card) {
      return clean(card ? card.innerText : "")
        .split("\n")
        .map(clean)
        .filter(Boolean)
        .filter((line) => !/^(message|connect|follow|view profile|ad|promoted)$/i.test(line));
    }

    function isLeadName(line) {
      const value = clean(line);
      return Boolean(value) &&
        !/^\d+(st|nd|rd|th)?$/i.test(value) &&
        !/\b(mutual connections?|are mutual|followers?|connections?)\b/i.test(value) &&
        !/^(message|connect|follow|view profile|ad|promoted)$/i.test(value);
    }

    const leads = [];
    const seen = new Set();
    const anchors = Array.from(document.querySelectorAll('a[href*="/in/"]'));

    for (const anchor of anchors) {
      if (leads.length >= limit) break;
      const profileUrl = profileUrlFrom(anchor);
      if (!profileUrl || seen.has(profileUrl)) continue;

      const card = cardFor(anchor);
      const lines = linesFor(card);
      const anchorText = clean(anchor.innerText);
      const firstLine = lines.find(isLeadName) || anchorText;
      const nameSource = isLeadName(anchorText) ? anchorText : firstLine;
      const name = clean(nameSource.replace(/\s*•\s*(1st|2nd|3rd\+?).*$/i, ""));
      // Do not turn relationship metadata into a lead. A later search pass
      // can collect the profile once LinkedIn renders its actual name anchor.
      if (!isLeadName(name)) continue;
      const role =
        lines.find((line) => line !== firstLine && !/mutual connection|followers|current:/i.test(line)) || "";
      const location = lines.find((line) => /kenya|nairobi|mombasa|county|city|area/i.test(line)) || "";
      const current = lines.find((line) => /^current:/i.test(line)) || "";
      const companyMatch = current.match(/ at (.+)$/i);

      seen.add(profileUrl);
      leads.push({
        platform: "linkedin",
        name: name || "LinkedIn profile",
        role,
        company: companyMatch ? companyMatch[1] : "",
        location,
        profile_url: profileUrl,
        website: "",
      });
    }

    return leads;
  }, max);

  return {
    selector: 'dom:a[href*="/in/"]',
    leads: rawLeads
      .map((lead) => ({
        ...lead,
        profile_url: normalizeLinkedInProfileUrl(lead.profile_url),
      }))
      .filter((lead) => lead.profile_url),
  };
}

module.exports = {
  normalizeLinkedInProfileUrl,
  normalizeOptionalText,
  normalizeOptionalInteger,
  normalizeOptionalFlag,
  extractLinkedInSearchResults,
};
