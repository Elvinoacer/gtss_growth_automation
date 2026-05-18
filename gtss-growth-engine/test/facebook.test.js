const assert = require("assert");
const facebook = require("../src/automation/facebook");
const platformAdapter = require("../src/campaign/platformAdapter");

// Modern fully chained Playwright nested locator mock generator with getByText & last support
function createMockPage(overrides = {}, countOverrides = {}, textOverrides = {}) {
  const defaultPage = {
    url: () => "https://facebook.com/some_user",
    goto: async () => {},
    evaluate: async () => {},
    keyboard: {
      type: async () => {},
      press: async () => {},
    },
  };

  const createLocator = (selChain) => {
    const loc = {
      first: () => loc,
      last: () => loc,
      waitFor: async () => {},
      count: async () => {
        for (const [s, count] of Object.entries(countOverrides)) {
          if (selChain === s || selChain.endsWith(` >> ${s}`)) {
            return count;
          }
        }
        return 0;
      },
      nth: (idx) => loc,
      locator: (subSel) => createLocator(selChain ? `${selChain} >> ${subSel}` : subSel),
      click: async () => {},
      scrollIntoViewIfNeeded: async () => {},
      isDisabled: async () => false,
      isVisible: async () => true,
      innerText: async () => {
        for (const [s, text] of Object.entries(textOverrides)) {
          if (selChain === s || selChain.endsWith(` >> ${s}`)) {
            return text;
          }
        }
        return "";
      },
      evaluate: async () => "",
    };
    return loc;
  };

  defaultPage.locator = (selector) => createLocator(selector);
  defaultPage.getByText = (text) => createLocator(`getByText(${text})`);
  
  return Object.assign({}, defaultPage, overrides);
}

async function runFacebookTests() {
  console.log("=== RUNNING FACEBOOK INTEGRATION TESTS ===");

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 1: Session Expiration detection
  // ───────────────────────────────────────────────────────────────────────────
  console.log("Testing T1 — Session Expiration / Checkpoint Challenge...");
  
  const mockPage1 = createMockPage({
    url: () => "https://facebook.com/checkpoint/block",
  });

  const logs1 = [];
  const emit1 = (type, msg) => logs1.push({ type, msg });

  const res1 = await facebook.sendConnectionRequest(mockPage1, "https://facebook.com/some_user", null, emit1);
  assert.strictEqual(res1.outcome, "failed");
  assert.strictEqual(res1.failCategory, "session_required");
  assert(res1.reason.includes("expired"));
  assert(logs1.some(l => l.type === "error"));

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 2: Profile Not Found detection
  // ───────────────────────────────────────────────────────────────────────────
  console.log("Testing T2 — Profile Page Not Found / Restricted Page...");

  const mockPage2 = createMockPage(
    {},
    {
      'div:has-text("This Content Isn\'t Available Right Now")': 1,
    },
    {
      'div:has-text("This Content Isn\'t Available Right Now")': "This Content Isn't Available Right Now",
    }
  );

  const logs2 = [];
  const emit2 = (type, msg) => logs2.push({ type, msg });

  const res2 = await facebook.sendDirectMessage(mockPage2, "https://facebook.com/some_user", "Hello", emit2);
  assert.strictEqual(res2.outcome, "failed");
  assert.strictEqual(res2.failCategory, "not_found");
  assert(res2.reason.includes("not found") || res2.reason.includes("unavailable"));

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 3: Connection Success Flow
  // ───────────────────────────────────────────────────────────────────────────
  console.log("Testing T3 — Friend connection invite success...");

  const mockPage3 = createMockPage(
    {},
    {
      'div[role="main"]': 1,
      'aria-label="Add Friend"': 1,
    },
    {
      'aria-label="Add Friend"': "Add Friend",
    }
  );

  const logs3 = [];
  const emit3 = (type, msg) => logs3.push({ type, msg });

  const res3 = await facebook.sendConnectionRequest(mockPage3, "https://facebook.com/some_user", null, emit3);
  assert.strictEqual(res3.outcome, "sent");

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 4: Already Connected state check
  // ───────────────────────────────────────────────────────────────────────────
  console.log("Testing T4 — Already connected connection gate...");

  const mockPage4 = createMockPage(
    {},
    {
      'div[role="main"]': 1,
      'aria-label="Cancel Request"': 1,
    },
    {
      'aria-label="Cancel Request"': "Cancel Request",
    }
  );

  const res4 = await facebook.sendConnectionRequest(mockPage4, "https://facebook.com/some_user", null, () => {});
  assert.strictEqual(res4.outcome, "already_connected");

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 5: Direct Message Send & verification success
  // ───────────────────────────────────────────────────────────────────────────
  console.log("Testing T5 — Messenger DM outreach flow...");

  const mockPage5 = createMockPage(
    {},
    {
      'div[role="main"]': 1,
      'aria-label="Message"': 1,
      'div[role="textbox"]': 1,
      'aria-label="Press Enter to send"': 1,
    },
    {
      'aria-label="Message"': "Message",
    }
  );

  const res5 = await facebook.sendDirectMessage(mockPage5, "https://facebook.com/some_user", "Hello there!", () => {});
  assert.strictEqual(res5.outcome, "sent");

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 6: platformAdapter Integration Routing
  // ───────────────────────────────────────────────────────────────────────────
  console.log("Testing T6 — platformAdapter Connection & DM Routing...");

  const mockLead = {
    id: 1234,
    profile_url: "https://facebook.com/some_user",
  };

  const adapterConnectionRes = await platformAdapter.runConnectionAction("facebook", mockPage3, mockLead, null, () => {});
  assert.strictEqual(adapterConnectionRes.outcome, "sent");

  const adapterDmRes = await platformAdapter.runDmAction("facebook", mockPage5, mockLead, "Hello from adapter", () => {});
  assert.strictEqual(adapterDmRes.outcome, "sent");

  console.log("🎉 ALL FACEBOOK INTEGRATION TESTS PASSED SUCCESSFULLY!\n");
}

runFacebookTests().catch((err) => {
  console.error("❌ FACEBOOK INTEGRATION TEST FAILED:", err);
  process.exit(1);
});
