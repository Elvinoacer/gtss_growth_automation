const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gtss-executor-routing-"));
process.env.DB_PATH = path.join(root, "gtss.db");
process.env.ENCRYPTION_KEY = "test-key";

const linkedin = require("../src/automation/linkedin");
const {
  determineActionType,
  normalizeQueuedActionType,
  runAutomationAction,
} = require("../src/automation/executor");

const originalLikeRecentPost = linkedin.likeRecentPost;
const originalSendConnectionRequest = linkedin.sendConnectionRequest;
const originalSendDirectMessage = linkedin.sendDirectMessage;

test.after(() => {
  linkedin.likeRecentPost = originalLikeRecentPost;
  linkedin.sendConnectionRequest = originalSendConnectionRequest;
  linkedin.sendDirectMessage = originalSendDirectMessage;
});

test("explicit message action types are normalized and honored", () => {
  assert.equal(normalizeQueuedActionType("connections"), "connect");
  assert.equal(normalizeQueuedActionType("dms"), "dm");
  assert.equal(
    determineActionType({
      platform: "linkedin",
      is_follow_up: 0,
      lead_id: 42,
    }),
    "dm",
  );
  assert.equal(
    determineActionType({
      platform: "linkedin",
      action_type: "dm",
      is_follow_up: 0,
      lead_id: 42,
    }),
    "dm",
  );
});

test("LinkedIn connect action does not reuse inbox DM body as connection note", async () => {
  const calls = [];
  linkedin.likeRecentPost = async () => ({ outcome: "no_posts" });
  linkedin.sendConnectionRequest = async (_page, profileUrl, note) => {
    calls.push({ profileUrl, note });
    return { outcome: "sent" };
  };

  const result = await runAutomationAction(
    {
      platform: "linkedin",
      action_type: "connect",
      profile_url: "https://www.linkedin.com/in/example",
      body: "Hi Brian, this is the inbox DM body and must not become a note.",
    },
    { page: {} },
    () => {},
  );

  assert.equal(result.outcome, "sent");
  assert.deepEqual(calls, [
    {
      profileUrl: "https://www.linkedin.com/in/example",
      note: "",
    },
  ]);
});

test("LinkedIn DM action still sends the approved inbox message body", async () => {
  const calls = [];
  linkedin.sendDirectMessage = async (
    _page,
    profileUrl,
    body,
    _emit,
    leadName,
  ) => {
    calls.push({ profileUrl, body, leadName });
    return { outcome: "sent" };
  };

  const result = await runAutomationAction(
    {
      platform: "linkedin",
      action_type: "dm",
      profile_url: "https://www.linkedin.com/in/example",
      body: "Hi Brian, this is the inbox DM body.",
      lead_name: "Brian Example",
    },
    {
      page: {
        bringToFront: async () => {},
      },
    },
    () => {},
  );

  assert.equal(result.outcome, "sent");
  assert.deepEqual(calls, [
    {
      profileUrl: "https://www.linkedin.com/in/example",
      body: "Hi Brian, this is the inbox DM body.",
      leadName: "Brian Example",
    },
  ]);
});
