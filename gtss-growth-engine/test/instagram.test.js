const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

// Force test database environment
process.env.DB_PATH = "./data/test_instagram.db";
process.env.TEST_SPEEDUP = "true";

const { getDb } = require("../src/db/database");
const instagram = require("../src/automation/instagram");

function createMockPage({ url, bodyText = "", visibleSelectors = [], lastMsgStyle = "", lastMsgClass = "", lastMsgAlignment = "", resultsList = [] }) {
  const visible = new Set(visibleSelectors);
  const clicks = [];
  const mouseMoves = [];
  const fills = {};

  function makeCandidate(selector) {
    const isVisible = selector === "body" || visible.has(selector);
    return {
      waitFor: async () => {
        if (!isVisible) throw new Error(`Selector not visible: ${selector}`);
      },
      isVisible: async () => isVisible,
      innerText: async () => {
        if (selector === "body") return bodyText;
        if (selector.includes("Following")) return "Following";
        if (selector.includes("Requested")) return "Requested";
        if (selector.includes("Follow")) return "Follow";
        if (selector.includes("Unfollow")) return "Unfollow";
        // resultsList check
        for (const item of resultsList) {
          if (selector.includes(item)) return item;
        }
        return "";
      },
      click: async () => {
        clicks.push(selector);
      },
      boundingBox: async () => ({ x: 100, y: 200, width: 50, height: 30 }),
      getAttribute: async (attr) => {
        if (attr === "aria-label") {
          if (selector.includes("Unlike")) return "Unlike";
          if (selector.includes("Like")) return "Like";
        }
        if (attr === "href") {
          if (selector.includes("direct/t/")) return "/direct/t/12345";
        }
        if (attr === "style") {
          if (selector.includes("row") || selector.includes("message") || selector.includes("bubble")) {
            return lastMsgStyle;
          }
        }
        if (attr === "class") {
          if (selector.includes("row") || selector.includes("message") || selector.includes("bubble")) {
            return lastMsgClass;
          }
        }
        return "";
      },
      fill: async (val) => {
        fills[selector] = val;
      },
      type: async (val) => {
        fills[selector] = (fills[selector] || "") + val;
      },
      evaluate: async (fn) => {
        if (selector.includes("row") || selector.includes("message") || selector.includes("bubble")) {
          return lastMsgAlignment;
        }
        return "";
      },
      $: async (subSelector) => {
        if (visible.has(subSelector)) return makeCandidate(subSelector);
        return null;
      },
      locator: {
        innerText: async () => {
          if (selector.includes("Following")) return "Following";
          if (selector.includes("Requested")) return "Requested";
          if (selector.includes("Follow")) return "Follow";
          if (selector.includes("Unfollow")) return "Unfollow";
          return "";
        },
        click: async () => {
          clicks.push(selector);
        }
      }
    };
  }

  return {
    url: () => url,
    waitForLoadState: async () => {},
    isClosed: () => false,
    goto: async () => {},
    mouse: {
      move: async (x, y) => {
        mouseMoves.push({ x, y });
      }
    },
    keyboard: {
      press: async (key) => {
        clicks.push(key);
      },
      type: async (text) => {
        clicks.push(text);
      }
    },
    waitForSelector: async (selector, options) => {
      if (visible.has(selector)) return makeCandidate(selector);
      throw new Error(`Timeout waiting for selector: ${selector}`);
    },
    clicks,
    mouseMoves,
    fills,
    locator: (selector) => {
      let isVisible = selector === "body" || visible.has(selector);
      if (!isVisible && selector.includes(",")) {
        const parts = selector.split(",").map(s => s.trim());
        if (parts.some(part => visible.has(part))) {
          isVisible = true;
        }
      }
      // Special check for results matching text
      if (selector.includes(":has-text(")) {
        const match = selector.match(/:has-text\("([^"]+)"\)/);
        if (match && resultsList.includes(match[1])) {
          isVisible = true;
        }
      }
      const candidate = makeCandidate(selector);
      return {
        count: async () => {
          if (!isVisible) return 0;
          if (selector.includes("row") || selector.includes("message") || selector.includes("bubble")) {
            return 1;
          }
          if (selector.includes(":has-text(") && resultsList.length > 0 && resultsList.some(r => selector.includes(r))) {
            return resultsList.length;
          }
          return 1;
        },
        nth: (i) => {
          if (selector.includes(":has-text(") && resultsList.length > 0 && resultsList.some(r => selector.includes(r))) {
            return makeCandidate(resultsList[i] || selector);
          }
          return candidate;
        },
        first: () => candidate,
        last: () => candidate,
        innerText: candidate.innerText,
        isVisible: candidate.isVisible,
        waitFor: candidate.waitFor,
        boundingBox: candidate.boundingBox,
        click: candidate.click,
        getAttribute: candidate.getAttribute,
        $: candidate.$,
        fill: candidate.fill,
        type: candidate.type,
        evaluate: candidate.evaluate
      };
    }
  };
}

