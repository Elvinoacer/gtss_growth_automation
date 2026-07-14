/**
 * T6 — Settings API
 *
 * Verifies the Instagram settings API round-trip:
 *   POST /api/settings/instagram with a payload → 200 + success:true
 *   GET  /api/settings/instagram                 → 200, every posted key
 *                                                  round-trips with the
 *                                                  same numeric value.
 */

const assert = require("assert");

const { TEST_PORT } = require("./_setup");

/**
 * @param {{}} ctx (uses TEST_PORT from _setup, no shared state needed)
 */
async function runPhase6() {
  console.log("Running T6 — Settings API...");
  const settingsPayload = {
    warmup_min_follow_to_story_hours: 6,
    warmup_max_follow_to_story_hours: 12,
    fast_warmup_enabled: 1,
    auto_warmup_on_qualify: 0,
  };

  // Call POST API
  const postResponse = await fetch(
    `http://localhost:${TEST_PORT}/api/settings/instagram`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settingsPayload),
    },
  );
  assert.strictEqual(
    postResponse.status,
    200,
    `POST Settings failed with status: ${postResponse.status}`,
  );
  const postData = await postResponse.json();
  assert.strictEqual(
    postData.success,
    true,
    "POST Response success state mismatch.",
  );

  // Call GET API
  const getResponse = await fetch(
    `http://localhost:${TEST_PORT}/api/settings/instagram`,
  );
  assert.strictEqual(
    getResponse.status,
    200,
    `GET Settings failed with status: ${getResponse.status}`,
  );
  const getData = await getResponse.json();

  // Verify round-trip matches
  for (const [key, value] of Object.entries(settingsPayload)) {
    assert.strictEqual(
      Number(getData[key]),
      value,
      `Round-trip settings validation mismatch on key '${key}': expected ${value}, got ${getData[key]}`,
    );
  }
  console.log("✅ T6 Settings API — PASS\n");
}

module.exports = { runPhase6 };
