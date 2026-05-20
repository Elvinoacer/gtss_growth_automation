const { getDb, isWithinLimit: dbIsWithinLimit } = require("../db/database");
const {
  createBrowser,
  closeBrowser,
  checkSessionExpired,
  captureFailureArtifact,
} = require("../automation/browserBase");
const { getPlatformKeys } = require("./platformCatalog");
const { broadcast } = require("./socketService");
const { resolveInstagramUsername } = require("../utils/instagramUsername");
const logger = require("../utils/logger");

const MAX_PROFILE_VISITS_PER_HOUR = 50;
const DEFAULT_MIN_DELAY_MS = 3000;
const DEFAULT_MAX_DELAY_MS = 15000;
const X_SEARCH_CARD_SELECTORS = ['[data-testid="UserCell"]', '[data-testid="cellInnerDiv"]'];
const X_RESERVED_PROFILE_PATHS = new Set([
  "home",
  "search",
  "explore",
  "messages",
  "notifications",
  "compose",
  "intent",
  "settings",
  "login",
  "i",
  "hashtag",
]);
const X_RESERVED_SECOND_PATHS = new Set([
  "status",
  "photo",
  "video",
  "search",
  "home",
  "explore",
  "messages",
  "compose",
  "intent",
  "settings",
  "notifications",
]);
const X_NOISE_LINE_PATTERNS = [
  /^follow$/i,
  /^following$/i,
  /^followers?$/i,
  /^posts?$/i,
  /^view profile$/i,
  /^view post$/i,
  /^message$/i,
  /^promoted$/i,
  /^ad$/i,
  /^verified$/i,
  /^premium$/i,
  /^subscribe$/i,
  /^join now$/i,
];
const visitTimestamps = [];
const jobStreams = new Map();
const stoppedJobs = new Set();
const jobEventHistory = new Map();

function listDiscoverySources() {
  return getPlatformKeys();
}

