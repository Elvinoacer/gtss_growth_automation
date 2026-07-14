/**
 * sendDM tests.
 *
 * Verifies:
 *  - input validation (empty / over-length messages rejected)
 *  - already_messaged state detected via existing-thread check
 *  - hadReply state detected (their last message in the thread)
 *  - happy-path DM send through the message-request popup flow + DB write
 *  - composer_timeout error when the textbox never appears
 */

const assert = require("node:assert/strict");
const test = require("node:test");

const { getDb, instagram, createMockPage } = require("./_helpers");

test("sendDM rejects empty messages or long messages", async () => {
  const page = createMockPage({ url: "https://instagram.com" });

  const resEmpty = await instagram.sendDM(page, {
    username: "user",
    message: "",
  });
  assert.equal(resEmpty.success, false);
  assert.equal(resEmpty.error, "empty_message");

  const longMsg = "a".repeat(1001);
  const resLong = await instagram.sendDM(page, {
    username: "user",
    message: longMsg,
  });
  assert.equal(resLong.success, false);
  assert.equal(resLong.error, "message_too_long");
});

test("sendDM detects already_messaged state in existing thread check", async () => {
  const page = createMockPage({
    url: "https://instagram.com",
    visibleSelectors: [
      'input[placeholder*="Search"]',
      'a[href*="/direct/t/"]',
      'div[role="row"]',
    ],
    lastMsgStyle: "justify-content: flex-end;",
    resultsList: ["target_user"],
  });

  const result = await instagram.sendDM(page, {
    username: "target_user",
    message: "Hello!",
  });
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
      'div[role="row"]',
    ],
    lastMsgStyle: "justify-content: flex-start;",
    resultsList: ["reply_user"],
  });

  const result = await instagram.sendDM(page, {
    username: "reply_user",
    message: "Hello!",
  });
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

  db.prepare(
    `
    INSERT INTO leads (id, platform, name, profile_url, ig_username, status)
    VALUES (999, 'instagram', 'new_user', 'https://instagram.com/new_user', 'new_user', 'discovered')
  `,
  ).run();
  db.prepare(
    `
    INSERT INTO messages (lead_id, platform, body, status, variant, is_follow_up)
    VALUES (999, 'instagram', 'Hello Ken!', 'pending', 'A', 0)
  `,
  ).run();

  const page = createMockPage({
    url: "https://instagram.com",
    visibleSelectors: [
      'input[placeholder*="Search"]',
      'button[aria-label="New Message"]',
      'input[name="query"]',
      'button:has-text("Next")',
      'div[role="textbox"][contenteditable="true"]',
      'button:has-text("Send Message Request")',
      'button:has-text("Send")',
      'div[role="row"]',
    ],
    resultsList: ["new_user"],
    lastMsgText: "Hello Ken!",
    lastMsgStyle: "justify-content: flex-end;",
    lastMsgAlignment: "flex-end",
  });

  const result = await instagram.sendDM(page, {
    username: "new_user",
    message: "Hello Ken!",
  });
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
      'button:has-text("Next")',
      // No composer selector visible!
    ],
    resultsList: ["error_user"],
  });

  const result = await instagram.sendDM(page, {
    username: "error_user",
    message: "Hi!",
  });
  assert.equal(result.success, false);
  assert.equal(result.error, "composer_timeout");
});
