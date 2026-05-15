const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getDb } = require('../db/database');
const logger = require('../utils/logger');

const SESSIONS_DIR = path.resolve(process.env.SESSION_DIR || './sessions');
const ALGORITHM = 'aes-256-cbc';
const IV_LENGTH = 16;

// ---------------------------------------------------------------------------
// Encryption helpers
// ---------------------------------------------------------------------------

function getEncryptionKey() {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) throw new Error('ENCRYPTION_KEY is not set in environment');
  // Derive a 32-byte key from whatever the user provides
  return crypto.createHash('sha256').update(key).digest();
}

function encrypt(text) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decrypt(text) {
  const key = getEncryptionKey();
  const parts = text.split(':');
  const iv = Buffer.from(parts.shift(), 'hex');
  const encrypted = parts.join(':');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// ---------------------------------------------------------------------------
// Session file helpers
// ---------------------------------------------------------------------------

function sessionPath(platform) {
  return path.join(SESSIONS_DIR, `${platform}.json`);
}

function ensureSessionsDir() {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load and decrypt session cookies for a platform.
 * Returns an array of cookie objects or null if no session exists.
 */
function loadSession(platform) {
  const filePath = sessionPath(platform);
  if (!fs.existsSync(filePath)) return null;

  try {
    const encryptedData = fs.readFileSync(filePath, 'utf8');
    const decrypted = decrypt(encryptedData);
    return JSON.parse(decrypted);
  } catch (err) {
    logger.error('Failed to load session', { platform, error: err.message });
    return null;
  }
}

/**
 * Encrypt and save session cookies for a platform.
 */
function saveSession(platform, cookies) {
  ensureSessionsDir();
  const filePath = sessionPath(platform);
  const encrypted = encrypt(JSON.stringify(cookies));
  fs.writeFileSync(filePath, encrypted, 'utf8');

  // Update platform_sessions DB
  const db = getDb();
  db.prepare(
    `INSERT INTO platform_sessions (platform, cookie_blob, last_active, is_valid)
     VALUES (?, ?, CURRENT_TIMESTAMP, 1)
     ON CONFLICT(platform) DO UPDATE SET
       cookie_blob = excluded.cookie_blob,
       last_active = CURRENT_TIMESTAMP,
       is_valid = 1`
  ).run(platform, encrypted);

  logger.info('Session saved', { platform, cookieCount: cookies.length });
}

/**
 * Mark a persistent browser profile/CDP-backed session as active.
 * These sessions are stored in the browser profile itself, so there may be no
 * cookie blob to persist in this app.
 */
function markSessionActive(platform, metadata = {}) {
  const db = getDb();
  db.prepare(
    `INSERT INTO platform_sessions (platform, cookie_blob, last_active, is_valid)
     VALUES (?, NULL, CURRENT_TIMESTAMP, 1)
     ON CONFLICT(platform) DO UPDATE SET
       last_active = CURRENT_TIMESTAMP,
       is_valid = 1`
  ).run(platform);

  logger.info('Session marked active', { platform, ...metadata });
}

/**
 * Delete a session file and mark as invalid in DB.
 */
function clearSession(platform) {
  const filePath = sessionPath(platform);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }

  const db = getDb();
  db.prepare(
    `UPDATE platform_sessions SET is_valid = 0 WHERE platform = ?`
  ).run(platform);

  logger.info('Session cleared', { platform });
}

function markSessionInvalid(platform) {
  const db = getDb();
  db.prepare(
    `INSERT INTO platform_sessions (platform, cookie_blob, last_active, is_valid)
     VALUES (?, NULL, CURRENT_TIMESTAMP, 0)
     ON CONFLICT(platform) DO UPDATE SET
       last_active = CURRENT_TIMESTAMP,
       is_valid = 0`
  ).run(platform);

  logger.warn('SESSION', 'Session marked invalid', { platform });
}

/**
 * Check if a valid session exists for a platform.
 * Returns true if the session file exists AND last_active is within 24 hours.
 */
function isSessionValid(platform) {
  const db = getDb();
  const row = db.prepare(
    `SELECT last_active, is_valid FROM platform_sessions WHERE platform = ?`
  ).get(platform);

  // No DB record at all — check for a legacy session file
  if (!row) {
    return fs.existsSync(sessionPath(platform));
  }

  // DB says explicitly invalid
  if (!row.is_valid) return false;

  if (!row.last_active) return false;

  const hoursSince = (Date.now() - new Date(row.last_active).getTime()) / 3_600_000;
  const maxAgeHours = Number(process.env.SESSION_MAX_AGE_HOURS || 720);
  return hoursSince < maxAgeHours;
}

module.exports = {
  loadSession,
  saveSession,
  clearSession,
  isSessionValid,
  markSessionInvalid,
  markSessionActive
};
