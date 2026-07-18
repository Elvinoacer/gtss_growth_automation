const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gtss-queued-actions-test-"));
process.env.DB_PATH = path.join(root, "gtss.db");

const { getDb } = require("../src/db/database");
const { getQueuedActions } = require("../src/automation/executor/queuedActions");
const {
  getPreferredApprovedMessage,
} = require("../src/services/messageSelectionService");
const {
  retireTemplateMessages,
  needsAiMessageSql,
} = require("../src/services/messageService/retireTemplateMessages");

function seedLead(db, id = 1) {
  db.prepare("DELETE FROM messages").run();
  db.prepare("DELETE FROM leads").run();
  db.prepare(
    `INSERT INTO leads (id, name, platform, profile_url, status)
     VALUES (?, 'Nawruz Example', 'linkedin', 'https://linkedin.com/in/nawruz-example', 'message_approved')`,
  ).run(id);
}

test("automation queues an approved Gemini message, not an auto-approved fallback", () => {
  const db = getDb();
  seedLead(db);

  db.prepare(
    `INSERT INTO messages (lead_id, platform, body, variant, status, generated_by, approved_by, approved_at)
     VALUES (1, 'linkedin', 'Old template fallback', 'B', 'approved', 'template-fallback', 'pipeline-auto', '2026-01-01 08:00:00')`,
  ).run();
  db.prepare(
    `INSERT INTO messages (lead_id, platform, body, variant, status, generated_by, approved_by, approved_at)
     VALUES (1, 'linkedin', 'Correct Gemini message', 'A', 'approved', 'ai', 'pipeline-auto', '2026-01-02 08:00:00')`,
  ).run();

  const queued = getQueuedActions({ platforms: ["linkedin"] });

  assert.equal(queued.length, 1);
  assert.equal(queued[0].body, "Correct Gemini message");
  assert.equal(queued[0].generated_by, "ai");
});

test("AI body beats an older founder-approved template in the send queue", () => {
  const db = getDb();
  seedLead(db);

  db.prepare(
    `INSERT INTO messages (lead_id, platform, body, variant, status, generated_by, approved_by, approved_at)
     VALUES (1, 'linkedin', 'Old founder template', 'B', 'approved', 'template', 'founder', '2026-01-01 08:00:00')`,
  ).run();
  db.prepare(
    `INSERT INTO messages (lead_id, platform, body, variant, status, generated_by, approved_by, approved_at)
     VALUES (1, 'linkedin', 'New Gemini web body', 'A', 'approved', 'ai-web', 'pipeline-auto', '2026-06-01 08:00:00')`,
  ).run();

  const preferred = getPreferredApprovedMessage(db, {
    leadId: 1,
    platform: "linkedin",
  });
  const queued = getQueuedActions({ platforms: ["linkedin"] });

  assert.equal(preferred.body, "New Gemini web body");
  assert.equal(preferred.generated_by, "ai-web");
  assert.equal(queued.length, 1);
  assert.equal(queued[0].body, "New Gemini web body");
});

test("pipeline-auto template alone is never auto-sendable", () => {
  const db = getDb();
  seedLead(db);

  db.prepare(
    `INSERT INTO messages (lead_id, platform, body, variant, status, generated_by, approved_by, approved_at)
     VALUES (1, 'linkedin', 'Auto template only', 'B', 'approved', 'template', 'pipeline-auto', datetime('now'))`,
  ).run();

  assert.equal(
    getPreferredApprovedMessage(db, { leadId: 1, platform: "linkedin" }),
    undefined,
  );
  assert.equal(getQueuedActions({ platforms: ["linkedin"] }).length, 0);
});

test("founder template is sendable only when no AI body exists", () => {
  const db = getDb();
  seedLead(db);

  db.prepare(
    `INSERT INTO messages (lead_id, platform, body, variant, status, generated_by, approved_by, approved_at)
     VALUES (1, 'linkedin', 'Founder template special case', 'B', 'approved', 'template-fallback', 'founder', datetime('now'))`,
  ).run();

  const preferred = getPreferredApprovedMessage(db, {
    leadId: 1,
    platform: "linkedin",
  });
  assert.equal(preferred.body, "Founder template special case");
  assert.equal(getQueuedActions({ platforms: ["linkedin"] }).length, 1);
});

