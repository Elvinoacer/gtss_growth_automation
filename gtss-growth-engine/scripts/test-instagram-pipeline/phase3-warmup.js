/**
 * T3 — Warmup Sequence Lifecycle
 *
 * Verifies the instagramWarmup module's startWarmupSequence →
 * getLeadsDueForStep → completeWarmup lifecycle:
 *   1. Start a sequence for a fresh lead (status='pending' row inserted)
 *   2. Backdate next_step_after to simulate a due sequence and verify the
 *      lead appears in getLeadsDueForStep()
 *   3. Call completeWarmup and verify a DM draft row is generated in the
 *      messages table (status='draft', action_type='instagram_dm')
 *
 * On success, sets `ctx.testLeadId` so the orchestrator can clean up
 * the mock lead after later phases.
 */

const assert = require("assert");

const { cleanupDb } = require("./_setup");

/**
 * @param {{ db: import('better-sqlite3').Database, testLeadId: number|null, setTestLeadId: (id:number)=>void }} ctx
 */
async function runPhase3({ db, setTestLeadId }) {
  console.log("Running T3 — Warmup sequence lifecycle...");
  const {
    startWarmupSequence,
    getLeadsDueForStep,
    completeWarmup,
  } = require("../../src/automation/instagramWarmup");

  // Clear any leftover fixtures just in case
  cleanupDb(db);

  // Insert clean mock lead
  const leadInsert = db
    .prepare(
      `
      INSERT INTO leads (platform, name, profile_url, ig_username, status)
      VALUES ('instagram', 'Test Account GTSS', 'https://instagram.com/test_account_gtss', 'test_account_gtss', 'qualified')
    `,
    )
    .run();
  const testLeadId = leadInsert.lastInsertRowid;
  setTestLeadId(testLeadId);

  // Start sequence
  const startRes = startWarmupSequence(testLeadId);
  assert.strictEqual(
    startRes.success,
    true,
    `Failed to start sequence: ${startRes.error}`,
  );

  // Verify pending record
  const seqRecord = db
    .prepare("SELECT * FROM ig_warmup_sequences WHERE lead_id = ?")
    .get(testLeadId);
  assert(seqRecord !== undefined, "Warmup sequence row was not created.");
  assert.strictEqual(
    seqRecord.status,
    "pending",
    `Expected status='pending', got '${seqRecord.status}'`,
  );

  // Direct timestamp modification to simulate due sequence
  db.prepare(
    `
      UPDATE ig_warmup_sequences
      SET next_step_after = datetime('now', '-1 hour')
      WHERE lead_id = ?
    `,
  ).run(testLeadId);

  // Verify lead shows in getLeadsDueForStep list
  const dueList = getLeadsDueForStep();
  const isDueInList = dueList.some((item) => item.leadId === testLeadId);
  assert(
    isDueInList,
    "Test lead should be flagged as due after next_step_after modification.",
  );

  // Complete warmup
  const completeRes = completeWarmup(testLeadId);
  assert.strictEqual(
    completeRes.success,
    true,
    `Failed to complete warmup: ${completeRes.error}`,
  );

  // Assert DM draft creation inside messages table
  const msgRecord = db
    .prepare(
      `
      SELECT * FROM messages
      WHERE lead_id = ? AND platform = 'instagram' AND status = 'draft' AND action_type = 'instagram_dm'
    `,
    )
    .get(testLeadId);
  assert(
    msgRecord !== undefined,
    "Instagram DM draft was not generated in messages table upon sequence completion.",
  );
  console.log("✅ T3 Warmup sequence lifecycle — PASS\n");
}

module.exports = { runPhase3 };
