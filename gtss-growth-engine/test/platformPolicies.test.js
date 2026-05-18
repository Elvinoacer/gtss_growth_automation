const assert = require("assert");
const limits = require("../src/config/limits");
const platformPolicies = require("../src/config/platformPolicies");

function runPolicyTest() {
  console.log("=== RUNNING PLATFORM POLICIES & LIMITS TEST ===");

  // 1. Verify original limits properties for full backward compatibility
  console.log("Verifying backward compatibility properties...");
  assert.strictEqual(limits.linkedin.connections, 15, "LinkedIn connections daily limit mismatch.");
  assert.strictEqual(limits.linkedin.dms, 20, "LinkedIn DMs daily limit mismatch.");
  assert.strictEqual(limits.linkedin.likes, 10, "LinkedIn likes daily limit mismatch.");
  assert.strictEqual(limits.linkedin.visits, 40, "LinkedIn visits daily limit mismatch.");

  assert.strictEqual(limits.x.dms, 10, "X DMs daily limit mismatch.");
  assert.strictEqual(limits.x.follows, 30, "X follows daily limit mismatch.");
  assert.strictEqual(limits.x.likes, 20, "X likes daily limit mismatch.");

  assert.strictEqual(limits.instagram.dms, 15, "Instagram DMs daily limit mismatch.");
  assert.strictEqual(limits.instagram.follows, 20, "Instagram follows daily limit mismatch.");
  assert.strictEqual(limits.instagram.likes, 15, "Instagram likes daily limit mismatch.");

  assert.strictEqual(limits.facebook.dms, 10, "Facebook DMs daily limit mismatch.");
  assert.strictEqual(limits.facebook.likes, 10, "Facebook likes daily limit mismatch.");
  console.log("✅ T1: Backward compatibility daily limits match perfectly.");

  // 2. Verify nested hourly properties in limits.js
  console.log("Verifying extended hourly limits in limits.js...");
  assert.strictEqual(limits.linkedin.hourly.connections, 3, "LinkedIn hourly connection limit mismatch.");
  assert.strictEqual(limits.linkedin.hourly.dms, 4, "LinkedIn hourly DM limit mismatch.");
  assert.strictEqual(limits.x.hourly.dms, 2, "X hourly DM limit mismatch.");
  assert.strictEqual(limits.instagram.hourly.follows, 4, "Instagram hourly follow limit mismatch.");
  assert.strictEqual(limits.facebook.hourly.likes, 2, "Facebook hourly like limit mismatch.");
  console.log("✅ T2: Nested hourly/queue limits mapped perfectly.");

  // 3. Verify platformPolicies.js properties and layout
  console.log("Verifying platformPolicies.js rules schema...");
  const platforms = ["linkedin", "x", "instagram", "facebook"];
  for (const platform of platforms) {
    const policy = platformPolicies[platform];
    assert(policy, `Policy for platform '${platform}' is missing.`);
    assert(policy.name, `Platform name for '${platform}' is missing.`);
    
    // Check active window
    assert(policy.activeWindow, `Active window details missing for '${platform}'.`);
    assert.strictEqual(typeof policy.activeWindow.startHour, "number");
    assert.strictEqual(typeof policy.activeWindow.endHour, "number");
    assert.strictEqual(policy.activeWindow.timezone, "local");

    // Check delays
    assert(policy.delays, `Delays schema missing for '${platform}'.`);
    assert.strictEqual(typeof policy.delays.actionMinSeconds, "number");
    assert.strictEqual(typeof policy.delays.actionMaxSeconds, "number");
    assert.strictEqual(typeof policy.delays.sessionPauseMinutes, "number");

    // Check warmup
    assert(policy.warmup, `Warmup schema missing for '${platform}'.`);
    assert.strictEqual(typeof policy.warmup.enabled, "boolean");
    assert.strictEqual(typeof policy.warmup.startDailyCount, "number");

    // Check hourlyLimits
    assert(policy.hourlyLimits, `hourlyLimits schema missing for '${platform}'.`);
    assert.strictEqual(typeof policy.hourlyLimits.dms, "number");
  }
  console.log("✅ T3: Platform policies rules layout structured perfectly.");

  console.log("🎉 ALL PLATFORM POLICY CONFIGURATION TESTS PASSED SUCCESSFULLY!\n");
}

try {
  runPolicyTest();
} catch (err) {
  console.error("❌ PLATFORM POLICY CONFIGURATION TEST FAILED:", err);
  process.exit(1);
}
