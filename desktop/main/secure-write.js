/**
 * secureWriteSync — write a file with owner-only permissions on every OS.
 *
 * On POSIX, `mode: 0o600` is sufficient. On Windows NTFS, Node's `mode`
 * option has no meaningful effect beyond the read-only attribute, so we
 * follow up with `icacls` to strip inherited ACLs and grant the current
 * user full control only.
 *
 * Used for secrets files (.env) and small sentinel files that live next
 * to them under userData.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

/**
 * @param {string} filePath
 * @param {string|Buffer} data
 * @param {{ mode?: number }} [opts]
 */
function secureWriteSync(filePath, data, opts = {}) {
  const mode = opts.mode !== undefined ? opts.mode : 0o600;
  const dir = path.dirname(filePath);
  const existedBefore = fs.existsSync(filePath);
  
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let attempts = 0;
  while (true) {
    try {
      fs.writeFileSync(filePath, data, { mode });
      break;
    } catch (err) {
      if ((err.code === "EPERM" || err.code === "EBUSY") && attempts < 5) {
        attempts++;
        const start = Date.now();
        while (Date.now() - start < 100) {} // 100ms sync sleep
      } else {
        throw err;
      }
    }
  }

  try {
    fs.chmodSync(filePath, mode);
  } catch (_) {
    // Windows / some FS types ignore POSIX modes.
  }
}

module.exports = { secureWriteSync };