function registerJobStream(jobId, res) {
  const key = String(jobId);
  if (!jobStreams.has(key)) jobStreams.set(key, new Set());
  jobStreams.get(key).add(res);
  res.write(`data: ${JSON.stringify({ type: "connected", jobId })}\n\n`);
  (jobEventHistory.get(key) || []).forEach((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
  res.on("close", () => {
    const s = jobStreams.get(key);
    if (s) {
      s.delete(res);
      if (s.size === 0) jobStreams.delete(key);
    }
  });
}

function emitJobEvent(jobId, event) {
  const key = String(jobId);
  const h = jobEventHistory.get(key) || [];
  h.push(event);
  jobEventHistory.set(key, h.slice(-200));

  // Broadcast via Socket.IO
  broadcast("discovery:event", event);

  // Legacy SSE
  const s = jobStreams.get(key);
  if (s) {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    s.forEach((st) => st.write(payload));
  }
}

function closeJobStream(jobId) {
  const key = String(jobId);
  const s = jobStreams.get(key);
  if (s) {
    s.forEach((st) => st.end());
    jobStreams.delete(key);
  }
  setTimeout(() => jobEventHistory.delete(key), 5 * 60 * 1000);
}

function stopDiscovery(jobId) {
  stoppedJobs.add(String(jobId));
}
function isJobStopped(jobId) {
  return stoppedJobs.has(String(jobId));
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function randomActionDelay() {
  const min = Number(process.env.DISCOVERY_MIN_DELAY_MS || DEFAULT_MIN_DELAY_MS);
  const max = Number(process.env.DISCOVERY_MAX_DELAY_MS || DEFAULT_MAX_DELAY_MS);
  await delay(Math.floor(Math.random() * (max - min + 1)) + min);
}

async function enforceVisitLimit(emit) {
  const cutoff = Date.now() - 3600000;
  while (visitTimestamps.length && visitTimestamps[0] < cutoff) visitTimestamps.shift();
  if (visitTimestamps.length >= MAX_PROFILE_VISITS_PER_HOUR) {
    const wait = visitTimestamps[0] + 3600000 - Date.now();
    emit({
      type: "info",
      message: `Hourly visit limit reached. Pausing ${Math.ceil(wait / 1000)}s`,
    });
    await delay(wait);
  }
  visitTimestamps.push(Date.now());
}

/**
 * Check if the daily limit for a platform and action type has been reached.
 */
function isWithinLimit(platform, actionType) {
  return dbIsWithinLimit(platform, actionType);
}

async function createBrowserContext(platform) {
  const allowHeadless = process.env.ALLOW_HEADLESS_SOCIAL === "true";
  return createBrowser(platform, { headless: allowHeadless });
}

async function closeBrowserContext(platform, browserState) {
  if (!browserState) return;
  await withTimeout(
    closeBrowser(browserState.browser, platform, browserState.context, {
      mode: browserState.mode,
      tracePath: browserState.tracePath,
      shouldCloseBrowser: browserState.shouldCloseBrowser,
      lock: browserState.lock,
    }),
    Number(process.env.BROWSER_CLOSE_TIMEOUT_MS || 20_000),
    `${platform} browser close`,
  );
}

async function detectCaptcha(page, platform, emit) {
  const text = (
    await page
      .locator("body")
      .innerText()
      .catch(() => "")
  ).toLowerCase();
  const found = ["captcha", "verify you're human", "unusual activity"].some((t) => text.includes(t));
  if (found) emit({ type: "captcha", platform, message: "CAPTCHA detected" });
  return found;
}

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

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

function normalizeXHandle(value) {
  const cleaned = cleanText(value).replace(/^@/, "");
  const match = cleaned.match(/[A-Za-z0-9_]{1,30}/);
  return match ? match[0] : "";
}

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

function extractFollowerCount(text) {
  const match = cleanText(text).match(/\b([\d.,]+(?:\s?[KMB])?)\s+followers?\b/i);
  return match ? cleanText(match[1]) : "";
}

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

async function firstVisibleLocator(scope, selectors, timeout = 1500) {
  const deadline = Date.now() + timeout;

  for (const selector of selectors) {
    const locator = scope.locator(selector);
    const count = await locator.count().catch(() => 0);

    for (let index = 0; index < count; index++) {
      const candidate = locator.nth(index);
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;

      try {
        await candidate.waitFor({
          state: "visible",
          timeout: Math.min(300, remaining),
        });
        return candidate;
      } catch (_) {
        // Try the next matching candidate.
      }
    }
  }

  return null;
}

async function captureXSearchSnapshots(page, maxCards) {
  const selector = X_SEARCH_CARD_SELECTORS.join(", ");
  return page
    .evaluate(
      ({ selector: cardSelector, maxCards: limit }) => {
        const clean = (value) =>
          String(value || "")
            .replace(/\s+/g, " ")
            .trim();
        const container = document.querySelector('[data-testid="primaryColumn"]') || document;
        const cards = Array.from(container.querySelectorAll(cardSelector)).slice(0, Math.max(0, limit));

        return cards
          .map((card) => ({
            text: clean(card.innerText || ""),
            hrefs: Array.from(card.querySelectorAll("a[href]")).map((anchor) => anchor.getAttribute("href") || ""),
          }))
          .filter((snapshot) => snapshot.text || snapshot.hrefs.length);
      },
      { selector, maxCards },
    )
    .catch(() => []);
}

async function waitForXSearchResults(page) {
  return firstVisibleLocator(page, X_SEARCH_CARD_SELECTORS, 15000);
}

async function scrollXSearchResults(page) {
  const viewport =
    page.viewportSize() ||
    (await page
      .evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      }))
      .catch(() => ({ width: 1280, height: 800 })));
  const distance = Math.max(1200, Math.round(viewport.height * 1.25));

  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, distance).catch(() => {});
    await delay(800);
  }

  await delay(2000);
}

async function extractXSearchResults(page) {
  const snapshots = await withTimeout(captureXSearchSnapshots(page, 120), 25_000, "X search snapshot capture");

  const leads = [];
  const seen = new Set();

  for (const snapshot of snapshots) {
    const lead = parseXSearchLeadSnapshot(snapshot);
    if (!lead || !lead.profile_url) continue;

    const key = lead.profile_url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    leads.push(lead);
  }

  return {
    selector: 'dom:[data-testid="UserCell"], dom:[data-testid="cellInnerDiv"]',
    leads,
  };
}

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

function normalizeOptionalText(value) {
  const text = cleanText(value);
  return text ? text : null;
}

