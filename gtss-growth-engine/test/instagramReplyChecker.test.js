const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

// Force test database environment and speedup delays
process.env.DB_PATH = "./data/test_instagram.db";
process.env.TEST_SPEEDUP = "true";
process.env.GMAIL_USER = "mock_user@gmail.com";
process.env.GMAIL_APP_PASSWORD = "mock_app_password";

// Global mock list of sent emails
let sentEmails = [];
const nodemailer = require("nodemailer");
nodemailer.createTransport = () => {
  return {
    sendMail: async (options) => {
      sentEmails.push(options);
      return { messageId: "mock-email-id-12345" };
    },
  };
};

// Import database and seed schema
const { getDb } = require("../src/db/database");
const db = getDb();
db.pragma("foreign_keys = OFF");

// Seed initial test leads and tracking rows
db.exec(`
  DELETE FROM touchpoints;
  DELETE FROM ig_follow_tracker;
  DELETE FROM leads;
`);

db.prepare(`
  INSERT INTO leads (id, platform, name, ig_username, status, company, lead_score)
  VALUES (101, 'instagram', 'John Doe', 'john_doe_ig', 'warmup_completed', 'Acme Corp', 85)
`).run();

db.prepare(`
  INSERT INTO leads (id, platform, name, ig_username, status, company, lead_score)
  VALUES (102, 'instagram', 'Alice Smith', 'alice_smith_ig', 'warmup_completed', 'Globex', null)
`).run();

// Stub Playwright browserBase objects via require cache override
const browserBase = require("../src/automation/browserBase");
let activeMockPage = null;
let closedBrowserCalled = false;

browserBase.createInstagramBrowser = async () => {
  return {
    browser: { close: async () => {} },
    page: activeMockPage,
    context: {},
    mode: "persistent",
    tracePath: null,
    shouldCloseBrowser: true,
    lock: null,
  };
};

browserBase.closeBrowser = async () => {
  closedBrowserCalled = true;
  return true;
};

browserBase.dailySessionWarmup = async () => {
  // Speedy warmups
  return true;
};

// Helper to construct a high-fidelity Page mock object
function createMockPage({
  url = "https://www.instagram.com/",
  unreadUsernames = [],
  requestUsernames = [],
  lastMessages = {},
  myUsername = "my_growth_account",
  followers = [],
}) {
  const clicks = [];
  const navigations = [];

  function makeLocator(selector) {
    const isUnread =
      selector.includes('div[role="listitem"]:has(span[style*="font-weight: bold"]') ||
      selector.includes('div[role="listitem"]:has(span[style*="font-weight: 600"]') ||
      selector.includes('div[role="listitem"]:has(.unread-indicator)');

    const isRequest =
      selector.includes('div[role="listitem"]') || selector.includes('a[href*="/direct/t/"]');

    return {
      count: async () => {
        if (isUnread && url.includes("/direct/inbox")) {
          return unreadUsernames.length;
        }
        if (isRequest && url.includes("/direct/requests")) {
          return requestUsernames.length;
        }
        if (selector.includes("div[role=\"dialog\"] a[href]") && url.includes("/followers")) {
          return followers.length;
        }
        if (
          selector.includes("row") ||
          selector.includes("message") ||
          selector.includes("bubble")
        ) {
          return 1;
        }
        if (
          selector.includes("Accept") ||
          selector.includes("Profile") ||
          selector.includes('div[role="dialog"] div[style*="overflow-y"]')
        ) {
          return 1;
        }
        return 0;
      },
      nth: (index) => {
        if (isUnread && url.includes("/direct/inbox")) {
          const username = unreadUsernames[index];
          return {
            locator: (subSel) => {
              return {
                first: () => ({
                  innerText: async () => `@${username}`,
                  count: async () => 1,
                }),
                count: async () => 1,
              };
            },
            click: async () => {
              clicks.push(`unread_thread_${username}`);
            },
          };
        }
        if (isRequest && url.includes("/direct/requests")) {
          const username = requestUsernames[index];
          return {
            locator: (subSel) => {
              return {
                first: () => ({
                  innerText: async () => `@${username}`,
                  count: async () => 1,
                }),
                count: async () => 1,
              };
            },
            click: async () => {
              clicks.push(`request_thread_${username}`);
            },
          };
        }
        if (selector.includes("div[role=\"dialog\"] a[href]") && url.includes("/followers")) {
          const follower = followers[index];
          return {
            getAttribute: async (attr) => {
              if (attr === "href") {
                return `/${follower}/`;
              }
              return "";
            },
          };
        }
        return {};
      },
      first: () => {
        return {
          count: async () => 1,
          isVisible: async () => true,
          getAttribute: async (attr) => {
            if (attr === "href") {
              return `/${myUsername}/`;
            }
            return "";
          },
          click: async () => {
            clicks.push(selector);
          },
          evaluate: async () => {},
        };
      },
      last: () => {
        return {
          innerText: async () => {
            const lastClick = clicks[clicks.length - 1];
            if (lastClick && lastClick.startsWith("unread_thread_")) {
              const u = lastClick.replace("unread_thread_", "");
              return lastMessages[u] || "Hello!";
            }
            if (lastClick && lastClick.startsWith("request_thread_")) {
              const u = lastClick.replace("request_thread_", "");
              return lastMessages[u] || "Message request text!";
            }
            return "Default last message";
          },
        };
      },
      evaluate: async (fn) => {
        if (typeof fn === "function") {
          fn({ scrollBy: () => {} });
        }
      },
      isVisible: async () => true,
    };
  }

  return {
    url: () => url,
    goto: async (targetUrl) => {
      navigations.push(targetUrl);
      url = targetUrl;
    },
    locator: (selector) => makeLocator(selector),
    clicks,
    navigations,
  };
}

