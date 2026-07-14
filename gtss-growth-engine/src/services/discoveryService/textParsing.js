/**
 * Discovery Service — Text Parsing & Lead Snapshot Normalisation
 * Pure-function helpers that turn raw text/href snapshots captured from
 * LinkedIn / X / Facebook / Instagram search pages into normalised lead
 * records with role / company / location / website / follower-count inference.
 * Extracted from the original discoveryService.js for maintainability.
 */

const { resolveInstagramUsername } = require("../../utils/instagramUsername");
const {
  X_RESERVED_PROFILE_PATHS,
  X_RESERVED_SECOND_PATHS,
  FACEBOOK_RESERVED_PROFILE_PATHS,
  X_NOISE_LINE_PATTERNS,
} = require("./constants");

/**
 * Collapse whitespace and trim. Always returns a string (never null/undefined).
 */
function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Is this captured line clearly UI noise (Follow / Promoted / Verified / a URL /
 * a "1.2K followers" stat line) rather than bio content?
 */
function isNoiseLine(line) {
  const normalized = cleanText(line).toLowerCase();
  if (!normalized) return true;
  if (X_NOISE_LINE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return true;
  }
  if (/^https?:\/\//i.test(normalized) || /^www\./i.test(normalized)) return true;
  if (/^[a-z0-9.-]+\.[a-z]{2,}(?:\/.*)?$/i.test(normalized)) return true;
  if (/^\d[\d,\.\s]*(k|m|b)?\s+(followers?|following|posts?)$/i.test(normalized)) {
    return true;
  }
  return false;
}

/**
 * Extract a valid X handle from arbitrary text. Strips leading @ and matches
 * the first 1-30 char [A-Za-z0-9_] run.
 */
function normalizeXHandle(value) {
  const cleaned = cleanText(value).replace(/^@/, "");
  const match = cleaned.match(/[A-Za-z0-9_]{1,30}/);
  return match ? match[0] : "";
}

/**
 * Normalise an X (Twitter) profile URL. Returns "" for non-X hosts, reserved
 * paths (home/search/settings/etc.), or second-segment paths (status/photo/etc.).
 */
function normalizeXProfileUrl(value) {
  if (!value) return "";

  try {
    const parsed = new URL(value, "https://x.com");
    const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    const isXHost =
      host === "x.com" || host.endsWith(".x.com") || host === "twitter.com" || host.endsWith(".twitter.com");

    if (!host || !isXHost) {
      return "";
    }

    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length === 0) return "";

    const handle = normalizeXHandle(segments[0]);
    if (!handle || X_RESERVED_PROFILE_PATHS.has(handle.toLowerCase())) {
      return "";
    }

    const secondSegment = (segments[1] || "").toLowerCase();
    if (secondSegment && X_RESERVED_SECOND_PATHS.has(secondSegment)) {
      return "";
    }

    return `https://x.com/${handle}`;
  } catch (_) {
    return "";
  }
}

/**
 * Normalise a Facebook profile URL. Accepts both /profile.php?id=123 and
 * /username forms. Returns "" for non-FB hosts and reserved top-level paths.
 */
function normalizeFacebookProfileUrl(value) {
  if (!value) return "";

  try {
    const parsed = new URL(value, "https://www.facebook.com");
    const host = parsed.hostname.replace(/^www\.|^m\.|^mbasic\./i, "").toLowerCase();
    const isFacebookHost = host === "facebook.com" || host.endsWith(".facebook.com");
    if (!isFacebookHost) return "";

    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length === 0) return "";

    if (segments[0] === "profile.php") {
      const id = parsed.searchParams.get("id");
      if (!id || !/^\d+$/.test(id)) return "";
      return `https://www.facebook.com/profile.php?id=${id}`;
    }

    const slug = cleanText(segments[0]).replace(/^@/, "");
    if (
      !slug ||
      FACEBOOK_RESERVED_PROFILE_PATHS.has(slug.toLowerCase()) ||
      !/^[A-Za-z0-9.][A-Za-z0-9._-]{2,}$/.test(slug)
    ) {
      return "";
    }

    return `https://www.facebook.com/${slug}`;
  } catch (_) {
    return "";
  }
}

