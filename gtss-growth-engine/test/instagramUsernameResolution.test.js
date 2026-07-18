const assert = require("node:assert/strict");
const test = require("node:test");

const { getDb } = require("../src/db/database");
const { resolveInstagramUsername } = require("../src/utils/instagramUsername");
const platformAdapter = require("../src/campaign/platformAdapter");
const instagram = require("../src/automation/instagram");

test("Instagram username resolver prefers ig_username, then profile_url, then x_handle", () => {
  assert.equal(
    resolveInstagramUsername({
      ig_username: "  @Primary.Handle  ",
      profile_url: "https://www.instagram.com/profile_fallback/",
      x_handle: "x_fallback",
    }),
    "primary.handle",
  );

  assert.equal(
    resolveInstagramUsername({
      ig_username: "   ",
      profile_url: "https://www.instagram.com/Fallback.User/?hl=en",
      x_handle: "x_fallback",
    }),
    "fallback.user",
  );

  assert.equal(
    resolveInstagramUsername({
      ig_username: "",
      profile_url: "",
      x_handle: "  @X_Handle  ",
    }),
    "x_handle",
  );
});

test("Instagram follow and DM flows receive the resolved Instagram username", async () => {
  const originalFollowAccount = instagram.followAccount;
  const originalSendDM = instagram.sendDM;
  const db = getDb();
  const originalIgSettingRow = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get("ig_dm_outreach_enabled");
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run("ig_dm_outreach_enabled", "true");

  const seen = { follow: null, dm: null };
  instagram.followAccount = async (_page, params) => {
    seen.follow = params.username;
    return { success: true };
  };
  instagram.sendDM = async (_page, params) => {
    seen.dm = params.username;
    return { success: true };
  };

  try {
    const lead = {
      id: 42,
      ig_username: "  @Correct_Instagram  ",
      profile_url: "https://www.instagram.com/wrong_fallback/",
      x_handle: "wrong_x_handle",
    };

    const resultFollow = await platformAdapter.runConnectionAction(
      "instagram",
      {},
      lead,
      "Hello",
      () => {},
    );
    assert.equal(resultFollow.outcome, "sent");
    assert.equal(seen.follow, "correct_instagram");

    const resultDm = await platformAdapter.runDmAction(
      "instagram",
      {},
      lead,
      "Hello there",
      () => {},
    );
    assert.equal(resultDm.outcome, "sent");
    assert.equal(seen.dm, "correct_instagram");
  } finally {
    if (originalIgSettingRow?.value == null) {
      db.prepare("DELETE FROM settings WHERE key = ?").run("ig_dm_outreach_enabled");
    } else {
      db.prepare("UPDATE settings SET value = ? WHERE key = ?").run(
        originalIgSettingRow.value,
        "ig_dm_outreach_enabled",
      );
    }
    instagram.followAccount = originalFollowAccount;
    instagram.sendDM = originalSendDM;
  }
});
