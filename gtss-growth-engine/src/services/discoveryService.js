const { getDb, isWithinLimit: dbIsWithinLimit } = require("../db/database");
const {
  createBrowser,
  closeBrowser,
  checkSessionExpired,
  captureFailureArtifact,
} = require("../automation/browserBase");
const { getPlatformKeys } = require("./platformCatalog");
const { broadcast } = require("./socketService");

const MAX_PROFILE_VISITS_PER_HOUR = 50;
const DEFAULT_MIN_DELAY_MS = 3000;
const DEFAULT_MAX_DELAY_MS = 15000;
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
  (jobEventHistory.get(key) || []).forEach((e) =>
    res.write(`data: ${JSON.stringify(e)}\n\n`),
  );
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
  broadcast('discovery:event', event);

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
    timer = setTimeout(
      () =>
        reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)),
      ms,
    );
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function randomActionDelay() {
  const min = Number(
    process.env.DISCOVERY_MIN_DELAY_MS || DEFAULT_MIN_DELAY_MS,
  );
  const max = Number(
    process.env.DISCOVERY_MAX_DELAY_MS || DEFAULT_MAX_DELAY_MS,
  );
  await delay(Math.floor(Math.random() * (max - min + 1)) + min);
}

async function enforceVisitLimit(emit) {
  const cutoff = Date.now() - 3600000;
  while (visitTimestamps.length && visitTimestamps[0] < cutoff)
    visitTimestamps.shift();
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
  const found = ["captcha", "verify you're human", "unusual activity"].some(
    (t) => text.includes(t),
  );
  if (found) emit({ type: "captcha", platform, message: "CAPTCHA detected" });
  return found;
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

async function extractLinkedInSearchResults(page, max) {
  const rawLeads = await page.evaluate((limit) => {
    function clean(value) {
      return String(value || "")
        .replace(/\s+/g, " ")
        .trim();
    }

    function profileUrlFrom(anchor) {
      try {
        const url = new URL(
          anchor.getAttribute("href"),
          window.location.origin,
        );
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
        .filter(
          (line) =>
            !/^(message|connect|follow|view profile|ad|promoted)$/i.test(line),
        );
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
      const firstLine =
        lines.find((line) => !/^\d+(st|nd|rd|th)?$/i.test(line)) || anchorText;
      const name = clean(firstLine.replace(/\s*•\s*(1st|2nd|3rd\+?).*$/i, ""));
      const role =
        lines.find(
          (line) =>
            line !== firstLine &&
            !/mutual connection|followers|current:/i.test(line),
        ) || "";
      const location =
        lines.find((line) =>
          /kenya|nairobi|mombasa|county|city|area/i.test(line),
        ) || "";
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
  const rawProfiles = [];

  emit({ type: "info", message: `Starting discovery for "${keyword}" (Goal: ${maxLeads} new leads)` });

  try {
    for (const platform of selected) {
      if (isJobStopped(jobId)) break;
      if (totalNewCollected >= maxLeads) break;

      // Limit Check
      if (!isWithinLimit(platform, "visits")) {
        emit({ type: "warn", platform, message: `Daily visit limit reached for ${platform}. Skipping.` });
        continue;
      }

      const needed = maxLeads - totalNewCollected;
      emit({ type: "info", platform, message: `Searching ${platform} for up to ${needed} more new leads...` });

      try {
        const found = await withTimeout(
          platformDiscoveryMap[platform](keyword, needed, emit, jobId),
          Number(process.env.DISCOVERY_PLATFORM_TIMEOUT_MS || 300_000),
          `${platform} discovery`,
        );

        found.forEach((p) => {
          // Check if this profile is already in our collected list or in the DB
          const isInBatch = rawProfiles.some(rp => rp.profile_url === p.profile_url);
          const existsInDb = db.prepare('SELECT 1 FROM leads WHERE profile_url = ?').get(p.profile_url);
          
          if (!isInBatch && !existsInDb) {
            totalNewCollected++;
          }
          
          // We still push duplicates to rawProfiles so insertLeads can report them correctly,
          // but we only count non-duplicates toward our stopping goal.
          rawProfiles.push({ ...p, source_keyword: keyword });
        });

        if (totalNewCollected >= maxLeads) {
          emit({ type: "info", message: `Target of ${maxLeads} new leads reached.` });
          break;
        }
      } catch (e) {
        emit({ type: "error", platform, message: e.message });
      }
    }

    const result = insertLeads(rawProfiles);
    db.prepare(
      "UPDATE discovery_runs SET leads_found = ?, status = ? WHERE id = ?",
    ).run(result.new, isJobStopped(jobId) ? "stopped" : "completed", jobId);
    emit({ type: "done", result });
    return result;
  } catch (e) {
    db.prepare("UPDATE discovery_runs SET status = ? WHERE id = ?").run(
      "failed",
      jobId,
    );
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
    INSERT INTO leads (platform, name, role, company, location, profile_url, website, source_keyword, status)
    SELECT @platform, @name, @role, @company, @location, @profile_url, @website, @source_keyword, 'discovered'
    WHERE NOT EXISTS (SELECT 1 FROM leads WHERE profile_url = @profile_url)
  `);
  let inserted = 0;
  const tx = db.transaction((list) => {
    list.forEach((p) => {
      if (insert.run(p).changes > 0) inserted++;
    });
  });
  tx(profiles);
  return {
    total: profiles.length,
    new: inserted,
    duplicates: profiles.length - inserted,
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
        await checkSessionExpired(page, "linkedin", (type, message) =>
          emit({ type, platform: "linkedin", message }),
        )
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
              message:
                "No LinkedIn result selector became visible before timeout; attempting extraction anyway.",
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
          if (allLeads.some(l => l.profile_url === lead.profile_url)) continue;
          
          allLeads.push(lead);
          
          // Check DB to count if it's truly new
          const existing = db.prepare('SELECT 1 FROM leads WHERE profile_url = ?').get(lead.profile_url);
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
            await new Promise(r => setTimeout(r, 500));
          }
          window.scrollTo(0, document.body.scrollHeight);
        });
        await delay(2000);
        
        // Try multiple selectors for the Next button
        const nextButtonSelectors = [
          'button.artdeco-pagination__button--next:not([disabled])',
          'button[aria-label="Next"]:not([disabled])',
          'button:has-text("Next"):not([disabled])'
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
           emit({ type: "info", platform: "linkedin", message: `Clicking Next page (current page ${pageNum})...` });
           
           // Ensure it's in view
           await nextBtn.scrollIntoViewIfNeeded().catch(() => {});
           await nextBtn.click({ timeout: 5000 }).catch(async () => {
             // Fallback: force click via evaluate if normal click fails
             await page.evaluate((sel) => {
               const btn = document.querySelector(sel);
               if (btn) btn.click();
             }, await nextBtn.evaluate(node => {
               // Get a simple selector for the evaluate call
               return node.className ? `.${node.className.split(' ').join('.')}` : 'button.artdeco-pagination__button--next';
             }).catch(() => 'button.artdeco-pagination__button--next'));
           });

           pageNum++;
           
           // Wait for the page content to actually change
           // We wait for the first lead of the previous page to disappear or for a new list to appear
           emit({ type: "info", platform: "linkedin", message: "Waiting for next page results to load..." });
           
           if (firstLeadUrl) {
             const profileSnippet = firstLeadUrl.split('/in/')[1]?.split('/')[0];
             if (profileSnippet) {
               // Wait for the old result to vanish or a timeout
               await page.waitForFunction((oldSnippet) => {
                 return !document.body.innerText.includes(oldSnippet);
               }, profileSnippet, { timeout: 10000 }).catch(() => {
                 emit({ type: "warn", platform: "linkedin", message: "Page transition check timed out; content might still be loading." });
               });
             }
           }
           
           await delay(3000); // Base safety delay for AJAX
        } else {
           emit({ type: "info", platform: "linkedin", message: "No 'Next' button found or it is disabled. Ending search." });
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
  x: async (kw, max, emit) => [],
  instagram: async (kw, max, emit) => [],
  facebook: async (kw, max, emit) => [],
};

module.exports = {
  discoverLeads,
  listDiscoverySources,
  registerJobStream,
  emitJobEvent,
  closeJobStream,
  stopDiscovery,
};