/**
 * Extract the first http(s):// or www. URL from arbitrary text. Returns "" if
 * the only URL found is x.com / twitter.com / t.co (we don't want to record
 * X's own links as the lead's "website").
 */
function extractFirstUrl(text) {
  const raw = String(text || "").match(/\bhttps?:\/\/[^\s)]+|\bwww\.[^\s)]+/i);
  if (!raw) return "";

  const candidate = raw[0].replace(/[.,;:!?]+$/g, "");
  try {
    const normalized = candidate.startsWith("http") ? candidate : `https://${candidate}`;
    const parsed = new URL(normalized);
    const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    if (!host || host === "x.com" || host === "twitter.com" || host === "t.co") {
      return "";
    }
    return parsed.toString().replace(/\/$/, "");
  } catch (_) {
    return "";
  }
}

/**
 * Extract the lead's personal website from a card snapshot: prefer direct hrefs
 * to non-X hosts, fall back to a URL embedded in the text body.
 */
function extractWebsiteFromSnapshot(hrefs, text) {
  const directHref = (Array.isArray(hrefs) ? hrefs : [])
    .map((href) => {
      try {
        const parsed = new URL(href, "https://x.com");
        const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
        if (!host || host === "x.com" || host === "twitter.com" || host === "t.co") {
          return "";
        }
        return parsed.toString().replace(/\/$/, "");
      } catch (_) {
        return "";
      }
    })
    .find(Boolean);

  return directHref || extractFirstUrl(text);
}

/**
 * Pull a "1.2K followers" / "3 followers" count out of a card's text.
 */
function extractFollowerCount(text) {
  const match = cleanText(text).match(/\b([\d.,]+(?:\s?[KMB])?)\s+followers?\b/i);
  return match ? cleanText(match[1]) : "";
}

/**
 * Best-effort role + company inference from a bio string. Tries two named-group
 * patterns first ("Founder at ACME", "Designer – Studio"), then falls back to
 * two independent keyword regexes. Returns { role, company } (either may be "").
 */
