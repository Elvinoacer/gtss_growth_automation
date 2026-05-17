const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gtss-discovery-test-"));
process.env.DB_PATH = path.join(root, "gtss.db");
process.env.ENCRYPTION_KEY = "test-key";
process.env.AUTOMATION_LOCKS_DIR = path.join(root, "locks");
process.env.AUTOMATION_ARTIFACTS_DIR = path.join(root, "artifacts");

const { __private } = require("../src/services/discoveryService");

test("x discovery parser extracts normalized lead fields from a search snapshot", () => {
  const lead = __private.parseXSearchLeadSnapshot({
    text: [
      "OpenAI",
      "@openai",
      "Founder at OpenAI",
      "San Francisco, CA",
      "openai.com",
      "1.2M Followers",
    ].join("\n"),
    hrefs: ["/openai", "https://openai.com"],
  });

  assert.ok(lead);
  assert.equal(lead.platform, "x");
  assert.equal(lead.name, "OpenAI");
  assert.equal(lead.handle, "openai");
  assert.equal(lead.bio, "Founder at OpenAI");
  assert.equal(lead.role, "Founder");
  assert.equal(lead.company, "OpenAI");
  assert.equal(lead.location, "San Francisco, CA");
  assert.equal(lead.website, "https://openai.com");
  assert.equal(lead.follower_count, "1.2M");
  assert.equal(lead.profile_url, "https://x.com/openai");
});

test("x discovery parser ignores non-profile search snapshots", () => {
  const lead = __private.parseXSearchLeadSnapshot({
    text: "OpenAI search results",
    hrefs: ["/search?q=OpenAI&f=user"],
  });

  assert.equal(lead, null);
});
