/**
 * secureWriteSync — write a file with owner-only permissions on every OS.
 *
 * On POSIX, `mode: 0o600` is sufficient. On Windows NTFS, Node's `mode`
 * option is effectively meaningless (NTFS uses ACLs, not POSIX permission
 * bits). Worse, passing `mode: 0o600` to `fs.writeFileSync` on Windows can
 * trigger `EPERM` in certain contexts (e.g. when the app is launched by an
 * elevated installer while antivirus is scanning the file). We therefore
 * skip the `mode` option entirely on Windows and rely on the default NTFS
 * ACL inheritance from the user's AppData directory, which already restricts
 * access to the owning user.
 *
 * Used for secrets files (.env) and small sentinel files that live next
 * to them under userData.
 */

const fs = require("fs");
const path = require("path");

/**
 * @param {string} filePath
 * @param {string|Buffer} data
 * @param {{ mode?: number }} [opts]
 */
function secureWriteSync(filePath, data, opts = {}) {
  const isWin = process.platform === "win32";
  const mode = opts.mode !== undefined ? opts.mode : 0o600;
  const dir = path.dirname(filePath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // On Windows, omit the mode option entirely to avoid EPERM issues.
  // On POSIX, apply the requested mode (default 0o600 = owner read+write).
  const writeOpts = isWin ? {} : { mode };

  let attempts = 0;
  while (true) {
    try {
      fs.writeFileSync(filePath, data, writeOpts);
      break;
    } catch (err) {
      if ((err.code === "EPERM" || err.code === "EBUSY") && attempts < 5) {
        attempts++;
        // Sync sleep: yield to antivirus / Windows Search indexer.
        const start = Date.now();
        while (Date.now() - start < 200) {}
      } else {
        throw err;
      }
    }
  }

  if (!isWin) {
    try {
      fs.chmodSync(filePath, mode);
    } catch (_) {
      // Some FS types (e.g. FAT32 mounts) ignore POSIX modes.
    }
  }
}

module.exports = { secureWriteSync };
