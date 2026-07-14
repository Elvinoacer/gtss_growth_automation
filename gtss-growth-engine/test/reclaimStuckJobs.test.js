/**
 * Unit tests for reclaimStuckRunningJobs / reclaimJobIfStillRunning.
 */
"use strict";

const assert = require("assert");
const Database = require("better-sqlite3");
const {
  reclaimStuckRunningJobs,
  reclaimJobIfStillRunning,
} = require("../src/campaign/utils/reclaimStuckJobs");

function setupDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE connection_jobs (
      id INTEGER PRIMARY KEY,
      campaign_id INTEGER,
      lead_id INTEGER,
      status TEXT,
      error_message TEXT,
      updated_at DATETIME
    );
    CREATE TABLE dm_jobs (
      id INTEGER PRIMARY KEY,
      campaign_id INTEGER,
      lead_id INTEGER,
      status TEXT,
      error_message TEXT,
      updated_at DATETIME
    );
  `);
  return db;
}

function run() {
  console.log("=== reclaimStuckJobs unit tests ===");

  // ── Global reclaim ──────────────────────────────────────────────────────
  {
    const db = setupDb();
    db.prepare(
      `INSERT INTO connection_jobs (id, campaign_id, lead_id, status) VALUES
       (1, 10, 1, 'running'),
       (2, 10, 2, 'pending'),
       (3, 20, 3, 'running')`,
    ).run();
    db.prepare(
      `INSERT INTO dm_jobs (id, campaign_id, lead_id, status) VALUES
       (1, 10, 1, 'running'),
       (2, 20, 3, 'sent')`,
    ).run();

    const result = reclaimStuckRunningJobs(db, { reason: "test reclaim" });
    assert.strictEqual(result.connectionJobs, 2);
    assert.strictEqual(result.dmJobs, 1);

    const conn = db.prepare(`SELECT id, status FROM connection_jobs ORDER BY id`).all();
    assert.strictEqual(conn[0].status, "pending");
    assert.strictEqual(conn[1].status, "pending");
    assert.strictEqual(conn[2].status, "pending");
    const dm = db.prepare(`SELECT id, status FROM dm_jobs ORDER BY id`).all();
    assert.strictEqual(dm[0].status, "pending");
    assert.strictEqual(dm[1].status, "sent");
    console.log("✅ global reclaim — PASS");
  }

  // ── Per-campaign reclaim (pause path) ───────────────────────────────────
  {
    const db = setupDb();
    db.prepare(
      `INSERT INTO connection_jobs (id, campaign_id, lead_id, status) VALUES
       (1, 10, 1, 'running'),
       (2, 20, 2, 'running')`,
    ).run();
    db.prepare(
      `INSERT INTO dm_jobs (id, campaign_id, lead_id, status) VALUES
       (1, 10, 1, 'running'),
       (2, 20, 2, 'running')`,
    ).run();

    const result = reclaimStuckRunningJobs(db, {
      campaignId: 10,
      reason: "paused",
    });
    assert.strictEqual(result.connectionJobs, 1);
    assert.strictEqual(result.dmJobs, 1);

    assert.strictEqual(
      db.prepare(`SELECT status FROM connection_jobs WHERE id = 1`).get().status,
      "pending",
    );
    assert.strictEqual(
      db.prepare(`SELECT status FROM connection_jobs WHERE id = 2`).get().status,
      "running",
      "Other campaign must be left alone",
    );
    console.log("✅ per-campaign reclaim — PASS");
  }

  // ── Per-job safety net ──────────────────────────────────────────────────
  {
    const db = setupDb();
    db.prepare(
      `INSERT INTO connection_jobs (id, campaign_id, lead_id, status) VALUES (1, 1, 1, 'running')`,
    ).run();
    db.prepare(
      `INSERT INTO connection_jobs (id, campaign_id, lead_id, status) VALUES (2, 1, 2, 'sent')`,
    ).run();

    assert.strictEqual(reclaimJobIfStillRunning(db, "connection", 1), true);
    assert.strictEqual(reclaimJobIfStillRunning(db, "connection", 2), false);
    assert.strictEqual(
      db.prepare(`SELECT status FROM connection_jobs WHERE id = 1`).get().status,
      "pending",
    );
    assert.strictEqual(
      db.prepare(`SELECT status FROM connection_jobs WHERE id = 2`).get().status,
      "sent",
    );
    console.log("✅ per-job reclaimIfStillRunning — PASS");
  }

  console.log("🎉 reclaimStuckJobs tests passed\n");
}

if (require.main === module) {
  try {
    run();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

module.exports = { run };
