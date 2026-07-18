/**
 * EnvBootstrap — prepares the runtime environment on first launch and on every
 * subsequent launch.
 *
 * On first launch:
 *  - Create DATA_ROOT and all sub-directories.
 *  - Generate a random ENCRYPTION_KEY (32-byte hex) and SESSION_SECRET.
 *  - Write a starter .env inside DATA_ROOT (NOT inside the read-only resources
 *    dir — that way app updates don't overwrite the user's secrets).
 *  - Symlink or copy the server's public/ dir into DATA_ROOT if the server
 *    expects it relative to its own root (the server uses
 *    path.join(__dirname, "..", "public"), so we keep public/ inside the
 *    server tree).
 *
 * On every launch:
 *  - Ensure DATA_ROOT still exists.
 *  - Ensure .env is present and contains ENCRYPTION_KEY. If the user deleted
 *    it, regenerate (but warn — old data is unrecoverable).
 *
 * The server's process.env is populated from the .env we write here, plus a
 * few runtime overrides (DB_PATH, SESSION_DIR, etc. pointing into DATA_ROOT).
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { secureWriteSync } = require("./secure-write");

// All writable per-user state lives in DATA_ROOT. The bundled
// <resources>/server/ directory is READ-ONLY on Linux (.deb installs to
// /opt/GTSS Growth Engine/resources/server/, owned by root) and inside an
// .app bundle on macOS — so EVERY path the server writes to at runtime
// must point into DATA_ROOT, never into the bundled server tree.
//
// We expose these writable paths to the server as env vars so the server's
// source code can resolve them at startup:
//
//   UPLOADS_DIR        — user-uploaded media (asset library, scheduler)
//   MEDIA_DIR          — generated/scheduled media files
//   CDP_PROFILE_DIR    — Chrome user-data-dir for CDP automation
//
// DB_PATH / SESSION_DIR / AUTOMATION_ARTIFACTS_DIR / etc. were already
// overridden correctly; this file extends the same treatment to the
// remaining writable paths.
const REQUIRED_DIRS = [
  "data",
  "data/browser-locks",
  "sessions",
  "profiles",
  "artifacts/automation",
  "artifacts/gemini-images",
  "media",
  // public/uploads lives under DATA_ROOT so the server can write to it.
  // The bundled <resources>/server/public/ directory contains the app's
  // STATIC frontend files (HTML/CSS/JS) and remains read-only; uploaded
  // files are served from DATA_ROOT/public/uploads via a separate
  // express.static mount (see src/server.js).
  "public/uploads",
  "public/uploads/library",
  // Chrome's --user-data-dir for CDP. Lives under DATA_ROOT so it
  // survives app updates and is writable on every platform.
  "chrome-cdp-profile",
];

class EnvBootstrap {
  /**
   * @param {string} serverRoot  Absolute path to the gtss-growth-engine source.
   *                             Read-only when packaged.
   * @param {string} dataRoot    Writable per-user data directory (appData).
   */
  constructor(serverRoot, dataRoot) {
    this.serverRoot = serverRoot;
    this.dataRoot = dataRoot;
    this.envPath = path.join(dataRoot, ".env");
    // The server reads path.join(__dirname, "..", "public"), so the server
    // must run with cwd = serverRoot. We never copy public/ out — we run the
    // server in-place. The dataRoot only holds mutable state.
    this.resolvedServerRoot = serverRoot;
  }

  async ensure() {
    try {
      if (!fs.existsSync(this.dataRoot)) {
        fs.mkdirSync(this.dataRoot, { recursive: true });
      }
    } catch (err) {
      const e = new Error(`Failed to create data root directory at ${this.dataRoot}: ${err.message}`);
      e.code = err.code;
      throw e;
    }

    for (const dir of REQUIRED_DIRS) {
      const targetPath = path.join(this.dataRoot, dir);
      try {
        fs.mkdirSync(targetPath, { recursive: true });
      } catch (err) {
        const e = new Error(`Failed to create required directory at ${targetPath}: ${err.message}`);
        e.code = err.code;
        throw e;
      }
    }

    if (!fs.existsSync(this.envPath)) {
      await this.writeInitialEnv();
    } else {
      // Make sure required keys still exist (e.g. user upgraded from an old
      // version that didn't have GEMINI_IMAGE_SAVE_DIR).
      this.backfillMissingKeys();
    }

    // Verify the server source is present.
    const serverEntry = path.join(this.serverRoot, "src", "server.js");
    if (!fs.existsSync(serverEntry)) {
      throw new Error(
        `Server source not found at ${serverEntry}. The installation may be corrupted — please reinstall GTSS Growth Engine.`,
      );
    }
  }

  /**
   * Return the env-var overrides the ServerManager should pass to the
   * spawned server process. These point the server's writable paths at
   * DATA_ROOT so the server never tries to write to the read-only
   * <resources>/server/ directory.
   *
   * We return these as a fresh object on every call so the ServerManager
   * can merge them into its childEnv without worrying about mutation.
   */
  getRuntimeEnvOverrides() {
    return {
      UPLOADS_DIR: path.join(this.dataRoot, "public", "uploads"),
      MEDIA_DIR: path.join(this.dataRoot, "media"),
      DOM_CAPTURE_DIR: path.join(this.dataRoot, "artifacts", "dom-captures"),
      CDP_PROFILE_DIR: path.join(this.dataRoot, "chrome-cdp-profile"),
      // Per-platform persistent browser profile dir (used only when CDP
      // mode is unavailable and the engine falls back to Playwright's
      // launchPersistentContext). Points into the writable userData dir.
      PROFILES_DIR: path.join(this.dataRoot, "profiles"),
    };
  }

  async writeInitialEnv() {
    const env = {
      SESSION_SECRET: crypto.randomBytes(32).toString("hex"),
      ENCRYPTION_KEY: crypto.randomBytes(32).toString("hex"),
      GEMINI_MODEL: "gemini-2.0-flash",
      DB_PATH: path.join(this.dataRoot, "data", "gtss.db"),
      SESSION_DIR: path.join(this.dataRoot, "sessions"),
      AUTOMATION_ARTIFACTS_DIR: path.join(this.dataRoot, "artifacts", "automation"),
      DOM_CAPTURE_DIR: path.join(this.dataRoot, "artifacts", "dom-captures"),
      GEMINI_IMAGE_SAVE_DIR: path.join(this.dataRoot, "artifacts", "gemini-images"),
      AUTOMATION_LOCKS_DIR: path.join(this.dataRoot, "data", "browser-locks"),
      // Writable paths for uploads / media / CDP profile / persistent
      // browser profiles. The server reads these env vars at startup
      // (see src/server.js, src/routes/assets.js, src/pipeline/
      // contentPipeline.js, src/jobs/backgroundJobs.js) and the desktop's
      // CdpManager reads CDP_PROFILE_DIR directly.
      UPLOADS_DIR: path.join(this.dataRoot, "public", "uploads"),
      MEDIA_DIR: path.join(this.dataRoot, "media"),
      CDP_PROFILE_DIR: path.join(this.dataRoot, "chrome-cdp-profile"),
      PROFILES_DIR: path.join(this.dataRoot, "profiles"),
      // CDP is the default browser mode. The launcher starts a CDP Chrome
      // (the user's real Chrome with --remote-debugging-port and a copied
      // profile) and opens the web app inside it. This way the web app and
      // automation share the same Chrome instance — no friction, no "two
      // Chrome windows" confusion.
      BROWSER_MODE: "cdp",
      BROWSER_CHANNEL: "chrome",
      CDP_ENDPOINT: "http://127.0.0.1:9222",
      CDP_PORT: "9222",
      // Whether the CDP Chrome runs VISIBLY or in the BACKGROUND (headless)
      // on normal Starts. Default: "false" (background) — the user doesn't
      // want a Chrome window they didn't ask for during everyday automation.
      // The FIRST Start always runs visibly (first-time sign-in flow) until
      // the user completes sign-in and the `.signin-completed` sentinel is
      // written. After that, this setting controls visibility. The user can
      // change it in the web app's Settings → Automation Browser.
      CDP_VISIBLE_DEFAULT: "false",
      // Port for the localhost-only bridge HTTP server that lets the web
      // app control the CDP Chrome (start it visibly, open login tabs,
      // check sessions, read/write this setting). See desktop/main/bridge-server.js.
      GTSS_BRIDGE_PORT: "9224",
      PLAYWRIGHT_TRACE: "true",
      ALLOW_HEADLESS_SOCIAL: "false",
      SESSION_MAX_AGE_HOURS: "720",
      ACTION_IDEMPOTENCY_TTL_HOURS: "168",
      LINKEDIN_OUTREACH_MODE: "connect_first",
      AUTOMATION_ACTION_DELAY_MS: "60000,180000",
      SHUTDOWN_TIMEOUT_MS: "30000",
      PIPELINE_MODE: "ai",
      PIPELINE_CRON: "0 8 * * *",
      QUALIFICATION_THRESHOLD: "50",
      QUALIFICATION_MANUAL_SCORE: "75",
      MESSAGE_AUTO_APPROVE_VARIANT: "B",
      PIPELINE_DISCOVERY_KEYWORDS_FILE: path.join(this.serverRoot, "src", "config", "keywords.json"),

      // User must set these via onboarding or Settings.
      PASSPHRASE_HASH: "",
      GEMINI_API_KEY: "",
      GMAIL_USER: "",
      GMAIL_APP_PASSWORD: "",
      PORT: "3000",
    };

    const lines = Object.entries(env).map(([k, v]) => `${k}=${v}`);
    lines.push("");
    // Owner-only perms on POSIX; icacls ACL lockdown on Windows (see secure-write.js).
    secureWriteSync(this.envPath, lines.join("\n"), { mode: 0o600 });
  }

  backfillMissingKeys() {
    const existing = fs.readFileSync(this.envPath, "utf8");
    const have = new Set(
      existing
        .split(/\r?\n/)
        .map((l) => l.split("=")[0])
        .filter(Boolean),
    );

    const additions = [];
    if (!have.has("ENCRYPTION_KEY")) {
      additions.push(`ENCRYPTION_KEY=${crypto.randomBytes(32).toString("hex")}`);
    }
    if (!have.has("SESSION_SECRET")) {
      additions.push(`SESSION_SECRET=${crypto.randomBytes(32).toString("hex")}`);
    }
    if (!have.has("DB_PATH")) {
      additions.push(`DB_PATH=${path.join(this.dataRoot, "data", "gtss.db")}`);
    }
    if (!have.has("SESSION_DIR")) {
      additions.push(`SESSION_DIR=${path.join(this.dataRoot, "sessions")}`);
    }
    if (!have.has("AUTOMATION_ARTIFACTS_DIR")) {
      additions.push(`AUTOMATION_ARTIFACTS_DIR=${path.join(this.dataRoot, "artifacts", "automation")}`);
    }
    if (!have.has("GEMINI_IMAGE_SAVE_DIR")) {
      additions.push(`GEMINI_IMAGE_SAVE_DIR=${path.join(this.dataRoot, "artifacts", "gemini-images")}`);
    }
    if (!have.has("AUTOMATION_LOCKS_DIR")) {
      additions.push(`AUTOMATION_LOCKS_DIR=${path.join(this.dataRoot, "data", "browser-locks")}`);
    }
    if (!have.has("PIPELINE_DISCOVERY_KEYWORDS_FILE")) {
      additions.push(
        `PIPELINE_DISCOVERY_KEYWORDS_FILE=${path.join(this.serverRoot, "src", "config", "keywords.json")}`,
      );
    }
    // Backfill the new writable-path env vars for users upgrading from a
    // pre-fix installation. Without these, the server would fall back to
    // its old relative-path logic and try to write into the read-only
    // <resources>/server/ directory.
    if (!have.has("UPLOADS_DIR")) {
      additions.push(`UPLOADS_DIR=${path.join(this.dataRoot, "public", "uploads")}`);
    }
    if (!have.has("MEDIA_DIR")) {
      additions.push(`MEDIA_DIR=${path.join(this.dataRoot, "media")}`);
    }
    if (!have.has("DOM_CAPTURE_DIR")) {
      additions.push(`DOM_CAPTURE_DIR=${path.join(this.dataRoot, "artifacts", "dom-captures")}`);
    }
    if (!have.has("CDP_PROFILE_DIR")) {
      additions.push(`CDP_PROFILE_DIR=${path.join(this.dataRoot, "chrome-cdp-profile")}`);
    }
    if (!have.has("PROFILES_DIR")) {
      additions.push(`PROFILES_DIR=${path.join(this.dataRoot, "profiles")}`);
    }
    // Backfill the browser-visibility + bridge-port settings for users
    // upgrading from a version that didn't have them. Without
    // CDP_VISIBLE_DEFAULT, the normal-flow Start would treat undefined as
    // "false" (background) which is the intended default anyway — but
    // writing it explicitly keeps the .env self-documenting and lets the
    // Settings page read/write it cleanly.
    if (!have.has("CDP_VISIBLE_DEFAULT")) {
      additions.push("CDP_VISIBLE_DEFAULT=false");
    }
    if (!have.has("GTSS_BRIDGE_PORT")) {
      additions.push("GTSS_BRIDGE_PORT=9224");
    }

    if (additions.length > 0) {
      fs.appendFileSync(this.envPath, "\n# Backfilled on launch\n" + additions.join("\n") + "\n");
    }
  }

  /** Read the .env file as a flat object. */
  readEnv() {
    if (!fs.existsSync(this.envPath)) return {};
    const txt = fs.readFileSync(this.envPath, "utf8");
    const out = {};
    for (const line of txt.split(/\r?\n/)) {
      const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
      if (m) out[m[1]] = m[2];
    }
    return out;
  }

  /** Upsert a single key=value pair into the .env file. */
  upsert(key, value) {
    const lines = fs.existsSync(this.envPath)
      ? fs.readFileSync(this.envPath, "utf8").split(/\r?\n/)
      : [];
    let found = false;
    const next = lines.map((l) => {
      if (new RegExp(`^${key}=`).test(l)) {
        found = true;
        return `${key}=${value}`;
      }
      return l;
    });
    if (!found) next.push(`${key}=${value}`);
    // Owner-only perms on POSIX; icacls ACL lockdown on Windows (see secure-write.js).
    secureWriteSync(this.envPath, next.join("\n") + "\n", { mode: 0o600 });
  }

  /** True if the user has gone through onboarding at least once. */
  isOnboardingComplete() {
    const env = this.readEnv();
    return Boolean(env.PASSPHRASE_HASH);
  }

  /** Mark onboarding as done by storing the bcrypt'd passphrase. */
  async setPassphrase(passphrase) {
    const bcrypt = require("bcryptjs");
    const hash = await bcrypt.hash(passphrase, 10);
    this.upsert("PASSPHRASE_HASH", hash);
  }

  setGeminiKey(key) {
    this.upsert("GEMINI_API_KEY", key);
  }

  setCdpEndpoint(url) {
    this.upsert("CDP_ENDPOINT", url);
    this.upsert("BROWSER_MODE", "cdp");
  }
}

module.exports = { EnvBootstrap };