test("Instagram module exports all 10 outreach functions", () => {
  const expected = [
    "followAccount",
    "unfollowAccount",
    "sendDM",
    "likeRecentPost",
    "viewStory",
    "postImage",
    "postStory",
    "postCarousel",
    "checkInbox",
    "scrapeProfile"
  ];
  for (const name of expected) {
    assert.equal(typeof instagram[name], "function", `Missing export: ${name}`);
  }
});

test("Outreach stubs return correct non-implemented status", async () => {
  const stubs = [
    "postImage",
    "postStory",
    "postCarousel",
    "checkInbox",
    "scrapeProfile"
  ];
  for (const name of stubs) {
    const result = await instagram[name]();
    assert.deepEqual(result, { success: false, error: "not implemented" });
  }
});

test("followAccount detects action blocks successfully", async () => {
  const blockedPage = createMockPage({
    url: "https://www.instagram.com/restricted_account/",
    bodyText: "Try again later. This action limit is restricted."
  });
  
  const result = await instagram.followAccount(blockedPage, { username: "restricted_account" });
  assert.equal(result.success, false);
  assert.match(result.error, /Instagram action block detected/);

  // Clean up DB state to prevent test interference
  const { getDb } = require("../src/db/database");
  getDb().prepare("DELETE FROM settings WHERE key = 'ig_blocked_until'").run();
});

test("followAccount identifies Already Following state", async () => {
  const followingPage = createMockPage({
    url: "https://www.instagram.com/already_following/",
    visibleSelectors: ['button:has-text("Following")']
  });

  const result = await instagram.followAccount(followingPage, { username: "already_following" });
  assert.equal(result.success, true);
  assert.equal(result.alreadyFollowing, true);
});

test("followAccount identifies Requested state", async () => {
  const pendingPage = createMockPage({
    url: "https://www.instagram.com/pending_request/",
    visibleSelectors: ['button:has-text("Requested")']
  });

  const result = await instagram.followAccount(pendingPage, { username: "pending_request" });
  assert.equal(result.success, true);
  assert.equal(result.requestPending, true);
});

test("followAccount handles successful follow and handles popup confirm", async () => {
  // Clear any existing database entries for clean testing
  const db = getDb();
  db.prepare("DELETE FROM ig_follow_tracker").run();
  db.prepare("DELETE FROM touchpoints").run();
  db.prepare("DELETE FROM messages").run();
  db.prepare("DELETE FROM leads").run();

  const followPage = createMockPage({
    url: "https://www.instagram.com/fresh_user/",
    visibleSelectors: [
      'button:has-text("Follow")',
      'button:has-text("Confirm")' // Dialog confirm selector
    ]
  });

  const result = await instagram.followAccount(followPage, { username: "fresh_user" });
  assert.equal(result.success, true);

  // Click count checks: clicked "Follow" button and "Confirm" button
  assert.ok(followPage.clicks.includes('button:has-text("Follow")'));
  assert.ok(followPage.clicks.includes('button:has-text("Confirm")'));

  // Database tracking verification
  const lead = db.prepare("SELECT * FROM leads WHERE ig_username = ?").get("fresh_user");
  assert.ok(lead);
  assert.equal(lead.platform, "instagram");

  const tracker = db.prepare("SELECT * FROM ig_follow_tracker WHERE lead_id = ?").get(lead.id);
  assert.ok(tracker);
  assert.equal(tracker.username, "fresh_user");
  assert.equal(tracker.status, "following");
});

test("unfollowAccount identifies Not Following state", async () => {
  const unfollowPage = createMockPage({
    url: "https://www.instagram.com/not_following/",
    visibleSelectors: ['button:has-text("Follow")'] // Only follow button visible
  });

  const result = await instagram.unfollowAccount(unfollowPage, { username: "not_following" });
  assert.equal(result.success, true);
  assert.equal(result.notFollowing, true);
});