test("retireTemplateMessages skips template drafts so AI owns the queue", () => {
  const db = getDb();
  seedLead(db);

  db.prepare(
    `INSERT INTO messages (id, lead_id, platform, body, variant, status, generated_by)
     VALUES (10, 1, 'linkedin', 'Template draft', 'B', 'pending', 'template-fallback')`,
  ).run();
  db.prepare(
    `INSERT INTO messages (id, lead_id, platform, body, variant, status, generated_by)
     VALUES (11, 1, 'linkedin', 'AI draft', 'A', 'pending', 'ai')`,
  ).run();

  const retired = retireTemplateMessages(db, {
    leadId: 1,
    platform: "linkedin",
    keepIds: [11],
  });
  assert.equal(retired, 1);

  const template = db.prepare("SELECT status FROM messages WHERE id = 10").get();
  const ai = db.prepare("SELECT status FROM messages WHERE id = 11").get();
  assert.equal(template.status, "skipped");
  assert.equal(ai.status, "pending");
});

test("needsAiMessageSql treats template-only leads as still needing generation", () => {
  const db = getDb();
  seedLead(db);

  db.prepare(
    `INSERT INTO messages (lead_id, platform, body, variant, status, generated_by)
     VALUES (1, 'linkedin', 'Fallback only', 'B', 'pending', 'template-fallback')`,
  ).run();

  const stillNeeds = db
    .prepare(
      `SELECT l.id FROM leads l WHERE l.id = 1 AND ${needsAiMessageSql("l")}`,
    )
    .get();
  assert.ok(stillNeeds, "template-only lead must be eligible for Generate All");

  db.prepare(
    `INSERT INTO messages (lead_id, platform, body, variant, status, generated_by)
     VALUES (1, 'linkedin', 'Real AI', 'A', 'pending', 'ai')`,
  ).run();

  const noLongerNeeds = db
    .prepare(
      `SELECT l.id FROM leads l WHERE l.id = 1 AND ${needsAiMessageSql("l")}`,
    )
    .get();
  assert.equal(noLongerNeeds, undefined);
});

test("listFallbackLeads includes message_approved leads stuck on template fallback", () => {
  const {
    listFallbackLeads,
    countFallbackLeads,
    countFallbackMessages,
  } = require("../src/services/messageService/retireTemplateMessages");

  const db = getDb();
  seedLead(db);
  // Lead already left "qualified" after an earlier generate+approve of a fallback.
  db.prepare(
    "UPDATE leads SET status = 'message_approved' WHERE id = 1",
  ).run();
  db.prepare(
    `INSERT INTO messages (lead_id, platform, body, variant, status, generated_by)
     VALUES (1, 'linkedin', 'Stuck fallback A', 'A', 'pending', 'template-fallback')`,
  ).run();
  db.prepare(
    `INSERT INTO messages (lead_id, platform, body, variant, status, generated_by)
     VALUES (1, 'linkedin', 'Stuck fallback B', 'B', 'pending', 'template-fallback')`,
  ).run();

  const leads = listFallbackLeads(db);
  assert.equal(leads.length, 1);
  assert.equal(leads[0].id, 1);
  assert.equal(countFallbackLeads(db), 1);
  assert.equal(countFallbackMessages(db), 2);

  // Even with a real AI draft, template rows still surface on the button so
  // the operator can clean them up (job retires templates, keeps AI).
  db.prepare(
    `INSERT INTO messages (lead_id, platform, body, variant, status, generated_by)
     VALUES (1, 'linkedin', 'Real Gemini', 'A', 'pending', 'ai')`,
  ).run();
  assert.equal(countFallbackLeads(db), 1);
  assert.equal(listFallbackLeads(db).length, 1);
  assert.equal(countFallbackMessages(db), 2);
});
