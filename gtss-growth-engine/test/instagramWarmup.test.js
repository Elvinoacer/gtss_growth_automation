const assert = require("node:assert/strict");
const test = require("node:test");

// Force test database environment
process.env.DB_PATH = "./data/test_instagram.db";
process.env.TEST_SPEEDUP = "true";

const { getDb } = require("../src/db/database");
const instagramWarmup = require("../src/automation/instagramWarmup");
const instagramWarmupJob = require("../src/jobs/instagramWarmupJob");

function createMockPage({ url = "https://www.instagram.com/", bodyText = "", visibleSelectors = [] } = {}) {
  const visible = new Set(visibleSelectors);
  const clicks = [];
  const mouseMoves = [];

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
      }
    },
    waitForSelector: async (selector, options) => {
      // Default fallback for any elements to pass
      return makeCandidate(selector);
    },
    clicks,
    mouseMoves,
    locator: (selector) => {
      const isVisible = selector === "body" || visible.has(selector);
      const candidate = makeCandidate(selector);
      return {
        count: async () => 1,
        nth: () => candidate,
        first: () => candidate,
        innerText: candidate.innerText,
        isVisible: candidate.isVisible,
        waitFor: candidate.waitFor,
        boundingBox: candidate.boundingBox,
        click: candidate.click,
        getAttribute: candidate.getAttribute,
        $: candidate.$,
      };
    }
  };
}

test.beforeEach(() => {
  const db = getDb();
  // Safe disable FK constraints to allow clean deletion of linked tables
  db.pragma("foreign_keys = OFF");
  db.prepare("DELETE FROM ig_warmup_sequences").run();
  db.prepare("DELETE FROM leads").run();
  db.prepare("DELETE FROM messages").run();
  db.prepare("DELETE FROM daily_actions").run();
  db.prepare("DELETE FROM ig_follow_tracker").run();
  db.pragma("foreign_keys = ON");
});

test("startWarmupSequence creates sequence and sets status to pending", () => {
  const db = getDb();
  
  // Insert a test lead
  const leadResult = db.prepare(`
    INSERT INTO leads (name, ig_username, platform, ig_warmup_status)
    VALUES ('Warmup Lead', 'warmup_user', 'instagram', NULL)
  `).run();
  const leadId = leadResult.lastInsertRowid;

  const result = instagramWarmup.startWarmupSequence(leadId);
  assert.equal(result.success, true);
  assert.ok(result.sequenceId);

  // Verify DB state
  const seq = db.prepare("SELECT * FROM ig_warmup_sequences WHERE lead_id = ?").get(leadId);
  assert.ok(seq);
  assert.equal(seq.status, "pending");
  assert.equal(seq.next_step, "follow");
  assert.ok(seq.next_step_after);

  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(leadId);
  assert.equal(lead.ig_warmup_status, "pending");

  // Attempt duplicate start
  const dupResult = instagramWarmup.startWarmupSequence(leadId);
  assert.equal(dupResult.success, false);
  assert.equal(dupResult.error, "already_started");
});

test("getLeadsDueForStep filters leads correctly based on next_step_after", () => {
  const db = getDb();

  // Lead A: Due now (next_step_after in the past)
  db.prepare(`
    INSERT INTO leads (id, name, ig_username, platform)
    VALUES (101, 'Lead A', 'leada', 'instagram')
  `).run();
  db.prepare(`
    INSERT INTO ig_warmup_sequences (lead_id, status, next_step, next_step_after)
    VALUES (101, 'pending', 'follow', datetime('now', '-1 hour'))
  `).run();

  // Lead B: Not due yet (next_step_after in the future)
  db.prepare(`
    INSERT INTO leads (id, name, ig_username, platform)
    VALUES (102, 'Lead B', 'leadb', 'instagram')
  `).run();
  db.prepare(`
    INSERT INTO ig_warmup_sequences (lead_id, status, next_step, next_step_after)
    VALUES (102, 'pending', 'follow', datetime('now', '+1 hour'))
  `).run();

  // Lead C: Completed sequence
  db.prepare(`
    INSERT INTO leads (id, name, ig_username, platform)
    VALUES (103, 'Lead C', 'leadc', 'instagram')
  `).run();
  db.prepare(`
    INSERT INTO ig_warmup_sequences (lead_id, status, next_step, next_step_after)
    VALUES (103, 'warmup_complete', 'done', datetime('now', '-1 hour'))
  `).run();

  const due = instagramWarmup.getLeadsDueForStep();
  assert.equal(due.length, 1);
  assert.equal(due[0].leadId, 101);
  assert.equal(due[0].username, "leada");
});