test("unfollowAccount executes unfollow with popup confirm and database update", async () => {
  const db = getDb();
  db.prepare("DELETE FROM ig_follow_tracker").run();
  db.prepare("DELETE FROM touchpoints").run();
  db.prepare("DELETE FROM messages").run();
  db.prepare("DELETE FROM leads").run();
  
  // Make sure a following record exists in the tracker
  let lead = db.prepare("SELECT id FROM leads WHERE ig_username = ?").get("fresh_user");
  if (!lead) {
    const res = db.prepare("INSERT INTO leads (platform, ig_username, profile_url) VALUES ('instagram', 'fresh_user', 'https://instagram.com/fresh_user')").run();
    lead = { id: res.lastInsertRowid };
  }
  
  db.prepare("INSERT INTO ig_follow_tracker (lead_id, username, status) VALUES (?, 'fresh_user', 'following')").run(lead.id);

  const unfollowPage = createMockPage({
    url: "https://www.instagram.com/fresh_user/",
    visibleSelectors: [
      'button:has-text("Following")',
      'button:has-text("Unfollow")' // Confirmation confirm button
    ]
  });

  const result = await instagram.unfollowAccount(unfollowPage, { username: "fresh_user" });
  assert.equal(result.success, true);

  // Click verification
  assert.ok(unfollowPage.clicks.includes('button:has-text("Following")'));
  assert.ok(unfollowPage.clicks.includes('button:has-text("Unfollow")'));

  // Database verification: entry status updated to "unfollowed"
  const tracker = db.prepare("SELECT * FROM ig_follow_tracker WHERE lead_id = ?").get(lead.id);
  assert.ok(tracker);
  assert.equal(tracker.status, "unfollowed");
  assert.ok(tracker.unfollowed_at);
});

test("viewStory handles no-story case without error", async () => {
  const noStoryPage = createMockPage({
    url: "https://www.instagram.com/no_story_user/",
    visibleSelectors: []
  });

  const result = await instagram.viewStory(noStoryPage, { username: "no_story_user" });
  assert.equal(result.success, true);
  assert.equal(result.hasStory, false);
});

test("viewStory waits 4-7 seconds before closing (verify via timing)", async () => {
  const storyPage = createMockPage({
    url: "https://www.instagram.com/story_user/",
    visibleSelectors: [
      'canvas[style*="cursor: pointer"]', // storyRing
      'div[role="progressbar"]',
      'svg[aria-label="Close"]' // storyClose
    ]
  });

  const originalSpeedup = process.env.TEST_SPEEDUP;
  process.env.TEST_SPEEDUP = "false"; // Disable speedup to test actual timing!
  
  const startTime = Date.now();
  const result = await instagram.viewStory(storyPage, { username: "story_user" });
  const duration = Date.now() - startTime;
  
  process.env.TEST_SPEEDUP = originalSpeedup; // Restore original

  assert.equal(result.success, true);
  assert.equal(result.hasStory, true);
  assert.ok(duration >= 4000, `Expected duration to be at least 4000ms, but got ${duration}ms`);
  
  // Verify click actions
  assert.ok(storyPage.clicks.includes('canvas[style*="cursor: pointer"]'));
  assert.ok(storyPage.clicks.includes('svg[aria-label="Close"]'));
});

test("likeRecentPost handles no posts state gracefully", async () => {
  const noPostsPage = createMockPage({
    url: "https://www.instagram.com/no_posts_user/",
    visibleSelectors: [] // No grid posts
  });

  const result = await instagram.likeRecentPost(noPostsPage, { username: "no_posts_user" });
  assert.equal(result.success, true);
  assert.equal(result.noPosts, true);
});

test("likeRecentPost clicks to like post and closes modal", async () => {
  const likePage = createMockPage({
    url: "https://www.instagram.com/fresh_post_user/",
    visibleSelectors: [
      'article a[href*="/p/"]',
      'svg[aria-label="Like"]'
    ]
  });

  const result = await instagram.likeRecentPost(likePage, { username: "fresh_post_user" });
  assert.equal(result.success, true);
  assert.equal(result.liked, true);

  // Assert clicked the first post and the Like button, and pressed Escape to close modal
  assert.ok(likePage.clicks.includes('article a[href*="/p/"]'));
  assert.ok(likePage.clicks.includes('svg[aria-label="Like"]'));
  assert.ok(likePage.clicks.includes('Escape'));
});

test("likeRecentPost detects already-liked state and skips click", async () => {
  const alreadyLikedPage = createMockPage({
    url: "https://www.instagram.com/liked_post_user/",
    visibleSelectors: [
      'article a[href*="/p/"]',
      'svg[aria-label="Unlike"]' // Already liked!
    ]
  });

  const result = await instagram.likeRecentPost(alreadyLikedPage, { username: "liked_post_user" });
  assert.equal(result.success, true);
  assert.equal(result.alreadyLiked, true);

  // Assert clicked the first post, did NOT click the Like button, but pressed Escape to close
  assert.ok(alreadyLikedPage.clicks.includes('article a[href*="/p/"]'));
  assert.ok(!alreadyLikedPage.clicks.includes('svg[aria-label="Like"]'));
  assert.ok(!alreadyLikedPage.clicks.includes('svg[aria-label="Unlike"]'));
  assert.ok(alreadyLikedPage.clicks.includes('Escape'));
});