// Require our modular checker service
const replyChecker = require("../src/services/instagramReplyChecker");

test("updateLeadReply writes DB touchpoint, sets lead to replied, and dispatches HTML email alert", async () => {
  // Clear sent emails
  sentEmails = [];

  // Seed clean baseline
  db.prepare("UPDATE leads SET status = 'warmup_completed', replied_at = NULL WHERE id = 101").run();
  db.prepare("DELETE FROM touchpoints WHERE lead_id = 101").run();

  // Trigger service call
  await replyChecker.updateLeadReply(101, "Interested, let's schedule a Zoom call next Tuesday!", "primary_inbox");

  // Assert database writes
  const lead = db.prepare("SELECT * FROM leads WHERE id = 101").get();
  assert.equal(lead.status, "replied");
  assert.ok(lead.replied_at);

  const touchpoint = db.prepare("SELECT * FROM touchpoints WHERE lead_id = 101").get();
  assert.ok(touchpoint);
  assert.equal(touchpoint.type, "reply");
  assert.equal(touchpoint.platform, "instagram");
  assert.equal(touchpoint.notes, "Interested, let's schedule a Zoom call next Tuesday!");
  assert.equal(touchpoint.source, "primary_inbox");
  assert.ok(touchpoint.created_at);

  // Assert HTML email formatting
  assert.equal(sentEmails.length, 1);
  const email = sentEmails[0];
  assert.ok(email.subject.includes("@john_doe_ig"));
  assert.ok(email.html.includes("John Doe"));
  assert.ok(email.html.includes("Acme Corp"));
  assert.ok(email.html.includes("85")); // Lead score
  assert.ok(email.html.toLowerCase().includes("primary inbox")); // Source format
  assert.ok(email.html.includes("Interested, let's schedule a Zoom call next Tuesday!"));
  assert.ok(email.html.includes("http://localhost:3000/crm?lead=101")); // CRM Link
});

test("checkPrimaryInbox parses unread direct threads, extracts name, and processes tracked lead", async () => {
  db.prepare("UPDATE leads SET status = 'warmup_completed', replied_at = NULL WHERE id = 101").run();
  db.prepare("DELETE FROM touchpoints WHERE lead_id = 101").run();

  // Create page with John Doe as unread and a non-tracked user as unread
  const mockPage = createMockPage({
    url: "https://www.instagram.com/direct/inbox/",
    unreadUsernames: ["john_doe_ig", "untracked_user_ig"],
    lastMessages: {
      john_doe_ig: "Yes, send me the documentation.",
      untracked_user_ig: "Spam message here",
    },
  });

  await replyChecker.checkPrimaryInbox(mockPage);

  // John Doe should be updated since he is tracked
  const lead = db.prepare("SELECT * FROM leads WHERE id = 101").get();
  assert.equal(lead.status, "replied");

  // Untracked user should not exist in leads
  const untracked = db.prepare("SELECT * FROM leads WHERE ig_username = 'untracked_user_ig'").get();
  assert.equal(untracked, undefined);

  // Check clicks and navigations flow
  assert.ok(mockPage.clicks.includes("unread_thread_john_doe_ig"));
});

