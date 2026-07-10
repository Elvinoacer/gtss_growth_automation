/**
 * tiktokSearch.js — TikTok Search-Page Discovery + On-Page Follow
 *
 * TikTok's /search/user page renders user cards inline, each with its own
 * Follow / Following button (data-e2e="follow-back"). This module scrapes
 * those cards and clicks Follow directly on the search page — no per-profile
 * navigation needed. This is dramatically faster and lower-footprint than
 * the profile-based follow path in tiktok.js (one page load vs. N page
 * loads), which matters for mass-follow runs where we want to look as
 * human-like as possible.
 *
 * DOM shape (from the live TikTok search/users page, July 2026):
 *
 *   <a class="link-a11y-focus" href="/@<username>">
 *     <div data-fmp="true" class="...DivSearchItemContainer...">
 *       <div class="...DivSearchUserItemContainer...">
 *         <div style="gap: 0.75rem; display: flex">
 *           <div class="user-avatar-container ...">
 *             <img alt="Avatar for <username>" src="..." />
 *           </div>
 *           <div style="gap: 0.25rem; display: flex; flex-direction: column">
 *             <div><p class="...weight-bold...">Display Name</p></div>
 *             <div><p class="...weight-normal...">username</p></div>
 *             <div style="gap: 0.5rem; display: flex">
 *               <div><p>520</p><p>Followers</p></div>
 *               <p>·</p>
 *               <div><p>3160</p><p>Likes</p></div>
 *             </div>
 *           </div>
 *         </div>
 *         <div class="...tux-button-container...">
 *           <button data-e2e="follow-back" data-testid="tux-web-button">
 *             <div>Follow</div>   <!-- or "Following" if already following -->
 *           </button>
 *         </div>
 *       </div>
 *     </div>
 *   </a>
 *
 * Public API:
 *   buildSearchUrl(query)                  → fully-encoded TikTok search URL
 *   scrapeUserCards(page, opts)            → [{ username, displayName, profileUrl, followers, likes, followState }]
 *   followUserCard(page, card, emit)       → { outcome, reason, failCategory }
 *   searchAndFollow(page, query, opts, emit) → { query, discovered, followed, skipped, failed, details[] }
 *
 * Outcomes mirror tiktok.js vocabulary: 'sent' | 'already_connected' | 'failed'
 * failCategory: 'rate_limited' | 'not_found' | 'restricted' | null
 */

const { humanDelay, humanScroll } = require("./browserBase");
const logger = require("../utils/logger");

// ── Selectors ───────────────────────────────────────────────────────────────
//
// Ordered most-stable → most-fragile. The `data-e2e="follow-back"` attribute
// is TikTok's own test hook and is the single most reliable signal on the
// search page (it survives class-name rotations, which happen frequently).
const SEARCH_SELECTORS = {
  // Each user card is an <a> linking to /@<username>. The href is the
  // canonical source of the username — we never have to parse text.
  userCardLink: [
    'a.link-a11y-focus[href^="/@"]',
    'a[href^="/@"][class*="link"]',
  ],
  // The Follow / Following button lives inside each card.
  followButton: [
    'button[data-e2e="follow-back"]',
    'button[data-testid="tux-web-button"][data-e2e="follow-back"]',
  ],
  // The card's inner container — used to scope text lookups (name, handle,
  // stats) so we don't accidentally read text from an adjacent card.
  cardContainer: [
    'div[data-fmp="true"]',
    'div[class*="DivSearchUserItemContainer"]',
    'div[class*="DivSearchItemContainer"]',
  ],
  // Tabs at the top of the search page — we click "Users" to ensure we're
  // on the user-search tab (TikTok sometimes defaults to "Top").
  usersTab: [
    'button[data-testid="tux-web-tab-bar"]:has-text("Users")',
    '[data-testid="tux-web-tab-bar-container"]:has-text("Users")',
  ],
  // Empty / error states
  emptyState: [
    'div:has-text("No results")',
    'div:has-text("Couldn\'t find")',
  ],
  // Toast / action-blocked warnings (mirrors tiktok.js)
  toast: [
    '[data-e2e="toast"]',
    '[role="alert"]',
    'div[class*="Toastify"]',
  ],
};

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a fully-encoded TikTok user-search URL.
 * @param {string} query — raw search query (e.g. "restaurant owners")
 * @returns {string} — e.g. https://www.tiktok.com/search/user?q=restaurant%20owners
 */