function normalizeOptionalInteger(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

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

function buildLeadPersistenceRecord(profile) {
  const platform = cleanText(profile.platform).toLowerCase();
  const name = normalizeOptionalText(profile.name || profile.display_name || profile.handle) || null;
  const role = normalizeOptionalText(profile.role) || null;
  const company = normalizeOptionalText(profile.company) || null;
  const location = normalizeOptionalText(profile.location) || null;
  const website = normalizeOptionalText(profile.website) || null;
  const sourceKeyword = normalizeOptionalText(profile.source_keyword) || null;
  let profileUrl = normalizeOptionalText(profile.profile_url);
  let xHandle = null;
  let igUsername = null;
  let igFollowerCount = null;
  let igFollowingCount = null;
  let igPostCount = null;
  let igIsBusiness = null;
  let igBusinessCategory = null;
  let igHasEmail = null;
  let igHasPhone = null;
  let igBio = null;

  if (platform === "instagram") {
    igUsername = resolveInstagramUsername(profile) || null;
    if (!profileUrl && igUsername) {
      profileUrl = `https://www.instagram.com/${igUsername}/`;
    }
    igFollowerCount = normalizeOptionalInteger(profile.ig_follower_count ?? profile.follower_count);
    igFollowingCount = normalizeOptionalInteger(profile.ig_following_count ?? profile.following_count);
    igPostCount = normalizeOptionalInteger(profile.ig_post_count ?? profile.post_count);
    igIsBusiness = normalizeOptionalFlag(profile.ig_is_business ?? profile.is_business);
    igBusinessCategory = normalizeOptionalText(profile.ig_business_category ?? profile.business_category) || null;
    igHasEmail = normalizeOptionalFlag(profile.ig_has_email ?? profile.email);
    igHasPhone = normalizeOptionalFlag(profile.ig_has_phone ?? profile.phone);
    igBio = normalizeOptionalText(profile.ig_bio ?? profile.bio) || null;
  } else if (platform === "x") {
    xHandle = normalizeXHandle(profile.x_handle || profile.handle || "") || null;
    if (!profileUrl && xHandle) {
      profileUrl = `https://x.com/${xHandle}`;
    }
  } else {
    xHandle = normalizeOptionalText(profile.x_handle || profile.handle) || null;
  }

  return {
    platform,
    name,
    role,
    company,
    location,
    profile_url: profileUrl,
    website,
    source_keyword: sourceKeyword,
    status: normalizeOptionalText(profile.status) || "discovered",
    x_handle: xHandle,
    ig_username: igUsername,
    ig_follower_count: igFollowerCount,
    ig_following_count: igFollowingCount,
    ig_post_count: igPostCount,
    ig_is_business: igIsBusiness,
    ig_business_category: igBusinessCategory,
    ig_has_email: igHasEmail,
    ig_has_phone: igHasPhone,
    ig_bio: igBio,
  };
}

function validateLeadPersistenceRecord(record) {
  const issues = [];

  if (!record.platform) {
    issues.push("missing platform");
  }

  if (!record.profile_url) {
    issues.push("missing profile_url");
  }

  if (record.platform === "instagram" && !record.ig_username) {
    issues.push("missing ig_username");
  }

  if (record.platform === "x" && !record.x_handle) {
    issues.push("missing x_handle");
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

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
      const firstLine = lines.find((line) => !/^\d+(st|nd|rd|th)?$/i.test(line)) || anchorText;
      const name = clean(firstLine.replace(/\s*•\s*(1st|2nd|3rd\+?).*$/i, ""));
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

async function discoverLeads(keyword, platforms, maxLeads, jobId) {
  const db = getDb();
  const emit = (e) => emitJobEvent(jobId, { ...e, jobId });
  const selected = platforms.filter((p) => listDiscoverySources().includes(p));
  let totalNewCollected = 0;
  let prePersistedNew = 0;
  const rawProfiles = [];
  const platformErrors = [];

  emit({
    type: "info",
    message: `Starting discovery for "${keyword}" (Goal: ${maxLeads} new leads)`,
  });

  try {
    for (const platform of selected) {
      if (isJobStopped(jobId)) break;
      if (totalNewCollected >= maxLeads) break;

      // Limit Check
      if (!isWithinLimit(platform, "visits")) {
        emit({
          type: "warn",
          platform,
          message: `Daily visit limit reached for ${platform}. Skipping.`,
        });
        continue;
      }

      const needed = maxLeads - totalNewCollected;
      emit({
        type: "info",
        platform,
        message: `Searching ${platform} for up to ${needed} more new leads...`,
      });

      try {
        const found = await withTimeout(
          platformDiscoveryMap[platform](keyword, needed, emit, jobId),
          Number(process.env.DISCOVERY_PLATFORM_TIMEOUT_MS || 300_000),
          `${platform} discovery`,
        );

        found.forEach((p) => {
          if (p && p.__prePersistedByDiscovery) {
            prePersistedNew++;
            totalNewCollected++;
            return;
          }

          // Check if this profile is already in our collected list or in the DB
          const isInBatch = rawProfiles.some((rp) => rp.profile_url === p.profile_url);
          const existsInDb = db.prepare("SELECT 1 FROM leads WHERE profile_url = ?").get(p.profile_url);

          if (!isInBatch && !existsInDb) {
            totalNewCollected++;
          }

          // We still push duplicates to rawProfiles so insertLeads can report them correctly,
          // but we only count non-duplicates toward our stopping goal.
          rawProfiles.push({ ...p, source_keyword: keyword });
        });

        if (totalNewCollected >= maxLeads) {
          emit({
            type: "info",
            message: `Target of ${maxLeads} new leads reached.`,
          });
          break;
        }
      } catch (e) {
        platformErrors.push(e);
        emit({ type: "error", platform, message: e.message });
      }
    }

    if (
      rawProfiles.length === 0 &&
      prePersistedNew === 0 &&
      platformErrors.length > 0 &&
      platformErrors.length >= selected.length
    ) {
      throw platformErrors[platformErrors.length - 1];
    }

    const result = insertLeads(rawProfiles);
    if (prePersistedNew > 0) {
      result.total += prePersistedNew;
      result.new += prePersistedNew;
    }
    db.prepare("UPDATE discovery_runs SET leads_found = ?, status = ? WHERE id = ?").run(
      result.new,
      isJobStopped(jobId) ? "stopped" : "completed",
      jobId,
    );
    emit({ type: "done", result });
    return result;
  } catch (e) {
    db.prepare("UPDATE discovery_runs SET status = ? WHERE id = ?").run("failed", jobId);
    emit({ type: "error", message: e.message });
    throw e;
  } finally {
    stoppedJobs.delete(String(jobId));
    closeJobStream(jobId);
  }
}

function insertLeads(profiles) {
  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO leads (
      platform, name, role, company, location, profile_url, website, source_keyword, status,
      x_handle, ig_username, ig_follower_count, ig_following_count, ig_post_count,
      ig_is_business, ig_business_category, ig_has_email, ig_has_phone, ig_bio
    )
    SELECT
      @platform, @name, @role, @company, @location, @profile_url, @website, @source_keyword, @status,
      @x_handle, @ig_username, @ig_follower_count, @ig_following_count, @ig_post_count,
      @ig_is_business, @ig_business_category, @ig_has_email, @ig_has_phone, @ig_bio
    WHERE NOT EXISTS (SELECT 1 FROM leads WHERE profile_url = @profile_url)
  `);
  let inserted = 0;
  let duplicates = 0;
  let invalid = 0;
  const tx = db.transaction((list) => {
    list.forEach((profile, index) => {
      const record = buildLeadPersistenceRecord(profile || {});
      const validation = validateLeadPersistenceRecord(record);

      if (!validation.valid) {
        invalid++;
        logger.warn("DISCOVERY_PERSISTENCE", "Skipping invalid lead payload", {
          index,
          platform: record.platform || "unknown",
          issues: validation.issues,
        });
        return;
      }

      const result = insert.run(record);
      if (result.changes > 0) {
        inserted++;
      } else {
        duplicates++;
      }
    });
  });
  tx(Array.isArray(profiles) ? profiles : []);

  logger.info("DISCOVERY_PERSISTENCE", "Lead persistence batch completed", {
    total: Array.isArray(profiles) ? profiles.length : 0,
    inserted,
    duplicates,
    invalid,
  });

  return {
    total: Array.isArray(profiles) ? profiles.length : 0,
    new: inserted,
    duplicates,
    invalid,
  };
}

// Minimal platform discovery mocks/impls for brevity, keeping existing logic
const platformDiscoveryMap = {
  linkedin: async (kw, max, emit, jobId) => {
    const browserState = await createBrowserContext("linkedin");
    const page = browserState.page;
    try {
      const searchUrl = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(kw)}&origin=GLOBAL_SEARCH_HEADER`;
      emit({
        type: "info",
        platform: "linkedin",
        message: "Opening LinkedIn people search...",
      });
      await page.goto(searchUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      emit({
        type: "info",
        platform: "linkedin",
        message: `LinkedIn page loaded: ${page.url()}`,
      });
      await delay(4000);

      emit({
        type: "info",
        platform: "linkedin",
        message: "Checking LinkedIn session and challenge state...",
      });
      if (
        await checkSessionExpired(page, "linkedin", (type, message) => emit({ type, platform: "linkedin", message }))
      ) {
        return [];
      }

      if (await detectCaptcha(page, "linkedin", emit)) {
        return [];
      }

      let allLeads = [];
      let newLeadsCount = 0;
      let pageNum = 1;
      const db = getDb();

      while (newLeadsCount < max && !isJobStopped(jobId)) {
        emit({
          type: "info",
          platform: "linkedin",
          message: `Extracting LinkedIn search results (Page ${pageNum})...`,
        });

        await page
          .locator(
            'a[href*="/in/"], li.reusable-search__result-container, [data-view-name="search-entity-result-universal-template"]',
          )
          .first()
          .waitFor({ state: "visible", timeout: 15000 })
          .catch(() => {
            emit({
              type: "warn",
              platform: "linkedin",
              message: "No LinkedIn result selector became visible before timeout; attempting extraction anyway.",
            });
          });

        const { selector, leads } = await withTimeout(
          extractLinkedInSearchResults(page, 100), // Get all available on this page
          30_000,
          "LinkedIn result extraction",
        );

        let foundNew = 0;
        for (const lead of leads) {
          // Skip if already found in this run
          if (allLeads.some((l) => l.profile_url === lead.profile_url)) continue;

          allLeads.push(lead);

          // Check DB to count if it's truly new
          const existing = db.prepare("SELECT 1 FROM leads WHERE profile_url = ?").get(lead.profile_url);
          if (!existing) {
            foundNew++;
            newLeadsCount++;
          }

          if (newLeadsCount >= max) break;
        }

        emit({
          type: "info",
          platform: "linkedin",
          message: `Extracted ${leads.length} leads from page ${pageNum} (${foundNew} new). Total new so far: ${newLeadsCount}/${max}.`,
        });

        if (newLeadsCount >= max || leads.length === 0) {
          break;
        }

        // Store first lead URL to verify page transition later
        const firstLeadUrl = leads[0]?.profile_url;

        // Scroll down in increments to trigger lazy loading of pagination
        await page.evaluate(async () => {
          for (let i = 0; i < 3; i++) {
            window.scrollBy(0, window.innerHeight);
            await new Promise((r) => setTimeout(r, 500));
          }
          window.scrollTo(0, document.body.scrollHeight);
        });
        await delay(2000);

        // Try multiple selectors for the Next button
        const nextButtonSelectors = [
          "button.artdeco-pagination__button--next:not([disabled])",
          'button[aria-label="Next"]:not([disabled])',
          'button:has-text("Next"):not([disabled])',
        ];

        let nextBtn = null;
        for (const selector of nextButtonSelectors) {
          const loc = page.locator(selector).first();
          if (await loc.isVisible().catch(() => false)) {
            nextBtn = loc;
            break;
          }
        }

        if (nextBtn) {
          emit({
            type: "info",
            platform: "linkedin",
            message: `Clicking Next page (current page ${pageNum})...`,
          });

          // Ensure it's in view
          await nextBtn.scrollIntoViewIfNeeded().catch(() => {});
          await nextBtn.click({ timeout: 5000 }).catch(async () => {
            // Fallback: force click via evaluate if normal click fails
            await page.evaluate(
              (sel) => {
                const btn = document.querySelector(sel);
                if (btn) btn.click();
              },
              await nextBtn
                .evaluate((node) => {
                  // Get a simple selector for the evaluate call
                  return node.className
                    ? `.${node.className.split(" ").join(".")}`
                    : "button.artdeco-pagination__button--next";
                })
                .catch(() => "button.artdeco-pagination__button--next"),
            );
          });

          pageNum++;

          // Wait for the page content to actually change
          // We wait for the first lead of the previous page to disappear or for a new list to appear
          emit({
            type: "info",
            platform: "linkedin",
            message: "Waiting for next page results to load...",
          });

          if (firstLeadUrl) {
            const profileSnippet = firstLeadUrl.split("/in/")[1]?.split("/")[0];
            if (profileSnippet) {
              // Wait for the old result to vanish or a timeout
              await page
                .waitForFunction(
                  (oldSnippet) => {
                    return !document.body.innerText.includes(oldSnippet);
                  },
                  profileSnippet,
                  { timeout: 10000 },
                )
                .catch(() => {
                  emit({
                    type: "warn",
                    platform: "linkedin",
                    message: "Page transition check timed out; content might still be loading.",
                  });
                });
            }
          }

          await delay(3000); // Base safety delay for AJAX
        } else {
          emit({
            type: "info",
            platform: "linkedin",
            message: "No 'Next' button found or it is disabled. Ending search.",
          });
          break;
        }
      }
      return allLeads;
    } catch (error) {
      await captureFailureArtifact(page, "linkedin", "discovery-linkedin");
      throw error;
    } finally {
      emit({
        type: "info",
        platform: "linkedin",
        message: "Closing LinkedIn discovery browser...",
      });
      await closeBrowserContext("linkedin", browserState);
    }
  },
  x: async (kw, max, emit, jobId) => {
    const browserState = await createBrowserContext("x");
    const page = browserState.page;
    const db = getDb();
    const searchUrl = `https://x.com/search?q=${encodeURIComponent(kw)}&f=user`;
    const rawLeads = [];
    const seen = new Set();
    let totalNewCount = 0;
    let stagnantRounds = 0;
    let pass = 0;

    try {
      emit({
        type: "info",
        platform: "x",
        message: "Opening X people search...",
      });

      await enforceVisitLimit(emit);

      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          await withTimeout(
            page.goto(searchUrl, {
              waitUntil: "domcontentloaded",
              timeout: 60000,
            }),
            60000,
            "X search navigation",
          );
          break;
        } catch (error) {
          if (attempt === 2) throw error;

          emit({
            type: "warn",
            platform: "x",
            message: `X search navigation attempt ${attempt} failed: ${error.message}. Retrying...`,
          });
          await delay(1500 * attempt);
        }
      }

      emit({
        type: "info",
        platform: "x",
        message: `X search page loaded: ${page.url()}`,
      });

      await delay(2500);

      if (await checkSessionExpired(page, "x", (type, message) => emit({ type, platform: "x", message }))) {
        emit({
          type: "warn",
          platform: "x",
          message: "X session is not authenticated or has expired before discovery started.",
        });
        await captureFailureArtifact(page, "x", "discovery-x-session-expired");
        return [];
      }

      await waitForXSearchResults(page).catch(() => {
        emit({
          type: "warn",
          platform: "x",
          message: "No visible X user result cards yet; continuing with scroll-based retries.",
        });
      });

      while (totalNewCount < max && !isJobStopped(jobId)) {
        pass += 1;

        emit({
          type: "info",
          platform: "x",
          message: `Extracting X search results (pass ${pass})...`,
        });

        const { selector, leads } = await withTimeout(
          extractXSearchResults(page),
          Number(process.env.DISCOVERY_PLATFORM_TIMEOUT_MS || 300_000),
          "X search extraction",
        );

        let newOnPass = 0;
        for (const lead of leads) {
          const dedupeKey = String(lead.profile_url || "").toLowerCase();
          if (!dedupeKey || seen.has(dedupeKey)) continue;

          seen.add(dedupeKey);
          const existsInDb = db.prepare("SELECT 1 FROM leads WHERE profile_url = ?").get(lead.profile_url);

          if (!existsInDb) {
            totalNewCount += 1;
            newOnPass += 1;
          }

          rawLeads.push({
            ...lead,
            source_keyword: kw,
          });

          if (totalNewCount >= max) break;
        }

        emit({
          type: "info",
          platform: "x",
          message: `Extracted ${leads.length} X profiles from pass ${pass} (${newOnPass} new) using ${selector}. Total new so far: ${totalNewCount}/${max}.`,
        });

        if (totalNewCount >= max) {
          emit({
            type: "info",
            platform: "x",
            message: `Target of ${max} new X leads reached.`,
          });
          break;
        }

        if (newOnPass === 0) {
          stagnantRounds += 1;
        } else {
          stagnantRounds = 0;
        }

        if (stagnantRounds >= 5) {
          emit({
            type: "info",
            platform: "x",
            message: "No new X results after repeated scrolls; ending search.",
          });
          break;
        }

        emit({
          type: "info",
          platform: "x",
          message: "Scrolling X search results to load more users...",
        });

        await enforceVisitLimit(emit);
        await scrollXSearchResults(page);
        await page
          .locator('[data-testid="UserCell"]')
          .nth(0)
          .waitFor({ state: "visible", timeout: 5000 })
          .catch(() => {});
        await randomActionDelay();

        if (await checkSessionExpired(page, "x", (type, message) => emit({ type, platform: "x", message }))) {
          emit({
            type: "warn",
            platform: "x",
            message: "X session expired during discovery; returning partial results collected so far.",
          });
          await captureFailureArtifact(page, "x", "discovery-x-session-expired");
          break;
        }
      }

      return rawLeads;
    } catch (error) {
      await captureFailureArtifact(page, "x", "discovery-x");
      throw error;
    } finally {
      await closeBrowserContext("x", browserState);
    }
  },
  instagram: async (kw, max, emit, jobId) => {
    const {
      discoverViaHashtag,
      discoverViaGeolocation,
      discoverViaCompetitorFollowers,
    } = require("../automation/instagramDiscovery");

    const browserState = await createBrowserContext("instagram");
    const page = browserState.page;
    let rawLeads = [];

    try {
      emit({
        type: "info",
        platform: "instagram",
        message: "Opening Instagram browser for discovery...",
      });

      const progressEmitter = (type, message, data) => {
        emit({ type, platform: "instagram", message, ...data });
      };

      let result;
      if (kw.startsWith("#")) {
        const hashtag = kw.substring(1);
        result = await discoverViaHashtag(page, { hashtag, maxLeads: max }, progressEmitter);
      } else if (kw.startsWith("geolocation:")) {
        const parts = kw.split(":");
        const locationId = parts[1];
        const locationName = parts[2];
        result = await discoverViaGeolocation(page, { locationId, locationName, maxLeads: max }, progressEmitter);
      } else if (kw.startsWith("competitor_followers:")) {
        const targetAccount = kw.substring("competitor_followers:".length);
        result = await discoverViaCompetitorFollowers(page, { targetAccount, maxProfiles: max }, progressEmitter);
      } else if (kw.startsWith("competitor:")) {
        const targetAccount = kw.substring("competitor:".length);
        result = await discoverViaCompetitorFollowers(page, { targetAccount, maxProfiles: max }, progressEmitter);
      } else {
        throw new Error(
          `Invalid Instagram discovery input format: "${kw}". Must start with '#', 'geolocation:', 'competitor_followers:', or 'competitor:'.`,
        );
      }

      if (result && result.success === false) {
        throw new Error(result.error || "Instagram discovery failed");
      }

      if (result && result.leads) {
        rawLeads = result.leads.map((lead) => ({
          ...mapInstagramLead(lead, kw),
          __prePersistedByDiscovery: true,
        }));
      }
      return rawLeads;
    } catch (error) {
      await captureFailureArtifact(page, "instagram", "discovery-instagram");
      throw error;
    } finally {
      emit({
        type: "info",
        platform: "instagram",
        message: "Closing Instagram discovery browser...",
      });
      await closeBrowserContext("instagram", browserState);
    }
  },
  facebook: async (kw, max, emit, jobId) => {
    const browserState = await createBrowserContext("facebook");
    const page = browserState.page;
    const db = getDb();
    const searchUrl = `https://www.facebook.com/search/people/?q=${encodeURIComponent(kw)}`;
    const rawLeads = [];
    const seen = new Set();
    let totalNewCount = 0;
    let stagnantRounds = 0;
    const MAX_STAGNANT = 4;
    const MAX_SCROLL_PASSES = 15;

    try {
      emit({ type: "info", platform: "facebook", message: "Opening Facebook People search..." });

      await enforceVisitLimit(emit);

      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          await withTimeout(
            page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60000 }),
            60000,
            "Facebook search navigation",
          );
          break;
        } catch (err) {
          if (attempt === 2) throw err;
          emit({
            type: "warn",
            platform: "facebook",
            message: `Navigation attempt ${attempt} failed: ${err.message}. Retrying...`,
          });
          await delay(2000);
        }
      }

      emit({ type: "info", platform: "facebook", message: `Facebook search loaded: ${page.url()}` });
      await delay(3000);

      if (
        await checkSessionExpired(page, "facebook", (type, message) => emit({ type, platform: "facebook", message }))
      ) {
        emit({ type: "warn", platform: "facebook", message: "Facebook session expired before discovery started." });
        return [];
      }

      for (let pass = 1; pass <= MAX_SCROLL_PASSES; pass++) {
        if (isJobStopped(jobId)) break;
        if (totalNewCount >= max) break;

        emit({ type: "info", platform: "facebook", message: `Extracting Facebook results (pass ${pass})...` });

        const cards = await page
          .evaluate(() => {
            const results = [];
            const anchors = Array.from(document.querySelectorAll('a[href*="facebook.com/"], a[href^="/"]'));

            for (const a of anchors) {
              const href = a.href || "";
              if (!href) continue;

              if (
                !href.includes("/profile.php?id=") &&
                !/facebook\.com\/[A-Za-z0-9._-]{3,}$/.test(href.replace(/\?.*$/, ""))
              )
                continue;

              const skip = [
                "/search",
                "/events",
                "/groups",
                "/marketplace",
                "/pages",
                "/videos",
                "/photos",
                "/stories",
                "/gaming",
                "/fundraisers",
                "/friends",
              ];
              if (skip.some((s) => href.includes(s))) continue;

              const nameEl = a.querySelector("span") || a.closest("[role='article']")?.querySelector("span");
              const name = (nameEl?.innerText || "").trim();
              if (!name) continue;

              let profileUrl = href;
              try {
                const parsed = new URL(profileUrl);
                parsed.search = "";
                parsed.hash = "";
                profileUrl = parsed.toString().replace(/\/$/, "");
              } catch (_) {}

              results.push({ name, profile_url: profileUrl, platform: "facebook" });
            }

            return results;
          })
          .catch(() => []);

        let newOnPass = 0;
        for (const card of cards) {
          if (!card.profile_url) continue;
          const key = card.profile_url.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);

          const existsInDb = db.prepare("SELECT 1 FROM leads WHERE profile_url = ?").get(card.profile_url);
          if (!existsInDb) {
            totalNewCount += 1;
            newOnPass += 1;
          }

          rawLeads.push({
            platform: "facebook",
            name: card.name || "",
            role: "",
            company: "",
            location: "",
            profile_url: card.profile_url,
            website: "",
            status: "discovered",
          });

          if (totalNewCount >= max) break;
        }

        emit({
          type: "info",
          platform: "facebook",
          message: `Pass ${pass}: found ${cards.length} cards, ${newOnPass} new. Total new: ${totalNewCount}/${max}.`,
        });

        if (totalNewCount >= max) break;

        if (newOnPass === 0) {
          stagnantRounds += 1;
        } else {
          stagnantRounds = 0;
        }

        if (stagnantRounds >= MAX_STAGNANT) {
          emit({
            type: "info",
            platform: "facebook",
            message: "No new Facebook results after repeated scrolls; ending search.",
          });
          break;
        }

        await page.evaluate(() => window.scrollBy(0, window.innerHeight * 1.5)).catch(() => {});
        await delay(2500);
        await enforceVisitLimit(emit);
      }

      return rawLeads;
    } catch (error) {
      await captureFailureArtifact(page, "facebook", "discovery-facebook");
      throw error;
    } finally {
      emit({ type: "info", platform: "facebook", message: "Closing Facebook discovery browser..." });
      await closeBrowserContext("facebook", browserState);
    }
  },
};

module.exports = {
  discoverLeads,
  listDiscoverySources,
  registerJobStream,
  emitJobEvent,
  closeJobStream,
  stopDiscovery,
  __private: {
    mapInstagramLead,
    parseXSearchLeadSnapshot,
    inferRoleCompanyFromBio,
    normalizeXProfileUrl,
    buildLeadPersistenceRecord,
    validateLeadPersistenceRecord,
    insertLeads,
  },
};
