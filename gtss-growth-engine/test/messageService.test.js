const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gtss-message-test-"));
process.env.DB_PATH = path.join(root, "gtss.db");
process.env.ENCRYPTION_KEY = "test-key";

const { getDb } = require("../src/db/database");
const { generateMessages, getCharLimit } = require("../src/services/messageService");

test("Message generation template resolution and character limit enforcement", async () => {
  const db = getDb();
  
  // Create tables for test isolation
  db.prepare("DELETE FROM messages").run();
  db.prepare("DELETE FROM leads").run();

  // Insert mock leads for LinkedIn and X
  db.prepare(`
    INSERT INTO leads (id, name, role, company, location, platform, status)
    VALUES (101, 'Alice Smith', 'CEO', 'Alice Bakery', 'Nairobi', 'linkedin', 'qualified')
  `).run();

  db.prepare(`
    INSERT INTO leads (id, name, role, company, location, platform, status)
    VALUES (102, 'Bob Jones', 'Owner', 'Bob Pizzeria', 'Mombasa', 'x', 'qualified')
  `).run();

  // 1. Verify getCharLimit resolves properly
  assert.equal(getCharLimit("linkedin", "connect"), 300, "linkedin connect limit must be 300");
  assert.equal(getCharLimit("x", "dm"), 500, "x dm limit must be 500");

  // 2. Generate messages for LinkedIn lead
  const resultLinkedIn = await generateMessages(101, "linkedin");
  assert.ok(resultLinkedIn.variantA.body.includes("Alice Smith"), "LinkedIn message must contain lead name");
  assert.ok(resultLinkedIn.variantA.body.includes("ISP outage"), "LinkedIn message must contain key template parts");
  assert.ok(resultLinkedIn.variantA.body.length <= 300, "LinkedIn message length must be <= 300");

  // 3. Generate messages for X lead
  const resultX = await generateMessages(102, "x");
  const xBody = resultX.variantA.body;
  
  // Verify X platform details
  assert.ok(xBody.includes("Bob Jones"), "X message must contain lead name");
  assert.ok(xBody.includes("Bob Pizzeria"), "X message must contain company name");
  assert.ok(xBody.length <= 500, "X message length must be <= 500");
  
  // Ensure no LinkedIn connection request assumptions
  assert.equal(xBody.includes("Would love to connect!"), false, "X message must NOT contain LinkedIn connect assumption");
  
  // Conversational check
  assert.ok(xBody.includes("drops are an absolute nightmare"), "X message must match new conversational style");
});