test("advanceWarmupStep executes follow step successfully", async () => {
  const db = getDb();

  db.prepare(`
    INSERT INTO leads (id, name, ig_username, platform)
    VALUES (201, 'Lead Follow', 'lead_follow', 'instagram')
  `).run();
  
  db.prepare(`
    INSERT INTO ig_warmup_sequences (lead_id, status, next_step, next_step_after, current_step)
    VALUES (201, 'pending', 'follow', datetime('now', '-1 minute'), 0)
  `).run();

  const page = createMockPage({
    visibleSelectors: ['button:has-text("Follow")']
  });
  const res = await instagramWarmup.advanceWarmupStep(page, { leadId: 201 });
  assert.equal(res.success, true);
  assert.equal(res.stepExecuted, "follow");
  assert.equal(res.nextStep, "view_story");

  // Verify transition
  const seq = db.prepare("SELECT * FROM ig_warmup_sequences WHERE lead_id = 201").get();
  assert.equal(seq.status, "following");
  assert.equal(seq.next_step, "view_story");
  assert.equal(seq.current_step, 1);

  // Verify daily action recorded
  const action = db.prepare("SELECT * FROM daily_actions WHERE lead_id = 201").get();
  assert.ok(action);
  assert.equal(action.platform, "instagram");
  assert.equal(action.action_type, "follows");
});

test("advanceWarmupStep executes story view successfully", async () => {
  const db = getDb();

  db.prepare(`
    INSERT INTO leads (id, name, ig_username, platform)
    VALUES (202, 'Lead Story', 'lead_story', 'instagram')
  `).run();
  
  db.prepare(`
    INSERT INTO ig_warmup_sequences (lead_id, status, next_step, next_step_after, current_step, story_views_count)
    VALUES (202, 'following', 'view_story', datetime('now', '-1 minute'), 1, 0)
  `).run();

  const page = createMockPage();
  const res = await instagramWarmup.advanceWarmupStep(page, { leadId: 202 });
  assert.equal(res.success, true);
  assert.equal(res.stepExecuted, "view_story");
  assert.equal(res.nextStep, "like");

  // Verify transition
  const seq = db.prepare("SELECT * FROM ig_warmup_sequences WHERE lead_id = 202").get();
  assert.equal(seq.status, "story_viewed");
  assert.equal(seq.next_step, "like");
  assert.equal(seq.current_step, 2);
  assert.equal(seq.story_views_count, 1);
});

test("advanceWarmupStep executes post like successfully", async () => {
  const db = getDb();

  db.prepare(`
    INSERT INTO leads (id, name, ig_username, platform)
    VALUES (203, 'Lead Like', 'lead_like', 'instagram')
  `).run();
  
  db.prepare(`
    INSERT INTO ig_warmup_sequences (lead_id, status, next_step, next_step_after, current_step, post_likes_count)
    VALUES (203, 'story_viewed', 'like', datetime('now', '-1 minute'), 2, 0)
  `).run();

  const page = createMockPage({
    visibleSelectors: ['svg[aria-label="Like"]']
  });
  const res = await instagramWarmup.advanceWarmupStep(page, { leadId: 203 });
  assert.equal(res.success, true);
  assert.equal(res.stepExecuted, "like");
  assert.equal(res.nextStep, "done");

  // Verify transition
  const seq = db.prepare("SELECT * FROM ig_warmup_sequences WHERE lead_id = 203").get();
  assert.equal(seq.status, "liked");
  assert.equal(seq.next_step, "done");
  assert.equal(seq.current_step, 3);
  assert.equal(seq.post_likes_count, 1);

  // Verify daily action recorded
  const action = db.prepare("SELECT * FROM daily_actions WHERE lead_id = 203 AND action_type = 'likes'").get();
  assert.ok(action);
  assert.equal(action.platform, "instagram");
});

test("advanceWarmupStep executes complete transition and drafts DM with correct message request status", async () => {
  const db = getDb();

  // Test case A: User has NOT followed back (ig_follow_back_at IS NULL)
  db.prepare(`
    INSERT INTO leads (id, name, ig_username, platform, ig_follow_back_at)
    VALUES (301, 'Lead Non-Follower', 'nonfollower', 'instagram', NULL)
  `).run();
  db.prepare(`
    INSERT INTO ig_warmup_sequences (lead_id, status, next_step, next_step_after, current_step)
    VALUES (301, 'liked', 'done', datetime('now', '-1 minute'), 3)
  `).run();

  const page = createMockPage();
  const resA = await instagramWarmup.advanceWarmupStep(page, { leadId: 301 });
  assert.equal(resA.success, true);
  assert.equal(resA.stepExecuted, "complete");

  const seqA = db.prepare("SELECT * FROM ig_warmup_sequences WHERE lead_id = 301").get();
  assert.equal(seqA.status, "warmup_complete");

  const msgA = db.prepare("SELECT * FROM messages WHERE lead_id = 301").get();
  assert.ok(msgA);
  assert.equal(msgA.platform, "instagram");
  assert.equal(msgA.status, "draft");
  assert.equal(msgA.ig_is_message_request, 1); // True because they did not follow back

  // Test case B: User HAS followed back (ig_follow_back_at is populated)
  db.prepare(`
    INSERT INTO leads (id, name, ig_username, platform, ig_follow_back_at)
    VALUES (302, 'Lead Follower', 'follower', 'instagram', datetime('now'))
  `).run();
  db.prepare(`
    INSERT INTO ig_warmup_sequences (lead_id, status, next_step, next_step_after, current_step)
    VALUES (302, 'liked', 'done', datetime('now', '-1 minute'), 3)
  `).run();

  const resB = await instagramWarmup.advanceWarmupStep(page, { leadId: 302 });
  assert.equal(resB.success, true);

  const msgB = db.prepare("SELECT * FROM messages WHERE lead_id = 302").get();
  assert.ok(msgB);
  assert.equal(msgB.ig_is_message_request, 0); // False because they followed back
});