function inferRoleCompanyFromBio(bio) {
  const normalized = cleanText(bio).replace(/[•·|]+/g, " ");
  if (!normalized) return { role: "", company: "" };

  const patterns = [
    /^(?<role>[A-Za-z][A-Za-z0-9&'()\-\/ ]{1,80}?)\s+(?:at|@|for|with)\s+(?<company>[A-Za-z0-9][A-Za-z0-9&'().,\-\/ ]{1,80})$/i,
    /^(?<role>[A-Za-z][A-Za-z0-9&'()\-\/ ]{1,80}?)\s*[–-]\s*(?<company>[A-Za-z0-9][A-Za-z0-9&'().,\-\/ ]{1,80})$/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match) continue;

    const role = cleanText(match.groups.role);
    const company = cleanText(match.groups.company);
    if (
      role &&
      company &&
      /founder|co-founder|ceo|cto|cmo|coo|vp|head|director|manager|lead|engineer|designer|developer|writer|creator|marketer|sales|growth|product|consultant|advisor|analyst|researcher|student|entrepreneur|builder|executive/i.test(
        role,
      )
    ) {
      return { role, company };
    }
  }

  const roleMatch = normalized.match(
    /\b(founder|co-founder|ceo|cto|cmo|coo|vp(?: of [^ ]+)?|head of [^|,;]+|director|manager|lead|engineer|designer|developer|writer|creator|marketer|sales|growth|product|consultant|advisor|analyst|researcher|student|entrepreneur|builder|executive)\b[^|,;]*/i,
  );
  const companyMatch = normalized.match(/(?:at|@|for|with)\s+([A-Za-z0-9][A-Za-z0-9&'().,\-\/ ]{1,80})/i);

  return {
    role: roleMatch ? cleanText(roleMatch[0]) : "",
    company: companyMatch ? cleanText(companyMatch[1]) : "",
  };
}

/**
 * Heuristic location extraction from a card's bio lines. Prefers lines that
 * explicitly mention "remote" / "worldwide" / known city names / a trailing
 * ",XX" country code, then falls back to the first short (≤60 char) line.
 */
function inferLocationFromLines(lines, text) {
  const candidates = (Array.isArray(lines) ? lines : []).map(cleanText).filter((line) => line && !isNoiseLine(line));

  const locationLike = candidates.find((line) => {
    const lower = line.toLowerCase();
    return (
      lower.includes("remote") ||
      lower.includes("worldwide") ||
      lower.includes("global") ||
      /\b(kenya|nairobi|mombasa|london|new york|san francisco|toronto|lagos|berlin|paris|india|usa|uk|canada|europe|africa|asia|singapore|dubai|sydney|melbourne)\b/i.test(
        lower,
      ) ||
      /,\s*[A-Za-z]{2,}$/.test(line)
    );
  });

  if (locationLike) return locationLike;

  const fallback = candidates.find((line) => line.length <= 60);
  return fallback || "";
}

/**
 * Convert an Instagram lead (as produced by automation/instagramDiscovery) into
 * the canonical lead-record shape used by the rest of the discovery pipeline.
 * Resolves the IG username through every fallback (ig_username / profile_url /
 * x_handle) and infers role + company from the bio.
 */
function mapInstagramLead(igLead, kw) {
  const bio = igLead.bio || igLead.ig_bio || "";
  const { role, company } = inferRoleCompanyFromBio(bio);
  const igUsername = resolveInstagramUsername({
    ig_username: igLead.username || igLead.ig_username || "",
    profile_url: igLead.profile_url || "",
    x_handle: igLead.x_handle || "",
  });

  let location = "";
  if (kw.startsWith("geolocation:")) {
    const parts = kw.split(":");
    location = parts[2] || "";
  }
  if (!location) {
    location = "Kenya";
  }

  return {
    platform: "instagram",
    name: igLead.display_name || igLead.name || igUsername || "",
    role: role || igLead.business_category || igLead.ig_business_category || "Owner",
    company: company || igLead.display_name || igLead.name || "",
    location: location,
    profile_url: igLead.profile_url || (igUsername ? `https://www.instagram.com/${igUsername}/` : ""),
    website: igLead.website || "",
    source_keyword: kw,
    // Add extra ig_ fields to ensure compatibility and full context
    ig_username: igUsername,
    ig_follower_count: igLead.follower_count || igLead.ig_follower_count || 0,
    ig_following_count: igLead.following_count || igLead.ig_following_count || 0,
    ig_post_count: igLead.post_count || igLead.ig_post_count || 0,
    ig_is_business: igLead.is_business !== undefined ? (igLead.is_business ? 1 : 0) : igLead.ig_is_business ? 1 : 0,
    ig_business_category: igLead.business_category || igLead.ig_business_category || null,
    ig_has_email: igLead.email || igLead.ig_has_email ? 1 : 0,
    ig_has_phone: igLead.phone || igLead.ig_has_phone ? 1 : 0,
    ig_bio: bio,
  };
}

/**
 * Turn a captured X search card snapshot (text + hrefs) into a normalised lead
 * record. Returns null if no profile URL or handle can be recovered.
 */
function parseXSearchLeadSnapshot(snapshot) {
  const rawText = String(snapshot && snapshot.text ? snapshot.text : "");
  const text = cleanText(rawText);
  const hrefs = Array.isArray(snapshot && snapshot.hrefs) ? snapshot.hrefs : [];
  const lines = rawText.split(/\r?\n/).map(cleanText).filter(Boolean);

  let profileUrl = hrefs.map(normalizeXProfileUrl).find(Boolean) || "";
  const handleFromUrl = profileUrl ? profileUrl.replace(/^https?:\/\/[^/]+\//i, "").split("/")[0] : "";
  const handleLine = lines.find((line) => /^@[A-Za-z0-9_.]{1,30}$/i.test(line));
  const handle = normalizeXHandle(handleLine || handleFromUrl || "");

  if (!profileUrl && handle) {
    profileUrl = `https://x.com/${handle}`;
  }

  if (!profileUrl && !handle) return null;

  const nameLine =
    lines.find((line) => !isNoiseLine(line) && !/^@[A-Za-z0-9_.]{1,30}$/i.test(line) && !/^https?:\/\//i.test(line)) ||
    handle ||
    "X profile";

  const bioCandidates = [];
  let skippedName = false;
  let skippedHandle = false;

  for (const line of lines) {
    if (!skippedName && line === nameLine) {
      skippedName = true;
      continue;
    }
    if (!skippedHandle && normalizeXHandle(line) === handle) {
      skippedHandle = true;
      continue;
    }
    if (isNoiseLine(line)) continue;
    bioCandidates.push(line);
  }

  const followerCount = extractFollowerCount(text);
  const website = extractWebsiteFromSnapshot(hrefs, text);
  const location = inferLocationFromLines(bioCandidates, text);
  const bio = cleanText(bioCandidates.filter((line) => line !== location && line !== website).join(" "));
  const inferred = inferRoleCompanyFromBio(bio);

  return {
    platform: "x",
    name: cleanText(nameLine) || handle || "X profile",
    handle,
    bio,
    role: inferred.role,
    company: inferred.company,
    location,
    website,
    follower_count: followerCount,
    profile_url: profileUrl,
  };
}

/**
 * Turn a captured Facebook search card snapshot into a normalised lead record.
 * Returns null if no profile URL or name can be recovered.
 */
function parseFacebookSearchSnapshot(snapshot) {
  const rawText = String(snapshot && snapshot.text ? snapshot.text : "");
  const hrefs = Array.isArray(snapshot && snapshot.hrefs) ? snapshot.hrefs : [];
  const lines = rawText.split(/\r?\n/).map(cleanText).filter(Boolean);
  const profileUrl = hrefs.map(normalizeFacebookProfileUrl).find(Boolean);
  if (!profileUrl) return null;

  const name =
    lines.find((line) => {
      if (isNoiseLine(line)) return false;
      if (/^(add friend|message|follow|see more|mutual friends?|friends?)$/i.test(line)) return false;
      if (/^\d+\s+mutual/i.test(line)) return false;
      return true;
    }) || "";

  if (!name) return null;

  const isFacebookNoiseLine = (line) =>
    isNoiseLine(line) ||
    /^(add friend|message|follow|see more|mutual friends?|friends?)$/i.test(line) ||
    /^\d+\s+mutual/i.test(line);
  const detailLines = lines.filter((line) => line !== name && !isFacebookNoiseLine(line));
  const location = inferLocationFromLines(
    detailLines.filter((line) => !/\b(at|founder|owner|ceo|manager|director|lead)\b/i.test(line)),
    rawText,
  );
  const bio = cleanText(detailLines.filter((line) => line !== location).join(" "));
  const inferred = inferRoleCompanyFromBio(bio);

  return {
    platform: "facebook",
    name,
    role: inferred.role,
    company: inferred.company,
    location,
    profile_url: profileUrl,
    website: "",
    status: "discovered",
  };
}

module.exports = {
  cleanText,
  isNoiseLine,
  normalizeXHandle,
  normalizeXProfileUrl,
  normalizeFacebookProfileUrl,
  extractFirstUrl,
  extractWebsiteFromSnapshot,
  extractFollowerCount,
  inferRoleCompanyFromBio,
  inferLocationFromLines,
  mapInstagramLead,
  parseXSearchLeadSnapshot,
  parseFacebookSearchSnapshot,
};
