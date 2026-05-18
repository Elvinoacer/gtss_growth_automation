const assert = require("assert");

// 1. Get references to real automation modules to mock them
const linkedin = require("../src/automation/linkedin");
const x = require("../src/automation/x");
const instagram = require("../src/automation/instagram");

// Capture original behaviors to prevent permanent pollution (best practice)
const originalSendConnectionRequest = linkedin.sendConnectionRequest;
const originalSendDirectMessage = linkedin.sendDirectMessage;
const originalFollowUser = x.followUser;
const originalSendDirectMessageX = x.sendDirectMessage;
const originalFollowAccount = instagram.followAccount;
const originalSendDM = instagram.sendDM;

const adapter = require("../src/campaign/platformAdapter");

function runPlatformAdapterTest() {
  console.log("=== RUNNING PLATFORM ADAPTER TESTS ===");

  const mockLead = {
    id: 101,
    profile_url: "https://linkedin.com/in/test-lead",
    name: "John Doe",
    x_handle: "johndoe123"
  };

  const mockPage = {}; // Mock Playwright page context
  const mockEmitter = () => {};

  // ─── LINKEDIN TESTS ────────────────────────────────────────────────────────

  console.log("Testing LinkedIn Connection Success...");
  linkedin.sendConnectionRequest = async () => ({ outcome: "sent" });
  adapter.runConnectionAction("linkedin", mockPage, mockLead, "Hello", mockEmitter)
    .then(res => {
      assert.strictEqual(res.outcome, "sent");
      assert.strictEqual(res.error, null);
      assert.strictEqual(res.retryable, false);
    });

  console.log("Testing LinkedIn Connection Already Connected...");
  linkedin.sendConnectionRequest = async () => ({ outcome: "already_connected" });
  adapter.runConnectionAction("linkedin", mockPage, mockLead, "Hello", mockEmitter)
    .then(res => {
      assert.strictEqual(res.outcome, "skipped");
      assert.strictEqual(res.error, null);
    });

  console.log("Testing LinkedIn Connection Timeout Error...");
  linkedin.sendConnectionRequest = async () => { throw new Error("Timeout waiting for element"); };
  adapter.runConnectionAction("linkedin", mockPage, mockLead, "Hello", mockEmitter)
    .then(res => {
      assert.strictEqual(res.outcome, "failed");
      assert.strictEqual(res.retryable, true, "Selector timeouts must be retryable");
    });

  console.log("Testing LinkedIn Connection Session Expired Error...");
  linkedin.sendConnectionRequest = async () => { throw new Error("Cookie validation failure - Login Required"); };
  adapter.runConnectionAction("linkedin", mockPage, mockLead, "Hello", mockEmitter)
    .then(res => {
      assert.strictEqual(res.outcome, "session_required");
      assert.strictEqual(res.retryable, false, "Expired sessions must not be retryable");
    });

  console.log("Testing LinkedIn DM Premium Required Paywall...");
  linkedin.sendDirectMessage = async () => ({ outcome: "premium_required", reason: "Grow with Premium" });
  adapter.runDmAction("linkedin", mockPage, mockLead, "Hello", mockEmitter)
    .then(res => {
      assert.strictEqual(res.outcome, "premium_required");
      assert.strictEqual(res.retryable, false);
    });

  // ─── X TESTS ──────────────────────────────────────────────────────────────

  console.log("Testing X Follow Suspended Account...");
  x.followUser = async () => ({ outcome: "failed", failCategory: "suspended", reason: "Account suspended" });
  adapter.runConnectionAction("x", mockPage, mockLead, "Hello", mockEmitter)
    .then(res => {
      assert.strictEqual(res.outcome, "blocked");
      assert.strictEqual(res.metadata.category, "suspended");
      assert.strictEqual(res.retryable, false);
    });

  console.log("Testing X DM Not Found Account...");
  x.sendDirectMessage = async () => ({ outcome: "failed", failCategory: "not_found", reason: "No exist" });
  adapter.runDmAction("x", mockPage, mockLead, "Hello", mockEmitter)
    .then(res => {
      assert.strictEqual(res.outcome, "failed");
      assert.strictEqual(res.metadata.category, "not_found");
      assert.strictEqual(res.retryable, false);
    });

  // ─── INSTAGRAM TESTS ───────────────────────────────────────────────────────

  console.log("Testing Instagram Follow Account Blocked...");
  instagram.followAccount = async () => ({ success: false, error: "account_blocked", resumesAt: "2026-05-19T00:00:00Z" });
  adapter.runConnectionAction("instagram", mockPage, mockLead, "Hello", mockEmitter)
    .then(res => {
      assert.strictEqual(res.outcome, "blocked");
      assert.strictEqual(res.metadata.resumesAt, "2026-05-19T00:00:00Z");
      assert.strictEqual(res.retryable, false);
    });

  console.log("Testing Instagram DM Already Messaged...");
  instagram.sendDM = async () => ({ success: false, error: "already_messaged", threadUrl: "https://ig.com/t/123" });
  adapter.runDmAction("instagram", mockPage, mockLead, "Hello", mockEmitter)
    .then(res => {
      assert.strictEqual(res.outcome, "skipped");
      assert.strictEqual(res.metadata.threadUrl, "https://ig.com/t/123");
      assert.strictEqual(res.retryable, false);
    });

  // ─── GENERAL ADAPTER TESTS ─────────────────────────────────────────────────

  console.log("Testing Unsupported Platform Validation...");
  adapter.runConnectionAction("facebook", mockPage, mockLead, "Hello", mockEmitter)
    .then(res => {
      assert.strictEqual(res.outcome, "failed");
      assert(res.error.includes("Unsupported platform"));
      assert.strictEqual(res.retryable, false);
    });

  // Restore original behaviors to prevent leaking side-effects
  process.on("exit", () => {
    linkedin.sendConnectionRequest = originalSendConnectionRequest;
    linkedin.sendDirectMessage = originalSendDirectMessage;
    x.followUser = originalFollowUser;
    x.sendDirectMessage = originalSendDirectMessageX;
    instagram.followAccount = originalFollowAccount;
    instagram.sendDM = originalSendDM;
  });

  setTimeout(() => {
    console.log("🎉 ALL PLATFORM ADAPTER TESTS PASSED SUCCESSFULLY!\n");
  }, 1000);
}

try {
  runPlatformAdapterTest();
} catch (err) {
  console.error("❌ PLATFORM ADAPTER TEST FAILED:", err);
  process.exit(1);
}