test("advanceWarmupStep failure increments attempt count and transitions to failed state on 3rd retry", async () => {
  const db = getDb();

  db.prepare(`
    INSERT INTO leads (id, name, ig_username, platform)
    VALUES (401, 'Lead Fail', 'fail_username', 'instagram')
  `).run();
  
  db.prepare(`
    INSERT INTO ig_warmup_sequences (lead_id, status, next_step, next_step_after, attempt_count)
    VALUES (401, 'pending', 'follow', datetime('now', '-1 minute'), 0)
  `).run();

  // Fail 1st time (badPage locator throws on waitForSelector)
  const badPage = {
    ...createMockPage(),
    waitForSelector: async () => { throw new Error("Connection failed"); }
  };

  const res1 = await instagramWarmup.advanceWarmupStep(badPage, { leadId: 401 });
  assert.equal(res1.success, false);

  let seq = db.prepare("SELECT * FROM ig_warmup_sequences WHERE lead_id = 401").get();
  assert.equal(seq.status, "pending");
  assert.equal(seq.attempt_count, 1);

  // Set attempt count to 2 to trigger final failure transition on next run
  db.prepare("UPDATE ig_warmup_sequences SET attempt_count = 2 WHERE lead_id = 401").run();

  const res2 = await instagramWarmup.advanceWarmupStep(badPage, { leadId: 401 });
  assert.equal(res2.success, false);

  seq = db.prepare("SELECT * FROM ig_warmup_sequences WHERE lead_id = 401").get();
  assert.equal(seq.status, "skipped");
  assert.equal(seq.next_step, "none");
  assert.equal(seq.attempt_count, 3);

  const lead = db.prepare("SELECT * FROM leads WHERE id = 401").get();
  assert.equal(lead.ig_warmup_status, "skipped");
});

test("instagramWarmupJob respects daily action limits", async () => {
  const db = getDb();
  
  // Seed daily actions up to the follows limit (20) and likes limit (15) to trigger global action limit skip
  for (let i = 0; i < 35; i++) {
    db.prepare(`
      INSERT INTO daily_actions (platform, action_type, outcome, performed_at)
      VALUES ('instagram', 'follows', 'sent', datetime('now', 'localtime'))
    `).run();
  }

  db.prepare(`
    INSERT INTO leads (id, name, ig_username, platform)
    VALUES (501, 'Limit Lead', 'limitlead', 'instagram')
  `).run();
  db.prepare(`
    INSERT INTO ig_warmup_sequences (lead_id, status, next_step, next_step_after)
    VALUES (501, 'pending', 'follow', datetime('now', '-1 minute'))
  `).run();

  const result = await instagramWarmupJob.run(() => {});
  // Warmup job should skip/return early since limits are hit
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "daily_limit_hit");
});

test("increment_action_count inserts record in daily_actions correctly", () => {
  const db = getDb();
  const { increment_action_count } = require("../src/db/database");

  // Clean daily actions
  db.prepare("DELETE FROM daily_actions").run();
  db.prepare("DELETE FROM leads WHERE id = 999").run();

  // Create a mock lead to satisfy the foreign key constraint
  db.prepare(`
    INSERT INTO leads (id, name, ig_username, platform)
    VALUES (999, 'Test Lead', 'testig', 'instagram')
  `).run();

  increment_action_count("instagram", "follows", 999, "sent");

  const row = db.prepare("SELECT * FROM daily_actions WHERE lead_id = 999").get();
  assert.ok(row);
  assert.equal(row.platform, "instagram");
  assert.equal(row.action_type, "follows");
  assert.equal(row.outcome, "sent");

  // Clean up
  db.prepare("DELETE FROM daily_actions WHERE lead_id = 999").run();
  db.prepare("DELETE FROM leads WHERE id = 999").run();
});

test("isWithinLimit correctly enforces configuration limits and fallback mechanisms", () => {
  const db = getDb();
  const { isWithinLimit } = require("../src/db/database");

  // Clean daily actions
  db.prepare("DELETE FROM daily_actions").run();

  // Under limit
  assert.equal(isWithinLimit("instagram", "instagram_dm"), true);

  // Seed daily actions up to limit (15 dms)
  for (let i = 0; i < 15; i++) {
    db.prepare(`
      INSERT INTO daily_actions (platform, action_type, outcome, performed_at)
      VALUES ('instagram', 'dms', 'sent', datetime('now', 'localtime'))
    `).run();
  }

  // At limit
  assert.equal(isWithinLimit("instagram", "instagram_dm"), false);
});