test("checkMessageRequests navigates requests, reads tracked lead, accepts request", async () => {
  db.prepare("UPDATE leads SET status = 'warmup_completed', replied_at = NULL WHERE id = 101").run();
  db.prepare("DELETE FROM touchpoints WHERE lead_id = 101").run();

  // john_doe_ig and untracked_user_ig in request list
  const mockPage = createMockPage({
    url: "https://www.instagram.com/direct/requests/",
    requestUsernames: ["john_doe_ig", "untracked_user_ig"],
    lastMessages: {
      john_doe_ig: "Hey! What is GTSS?",
      untracked_user_ig: "Buy followers!",
    },
  });

  await replyChecker.checkMessageRequests(mockPage);

  // john_doe_ig request should be read and accepted
  const lead = db.prepare("SELECT * FROM leads WHERE id = 101").get();
  assert.equal(lead.status, "replied");

  const touchpoint = db.prepare("SELECT * FROM touchpoints WHERE lead_id = 101").get();
  assert.equal(touchpoint.source, "message_requests");
  assert.equal(touchpoint.notes, "Hey! What is GTSS?");

  // Accept button clicked
  assert.ok(mockPage.clicks.includes('role=button[name="Accept" i]'));
});

test("checkFollowBacks detects profile username, scrolls follower dialog, matches leads", async () => {
  db.prepare("UPDATE leads SET ig_follow_back_at = NULL WHERE id = 101").run();
  db.prepare("UPDATE leads SET ig_follow_back_at = NULL WHERE id = 102").run();
  db.prepare("DELETE FROM ig_follow_tracker").run();

  // Trackers setup
  db.prepare("INSERT INTO ig_follow_tracker (lead_id, username, status) VALUES (101, 'john_doe_ig', 'following')").run();

  // Create page mock
  const mockPage = createMockPage({
    url: "https://www.instagram.com/",
    myUsername: "my_growth_account",
    followers: ["john_doe_ig", "random_follower", "alice_smith_ig"],
  });

  activeMockPage = mockPage;
  closedBrowserCalled = false;

  const result = await replyChecker.checkFollowBacks();

  // Assert successful crawl metrics
  assert.equal(result.success, true);
  assert.equal(result.newFollowBacksCount, 2); // john_doe_ig and alice_smith_ig are tracked database leads
  assert.equal(closedBrowserCalled, true);

  // Assert updates in DB leads table
  const lead101 = db.prepare("SELECT * FROM leads WHERE id = 101").get();
  const lead102 = db.prepare("SELECT * FROM leads WHERE id = 102").get();
  assert.ok(lead101.ig_follow_back_at);
  assert.ok(lead102.ig_follow_back_at);

  // Assert updates in DB ig_follow_tracker table
  const tracker101 = db.prepare("SELECT * FROM ig_follow_tracker WHERE lead_id = 101").get();
  assert.ok(tracker101.follow_back_at);
});

test("checkInbox launches browser, runs warms, crawls inbox and requests, and closes context safely", async () => {
  // Setup mock page
  const mockPage = createMockPage({
    url: "https://www.instagram.com/",
    unreadUsernames: [],
    requestUsernames: [],
  });

  activeMockPage = mockPage;
  closedBrowserCalled = false;

  const result = await replyChecker.checkInbox();

  assert.equal(result.success, true);
  assert.equal(closedBrowserCalled, true);
  
  // Assert both pages were navigated to
  assert.ok(mockPage.navigations.includes("https://www.instagram.com/direct/inbox/"));
  assert.ok(mockPage.navigations.includes("https://www.instagram.com/direct/requests/"));
});
