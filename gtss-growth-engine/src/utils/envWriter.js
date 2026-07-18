const fs = require('fs');
const path = require('path');

/**
 * Resolve the .env file the running process should read and write.
 *
 * Priority:
 *   1. GTSS_ENV_PATH        — explicit override (preferred for new code)
 *   2. DOTENV_CONFIG_PATH   — set by the desktop launcher to
 *                             <userData>/engine-data/.env so the server
 *                             never writes into the read-only bundled
 *                             app directory
 *   3. <serverRoot>/.env    — standalone `npm start` / dev fallback
 *
 * This is the same class of bug INVESTIGATION.md fixed for every other
 * writable path: when packaged, <serverRoot> is read-only on Linux/macOS
 * (and on Windows the write succeeds into a file the server never re-reads).
 */
function getEnvPath() {
  if (process.env.GTSS_ENV_PATH) {
    return process.env.GTSS_ENV_PATH;
  }
  if (process.env.DOTENV_CONFIG_PATH) {
    return process.env.DOTENV_CONFIG_PATH;
  }
  return path.join(__dirname, '..', '..', '.env');
}

/**
 * Upsert a single KEY=value line into the runtime .env file.
 * Uses an atomic write (tmp + rename) so a crash mid-write can't leave
 * a half-written secrets file.
 */
function upsertEnvValue(key, value) {
  const envPath = getEnvPath();
  const line = `${key}=${value}`;
  let content = '';

  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, 'utf8');
  }

  const lines = content.split(/\r?\n/);
  const keyPattern = new RegExp(`^${key}=`);
  let updated = false;

  const nextLines = lines
    .filter((existingLine, index) => existingLine !== '' || index < lines.length - 1)
    .map((existingLine) => {
      if (keyPattern.test(existingLine)) {
        updated = true;
        return line;
      }

      return existingLine;
    });

  if (!updated) {
    nextLines.push(line);
  }

  const dir = path.dirname(envPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const nextContent = `${nextLines.join('\n')}\n`;
  const tmpPath = `${envPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, nextContent, { mode: 0o600 });
  fs.renameSync(tmpPath, envPath);

  // Re-apply restrictive permissions after rename (rename preserves the
  // destination's permissions on some filesystems if the file already
  // existed; chmod is a no-op on Windows NTFS for POSIX bits but still
  // harmless).
  try {
    fs.chmodSync(envPath, 0o600);
  } catch (_) {
    // Ignore — Windows and some FS types don't support POSIX modes.
  }
}

module.exports = {
  getEnvPath,
  upsertEnvValue
};
