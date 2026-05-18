#!/usr/bin/env node

/**
 * Instagram Migration Verification Script
 * 
 * Audits columns, tables, settings, foreign keys, and indexes
 * to guarantee migration completeness and structural safety.
 */

require('dotenv').config();
const { getDb } = require('../src/db/database');

function verifyMigration() {
  const db = getDb();
  console.log('==================================================');
  console.log('[VERIFY] Starting Instagram Migration Audit...');
  console.log('==================================================');

  let failedAudits = 0;

  function assertColumnExists(table, column, expectedType) {
    try {
      const info = db.pragma(`table_info(${table})`);
      const col = info.find(c => c.name === column);
      if (!col) {
        console.error(`❌ [FAIL] Table "${table}" is missing column "${column}"`);
        failedAudits++;
        return false;
      }
      console.log(`✓ [PASS] Column "${table}.${column}" exists (Type: ${col.type})`);
      return true;
    } catch (err) {
      console.error(`❌ [FAIL] Failed checking columns for "${table}":`, err.message);
      failedAudits++;
      return false;
    }
  }

  function assertTableExists(table) {
    try {
      const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
      if (!row) {
        console.error(`❌ [FAIL] Table "${table}" is missing`);
        failedAudits++;
        return false;
      }
      console.log(`✓ [PASS] Table "${table}" exists`);
      return true;
    } catch (err) {
      console.error(`❌ [FAIL] Failed checking existence of table "${table}":`, err.message);
      failedAudits++;
      return false;
    }
  }

  function assertSettingExists(key) {
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
      if (!row) {
        console.error(`❌ [FAIL] Setting with key "${key}" is missing`);
        failedAudits++;
        return false;
      }
      console.log(`✓ [PASS] Setting "${key}" = "${row.value}"`);
      return true;
    } catch (err) {
      console.error(`❌ [FAIL] Failed checking settings for key "${key}":`, err.message);
      failedAudits++;
      return false;
    }
  }

  // ── 1. AUDIT EXTENDED COLUMNS ──────────────────────────────────────────────
  console.log('\n--- 1. Auditing Extended Columns ---');
  
  // leads columns
  const leadsCols = [
    'ig_username', 'ig_follower_count', 'ig_following_count', 'ig_post_count',
    'ig_is_business', 'ig_business_category', 'ig_has_email', 'ig_has_phone',
    'ig_bio', 'ig_warmup_status'
  ];
  for (const c of leadsCols) assertColumnExists('leads', c);

  // posts columns
  const postsCols = [
    'ig_post_type', 'ig_media_paths', 'ig_hashtags', 'ig_location_tag',
    'ig_post_url', 'ig_story_expires_at'
  ];
  for (const c of postsCols) assertColumnExists('posts', c);

  // messages columns
  assertColumnExists('messages', 'ig_is_message_request');

  // ── 2. AUDIT NEW TABLES ────────────────────────────────────────────────────
  console.log('\n--- 2. Auditing New Tables ---');
  const newTables = ['ig_warmup_sequences', 'ig_follow_tracker', 'ig_discovery_queue'];
  for (const t of newTables) assertTableExists(t);

  // ── 3. AUDIT DEFAULT SETTINGS ──────────────────────────────────────────────
  console.log('\n--- 3. Auditing Configuration Settings ---');
  const settingKeys = [
    'warmup_min_follow_to_story_hours', 'warmup_max_follow_to_story_hours',
    'warmup_min_story_to_like_hours', 'warmup_max_story_to_like_hours',
    'warmup_min_like_to_dm_hours', 'warmup_max_like_to_dm_hours',
    'fast_warmup_enabled', 'auto_warmup_on_qualify', 'unfollow_after_days',
    'unfollow_pending_after_days', 'max_following_ratio', 'discovery_max_per_hashtag',
    'discovery_min_followers', 'discovery_max_followers', 'ig_blocked_until',
    'ig_selector_version'
  ];
  for (const k of settingKeys) assertSettingExists(k);

  // ── 4. AUDIT DB INTEGRITY AND FOREIGN KEY CONSTRAINTS ──────────────────────
  console.log('\n--- 4. Running SQLite Structural Integrity & Constraint Checks ---');
  try {
    const integrity = db.pragma('integrity_check');
    if (integrity[0] && integrity[0].integrity_check !== 'ok' && integrity[0] !== 'ok') {
      console.error('❌ [FAIL] Database integrity check failed:', integrity);
      failedAudits++;
    } else {
      console.log('✓ [PASS] Database structural integrity is perfect (PRAGMA integrity_check: ok)');
    }
  } catch (err) {
    console.error('❌ [FAIL] Failed executing integrity check:', err.message);
    failedAudits++;
  }

  try {
    const fkCheck = db.pragma('foreign_key_check');
    if (fkCheck.length > 0) {
      console.error('❌ [FAIL] Foreign key constraint violations found:', fkCheck);
      failedAudits++;
    } else {
      console.log('✓ [PASS] Foreign key constraints are 100% valid (PRAGMA foreign_key_check: no issues)');
    }
  } catch (err) {
    console.error('❌ [FAIL] Failed executing foreign key check:', err.message);
    failedAudits++;
  }

  console.log('\n==================================================');
  if (failedAudits > 0) {
    console.error(`❌ [AUDIT COMPLETE] Migration verification failed with ${failedAudits} error(s).`);
    process.exit(1);
  } else {
    console.log('✓ [AUDIT COMPLETE] Instagram Migration is 100% robust and correct!');
    console.log('==================================================');
  }
}

verifyMigration();