test("likeRecentPost returns selector_miss if like button is not found", async () => {
  const selectorMissPage = createMockPage({
    url: "https://www.instagram.com/miss_user/",
    visibleSelectors: [
      'article a[href*="/p/"]'
      // No like button selector!
    ]
  });

  const result = await instagram.likeRecentPost(selectorMissPage, { username: "miss_user" });
  assert.equal(result.success, false);
  assert.equal(result.error, "selector_miss");
});

test("sendDM rejects empty messages or long messages", async () => {
  const page = createMockPage({ url: "https://instagram.com" });
  
  const resEmpty = await instagram.sendDM(page, { username: "user", message: "" });
  assert.equal(resEmpty.success, false);
  assert.equal(resEmpty.error, "empty_message");

  const longMsg = "a".repeat(1001);
  const resLong = await instagram.sendDM(page, { username: "user", message: longMsg });
  assert.equal(resLong.success, false);
  assert.equal(resLong.error, "message_too_long");
});

test("sendDM detects already_messaged state in existing thread check", async () => {
  const page = createMockPage({
    url: "https://instagram.com",
    visibleSelectors: [
      'input[placeholder*="Search"]',
      'a[href*="/direct/t/"]',
      'div[role="row"]'
    ],
    lastMsgStyle: "justify-content: flex-end;",
    resultsList: ["target_user"]
  });

  const result = await instagram.sendDM(page, { username: "target_user", message: "Hello!" });
  assert.equal(result.success, false);
  assert.equal(result.error, "already_messaged");
  assert.match(result.threadUrl, /12345/);
});

test("sendDM detects hadReply state when they sent the last message", async () => {
  const page = createMockPage({
    url: "https://instagram.com",
    visibleSelectors: [
      'input[placeholder*="Search"]',
      'a[href*="/direct/t/"]',
      'div[role="row"]'
    ],
    lastMsgStyle: "justify-content: flex-start;",
    resultsList: ["reply_user"]
  });

  const result = await instagram.sendDM(page, { username: "reply_user", message: "Hello!" });
  assert.equal(result.success, true);
  assert.equal(result.hadReply, true);
});

test("sendDM executes successful DM send with message request popups", async () => {
  // Clear and setup lead in DB
  const db = getDb();
  db.prepare("DELETE FROM ig_follow_tracker").run();
  db.prepare("DELETE FROM touchpoints").run();
  db.prepare("DELETE FROM messages").run();
  db.prepare("DELETE FROM leads").run();
  
  db.prepare(`
    INSERT INTO leads (id, platform, name, profile_url, ig_username, status)
    VALUES (999, 'instagram', 'new_user', 'https://instagram.com/new_user', 'new_user', 'discovered')
  `).run();
  db.prepare(`
    INSERT INTO messages (lead_id, platform, body, status, variant, is_follow_up)
    VALUES (999, 'instagram', 'Hello Ken!', 'pending', 'A', 0)
  `).run();

  const page = createMockPage({
    url: "https://instagram.com",
    visibleSelectors: [
      'input[placeholder*="Search"]',
      'button[aria-label="New Message"]',
      'input[name="query"]',
      'button:has-text("Next")',
      'div[role="textbox"][contenteditable="true"]',
      'button:has-text("Send Message Request")',
      'button:has-text("Send")'
    ],
    resultsList: ["new_user"]
  });

  const result = await instagram.sendDM(page, { username: "new_user", message: "Hello Ken!" });
  assert.equal(result.success, true);
  assert.equal(result.isMessageRequest, true);

  // Assert clicks and inputs
  assert.ok(page.clicks.includes('button[aria-label="New Message"]'));
  assert.ok(page.clicks.includes('button:has-text("Next")'));
  assert.ok(page.clicks.includes('button:has-text("Send Message Request")'));
  assert.ok(page.clicks.includes('button:has-text("Send")'));

  // Database verification: status updated to 'sent'
  const msg = db.prepare("SELECT * FROM messages WHERE lead_id = 999").get();
  assert.ok(msg);
  assert.equal(msg.status, "sent");
  assert.equal(msg.ig_is_message_request, 1);
});

test("sendDM handles timeout and errors when composer fails to load", async () => {
  const page = createMockPage({
    url: "https://instagram.com",
    visibleSelectors: [
      'input[placeholder*="Search"]',
      'button[aria-label="New Message"]',
      'input[name="query"]',
      'button:has-text("Next")'
      // No composer selector visible!
    ],
    resultsList: ["error_user"]
  });

  const result = await instagram.sendDM(page, { username: "error_user", message: "Hi!" });
  assert.equal(result.success, false);
  assert.equal(result.error, "composer_timeout");
});