function buildSearchUrl(query) {
  const q = String(query || "").trim();
  if (!q) {
    throw new Error("buildSearchUrl: query is required");
  }
  return `https://www.tiktok.com/search/user?q=${encodeURIComponent(q)}`;
}

async function firstVisibleIn(scope, selectors, timeout = 1500) {
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
        return {
          locator: candidate,
          selector: count > 1 ? `${selector} >> nth=${index}` : selector,
        };
      } catch (_) {
        // Try the next matching candidate.
      }
    }
  }
  return null;
}

/**
 * Extract the username from a TikTok profile href.
 *   "/@restaurantownersco"        → "restaurantownersco"
 *   "/@restaurant.owner"          → "restaurant.owner"
 *   "/@toprise_restaurant"        → "toprise_restaurant"
 * Returns null for non-profile hrefs (videos, tags, etc.).
 */
function usernameFromHref(href) {
  const m = String(href || "").match(/^\/@([^/?#]+)/);
  return m ? m[1] : null;
}

/**
 * Parse a numeric stat string like "12.1K", "1.2M", "520" into a number.
 * Returns null if the string is empty or unparseable.
 */
function parseStatCount(text) {
  if (!text) return null;
  const t = String(text).trim().toLowerCase().replace(/,/g, "");
  if (!t) return null;
  const m = t.match(/^([\d.]+)\s*([km])?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  if (m[2] === "k") return Math.round(n * 1000);
  if (m[2] === "m") return Math.round(n * 1_000_000);
  return Math.round(n);
}

/**
 * Read the inner text of the first element matching `selector` inside `scope`.
 * Returns "" if not found.
 */
async function innerTextOf(scope, selector) {
  try {
    const el = scope.locator(selector).first();
    return await el.innerText({ timeout: 800 }).catch(() => "");
  } catch (_) {
    return "";
  }
}

/**
 * Heuristic: inspect a button's label / aria attributes to decide whether
 * it currently represents the "Follow" (action available) or "Following"
 * (already connected) state. TikTok uses the same `data-e2e="follow-back"`
 * attribute for both states — the visible label is the discriminator.
 *
 * Returns 'follow' | 'following' | 'pending' | 'unknown'.
 */
async function classifyFollowButton(buttonLocator) {
  let label = "";
  try {
    label = (await buttonLocator.innerText({ timeout: 800 })).trim().toLowerCase();
  } catch (_) {
    label = "";
  }
  if (!label) {
    // Fall back to aria-label, which TikTok sometimes populates.
    try {
      const aria = await buttonLocator.getAttribute("aria-label");
      if (aria) label = String(aria).trim().toLowerCase();
    } catch (_) {}
  }
  if (label === "follow") return "follow";
  if (label === "following" || label === "friends") return "following";
  if (label === "requested" || label === "pending") return "pending";
  return "unknown";
}

/**
 * Detect TikTok action warnings (rate limit, temporary block, etc.).
 * Mirrors the logic in tiktok.js so the two modules report consistently.
 */
async function detectActionWarning(page) {
  // 1. Toast popups
  const toastMatch = await firstVisibleIn(page, SEARCH_SELECTORS.toast, 800);
  if (toastMatch) {
    const text = await toastMatch.locator.innerText().catch(() => "");
    if (text && text.trim()) return text.trim();
  }
  // 2. Full-page text scan for known warning phrases
  const bodyText = await page
    .locator("body")
    .innerText({ timeout: 1500 })
    .catch(() => "");
  const lower = bodyText.toLowerCase();
  const phrases = [
    "following too fast",
    "try again later",
    "rate limit",
    "temporarily blocked",
    "action blocked",
    "you've reached the limit",
    "too many actions",
  ];
  return phrases.find((p) => lower.includes(p)) || null;
}

// ── Public: scrapeUserCards ─────────────────────────────────────────────────

/**
 * Scrape the currently-loaded TikTok search/users page and return one record
 * per visible user card. Each record carries everything the pipeline needs
 * to decide whether to follow (and to record the outcome):
 *
 *   {
 *     username:     "restaurantownersco",          // canonical handle (from href)
 *     displayName:  "Restaurant Owners Collective", // bold <p> inside the card
 *     profileUrl:   "https://www.tiktok.com/@restaurantownersco",
 *     followers:    520,                           // parsed int (null if absent)
 *     likes:        3160,                           // parsed int (null if absent)
 *     followState:  "follow" | "following" | "pending" | "unknown",
 *     cardIndex:    0,                              // position on the page (0-based)
 *   }
 *
 * @param {import('playwright').Page} page
 * @param {Object} [opts]
 * @param {number} [opts.maxScrolls=3]   — how many times to scroll down to load more cards
 * @param {number} [opts.maxCards=50]    — hard cap on cards returned
 * @param {Object} [opts.emit]           — optional emit(event) callback for progress
 * @returns {Promise<Array<object>>}
 */
async function scrapeUserCards(page, opts = {}) {
  const maxScrolls = Math.max(0, Math.min(20, Number(opts.maxScrolls) || 3));
  const maxCards = Math.max(1, Math.min(200, Number(opts.maxCards) || 50));
  const emit = typeof opts.emit === "function" ? opts.emit : null;

  // Ensure we're on the Users tab — TikTok sometimes lands on "Top" which
  // mixes videos and users. Clicking "Users" filters to user cards only.
  try {
    const usersTab = await firstVisibleIn(page, SEARCH_SELECTORS.usersTab, 1500);
    if (usersTab) {
      await usersTab.locator.click({ timeout: 1500 }).catch(() => {});
      await humanDelay(800, 1400);
    }
  } catch (_) {
    // Non-fatal — the page may already be on the Users tab.
  }

  // Scroll a few times to trigger lazy-loaded cards, collecting card anchors
  // as they appear. We de-duplicate by username so a card that persists
  // across scrolls is only collected once.
  const seen = new Map(); // username → card record
  for (let scroll = 0; scroll <= maxScrolls; scroll++) {
    if (seen.size >= maxCards) break;

    // Find all user-card anchors currently in the DOM.
    const linkLocator = page.locator(SEARCH_SELECTORS.userCardLink[0]);
    const count = await linkLocator.count().catch(() => 0);

    for (let i = 0; i < count && seen.size < maxCards; i++) {
      const anchor = linkLocator.nth(i);
      let href;
      try {
        href = await anchor.getAttribute("href");
      } catch (_) {
        continue;
      }
      const username = usernameFromHref(href);
      if (!username || seen.has(username)) continue;

      // Scope follow-button + text lookups to this card's container. We
      // walk up from the anchor to the nearest card container div, then
      // query inside it. This prevents the follow-button search from
      // matching a button in an adjacent card.
      let cardScope = anchor;
      try {
        const container = anchor.locator(
          `xpath=ancestor::div[${SEARCH_SELECTORS.cardContainer
            .map((s) => `contains(@class, "DivSearchUserItemContainer") or @data-fmp="true"`)
            .join(" or ")}][1]`,
        ).first();
        if (await container.count().catch(() => 0)) {
          cardScope = container;
        }
      } catch (_) {
        // Fall back to the anchor as the scope.
      }

      // Display name = the bold <p> (weight-bold class).
      let displayName = "";
      try {
        displayName = (
          await cardScope
            .locator('p[class*="weight-bold"]')
            .first()
            .innerText({ timeout: 600 })
            .catch(() => "")
        ).trim();
      } catch (_) {}

      // Stats: the card renders "<n> Followers · <m> Likes". We grab all
      // <p> children and pair them by keyword.
      let followers = null;
      let likes = null;
      try {
        const paragraphs = await cardScope.locator("p").allInnerTexts().catch(() => []);
        for (let p = 0; p < paragraphs.length - 1; p++) {
          const key = String(paragraphs[p + 1]).trim().toLowerCase();
          if (key === "followers" && followers === null) {
            followers = parseStatCount(paragraphs[p]);
          } else if (key === "likes" && likes === null) {
            likes = parseStatCount(paragraphs[p]);
          }
        }
      } catch (_) {}

      // Follow button + state
      let followState = "unknown";
      let buttonSelector = null;
      try {
        const btn = cardScope.locator(SEARCH_SELECTORS.followButton[0]).first();
        if (await btn.count().catch(() => 0)) {
          followState = await classifyFollowButton(btn);
          buttonSelector = SEARCH_SELECTORS.followButton[0];
        }
      } catch (_) {}

      seen.set(username, {
        username,
        displayName: displayName || username,
        profileUrl: `https://www.tiktok.com/@${username}`,
        followers,
        likes,
        followState,
        cardIndex: seen.size,
        // Stash the button selector so followUserCard can re-locate it
        // without re-discovering the card. We re-locate by xpath/anchor
        // at follow time to avoid stale-element issues after scrolling.
        _buttonSelector: buttonSelector,
      });
    }

    if (seen.size >= maxCards) break;
    if (scroll < maxScrolls) {
      if (emit) emit({ type: "info", message: `Scroll ${scroll + 1}/${maxScrolls}: ${seen.size} user(s) discovered so far` });
      await humanScroll(page);
      await humanDelay(1200, 2000);
    }
  }

  return Array.from(seen.values());
}

// ── Public: followUserCard ──────────────────────────────────────────────────

/**
 * Follow a single user by clicking their Follow button directly on the
 * search page. Re-locates the card's button by username (the card may
 * have been re-rendered since scraping), classifies its state, clicks
 * if appropriate, and verifies the transition.
 *
 * @param {import('playwright').Page} page
 * @param {object} card              — record from scrapeUserCards()
 * @param {function} [emit]          — optional emit(type, msg) callback
 * @returns {Promise<{outcome: string, reason?: string, failCategory?: string|null}>}
 */
async function followUserCard(page, card, emit) {
  const _emit = typeof emit === "function" ? emit : () => {};
  if (!card || !card.username) {
    return { outcome: "failed", reason: "Invalid card record (missing username)", failCategory: null };
  }

  try {
    // Re-locate this card's anchor by href, then scope to its follow button.
    const anchor = page.locator(
      `a.link-a11y-focus[href="/@${card.username}"]`,
    ).first();
    const anchorCount = await anchor.count().catch(() => 0);
    if (!anchorCount) {
      _emit("error", `Card for @${card.username} no longer in DOM — may have scrolled past`);
      return { outcome: "failed", reason: "Card not found in DOM", failCategory: "not_found" };
    }

    // Scroll the card into view so the button is clickable.
    try {
      await anchor.scrollIntoViewIfNeeded({ timeout: 2000 });
      await humanDelay(400, 800);
    } catch (_) {}

    // Find the follow button inside this card. The button is a sibling of
    // the avatar/name block, both inside the card container. We walk up to
    // the container and then down to the button.
    const cardContainer = anchor.locator(
      'xpath=ancestor::div[@data-fmp="true" or contains(@class, "DivSearchUserItemContainer")][1]',
    ).first();
    const scope = (await cardContainer.count().catch(() => 0)) ? cardContainer : anchor;

    const button = scope.locator(SEARCH_SELECTORS.followButton[0]).first();
    const btnCount = await button.count().catch(() => 0);
    if (!btnCount) {
      _emit("warn", `No follow button on @${card.username} card — profile may be restricted`);
      return { outcome: "failed", reason: "Follow button not present on card", failCategory: "restricted" };
    }

    // Classify current state.
    const state = await classifyFollowButton(button);
    if (state === "following") {
      _emit("info", `Already following @${card.username}`);
      return { outcome: "already_connected", reason: "Already following" };
    }
    if (state === "pending") {
      _emit("info", `Follow request already pending for @${card.username}`);
      return { outcome: "already_connected", reason: "Follow request pending" };
    }
    if (state !== "follow") {
      // 'unknown' — try anyway, but warn.
      _emit("warn", `Follow button for @${card.username} in unexpected state "${state}" — attempting click`);
    }

    // Click the Follow button.
    _emit("info", `Clicking Follow on @${card.username}…`);
    try {
      await button.click({ timeout: 3000 });
    } catch (clickErr) {
      // Retry via Playwright's force-click as a fallback (TikTok sometimes
      // overlays an invisible interceptor).
      try {
        await button.click({ force: true, timeout: 2000 });
      } catch (_) {
        _emit("error", `Click failed for @${card.username}: ${clickErr.message}`);
        return { outcome: "failed", reason: `Click failed: ${clickErr.message}`, failCategory: null };
      }
    }
    await humanDelay(1500, 2800);

    // Check for a TikTok action warning (rate limit / block).
    const warning = await detectActionWarning(page);
    if (warning) {
      _emit("error", `TikTok warning after following @${card.username}: ${warning}`);
      const lower = warning.toLowerCase();
      if (
        lower.includes("limit") ||
        lower.includes("following too fast") ||
        lower.includes("too many actions") ||
        lower.includes("blocked")
      ) {
        return { outcome: "failed", reason: warning, failCategory: "rate_limited" };
      }
      return { outcome: "failed", reason: warning, failCategory: null };
    }

    // Verify the state transition: the button should now read "Following"
    // or "Requested" (for private accounts).
    const postState = await classifyFollowButton(button);
    if (postState === "following" || postState === "pending") {
      _emit("info", `Follow confirmed for @${card.username} (state=${postState})`);
      return { outcome: "sent" };
    }

    // State didn't transition visibly — TikTok sometimes updates
    // optimistically and the label lags by a tick. Treat as sent but warn.
    _emit("warn", `Follow click registered for @${card.username} but state is "${postState}" (expected following/pending)`);
    return { outcome: "sent", reason: `Post-click state ambiguous (${postState})` };
  } catch (err) {
    logger.error("TIKTOK-SEARCH", `followUserCard failed for @${card.username}`, { error: err.message });
    _emit("error", `Follow failed for @${card.username}: ${err.message}`);
    return { outcome: "failed", reason: err.message, failCategory: null };
  }
}

// ── Public: searchAndFollow ─────────────────────────────────────────────────

/**
 * High-level driver: navigate to the TikTok user-search page for `query`,
 * scrape the visible user cards, and follow up to `opts.limit` of them
 * (skipping any that are already followed / pending). Returns a summary
 * the pipeline can persist + emit.
 *
 * @param {import('playwright').Page} page
 * @param {string} query                — search query (e.g. "restaurant owners")
 * @param {Object} opts
 * @param {number} [opts.limit=20]      — max follows to attempt this run
 * @param {number} [opts.maxScrolls=3]  — scroll passes when scraping cards
 * @param {number} [opts.maxCards=50]   — hard cap on scraped cards
 * @param {number} [opts.minDelaySec=40]— min delay between follows (seconds)
 * @param {number} [opts.maxDelaySec=110]— max delay between follows (seconds)
 * @param {number} [opts.maxRetriesPerCard=1] — re-attempt count per card on transient failures
 * @param {function} [opts.shouldStop]  — optional () => boolean; checked between follows
 * @param {function} [opts.emit]        — optional emit({type, message}) for progress
 * @returns {Promise<object>}
 */
async function searchAndFollow(page, query, opts = {}, emit) {
  const _emit = typeof emit === "function" ? emit : (typeof opts.emit === "function" ? opts.emit : () => {});
  const limit = Math.max(1, Math.min(200, Number(opts.limit) || 20));
  const maxScrolls = Math.max(0, Math.min(20, Number(opts.maxScrolls) || 3));
  const maxCards = Math.max(limit, Math.min(200, Number(opts.maxCards) || 50));
  const minDelaySec = Math.max(5, Number(opts.minDelaySec) || 40);
  const maxDelaySec = Math.max(minDelaySec, Number(opts.maxDelaySec) || 110);
  const maxRetriesPerCard = Math.max(0, Math.min(3, Number(opts.maxRetriesPerCard) || 1));
  const shouldStop = typeof opts.shouldStop === "function" ? opts.shouldStop : () => false;

  const summary = {
    query,
    discovered: 0,
    attempted: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    details: [],
  };

  // 1. Navigate to the search page.
  const url = buildSearchUrl(query);
  _emit({ type: "info", message: `Navigating to TikTok search: ${url}` });
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  } catch (err) {
    _emit({ type: "error", message: `Failed to load search page: ${err.message}` });
    summary.details.push({ stage: "navigate", error: err.message });
    return summary;
  }
  await humanDelay(2500, 4000);

  // 2. Scrape cards.
  let cards = [];
  try {
    cards = await scrapeUserCards(page, { maxScrolls, maxCards, emit: _emit });
  } catch (err) {
    _emit({ type: "error", message: `Scrape failed: ${err.message}` });
    summary.details.push({ stage: "scrape", error: err.message });
    return summary;
  }
  summary.discovered = cards.length;
  _emit({ type: "info", message: `Discovered ${cards.length} user card(s) from search results` });

  if (cards.length === 0) {
    _emit({ type: "warn", message: "No user cards found — search may have returned zero results or the page didn't load fully" });
    return summary;
  }

  // 3. Filter: only follow cards in the 'follow' or 'unknown' state.
  //    ('following' / 'pending' → already connected, skip.)
  const followable = cards.filter((c) => c.followState === "follow" || c.followState === "unknown");
  const alreadyConnected = cards.length - followable.length;
  if (alreadyConnected > 0) {
    _emit({ type: "info", message: `${alreadyConnected} card(s) already following / pending — skipping` });
    summary.skipped += alreadyConnected;
  }

  // 4. Follow up to `limit` cards.
  for (let i = 0; i < followable.length && i < limit; i++) {
    if (shouldStop()) {
      _emit({ type: "warn", message: `Stop requested — aborting after ${summary.attempted} attempt(s)` });
      break;
    }
    const card = followable[i];
    summary.attempted += 1;
    _emit({ type: "info", message: `Following @${card.username} (${i + 1}/${Math.min(limit, followable.length)})` });

    let result = null;
    for (let attempt = 0; attempt <= maxRetriesPerCard; attempt++) {
      result = await followUserCard(page, card, _emit);
      if (result.outcome === "sent" || result.outcome === "already_connected") break;
      if (result.failCategory === "rate_limited") break; // don't retry rate limits
      if (attempt < maxRetriesPerCard) {
        _emit({ type: "info", message: `Retrying @${card.username} (attempt ${attempt + 2}/${maxRetriesPerCard + 1})` });
        await humanDelay(2000, 4000);
      }
    }

    if (result.outcome === "sent") {
      summary.sent += 1;
    } else if (result.outcome === "already_connected") {
      summary.skipped += 1;
    } else {
      summary.failed += 1;
    }
    summary.details.push({
      username: card.username,
      displayName: card.displayName,
      profileUrl: card.profileUrl,
      followers: card.followers,
      likes: card.likes,
      outcome: result.outcome,
      reason: result.reason || null,
      failCategory: result.failCategory || null,
    });

    // Human-like delay before the next follow (skip after the last one).
    if (i < followable.length - 1 && i < limit - 1) {
      const delayMs = (minDelaySec + Math.random() * (maxDelaySec - minDelaySec)) * 1000;
      _emit({ type: "info", message: `Waiting ${(delayMs / 1000).toFixed(1)}s before next follow…` });
      // Chunked sleep so shouldStop stays responsive.
      const chunks = Math.ceil(delayMs / 500);
      for (let c = 0; c < chunks; c++) {
        if (shouldStop()) break;
        await humanDelay(Math.min(500, delayMs - c * 500), Math.min(500, delayMs - c * 500) + 50);
      }
    }
  }

  _emit({
    type: summary.failed > 0 ? "warn" : "success",
    message: `TikTok search-follow complete: ${summary.sent} followed, ${summary.skipped} skipped, ${summary.failed} failed (of ${summary.discovered} discovered)`,
  });
  return summary;
}

module.exports = {
  buildSearchUrl,
  scrapeUserCards,
  followUserCard,
  searchAndFollow,
  // Exposed for tests
  _internal: {
    usernameFromHref,
    parseStatCount,
    classifyFollowButton,
    buildSearchUrl,
    SEARCH_SELECTORS,
  },
};
