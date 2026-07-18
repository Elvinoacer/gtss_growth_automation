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
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(filePath, data, { mode });

  try {
    fs.chmodSync(filePath, mode);
  } catch (_) {
    // Windows / some FS types ignore POSIX modes.
  }

  if (process.platform === "win32") {
    restrictWindowsAcl(filePath);
  }
}

/**
 * Strip inherited ACLs and grant only the current user full control.
 * Best-effort: if icacls is missing or fails, the write still succeeded
 * with whatever default NTFS ACL Windows applied.
 */
function restrictWindowsAcl(filePath) {
  try {
    // /inheritance:r  — remove inherited ACEs
    // /grant:r USER:F — replace explicit ACEs with Full control for current user
    // %USERNAME% is expanded by cmd; we pass the env var value ourselves.
    const user = process.env.USERNAME || process.env.USER || "";
    if (!user) return;
    execFileSync(
      "icacls",
      [filePath, "/inheritance:r", "/grant:r", `${user}:F`],
      { stdio: "ignore", windowsHide: true },
    );
  } catch (_) {
    // Non-fatal — file was still written.
  }
}

module.exports = { secureWriteSync, restrictWindowsAcl };
