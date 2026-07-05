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

const REQUIRED_DIRS = [
  "data",
  "data/browser-locks",
  "sessions",
  "profiles",
  "artifacts/automation",
  "artifacts/gemini-images",
  "media",
  "public/uploads",
];

class EnvBootstrap {
  /**
   * @param {string} serverRoot  Absolute path to the gtss-growth-engine source.
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
    if (!fs.existsSync(this.dataRoot)) {
      fs.mkdirSync(this.dataRoot, { recursive: true });
    }
    for (const dir of REQUIRED_DIRS) {
      fs.mkdirSync(path.join(this.dataRoot, dir), { recursive: true });
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

  async writeInitialEnv() {
    const env = {
      SESSION_SECRET: crypto.randomBytes(32).toString("hex"),
      ENCRYPTION_KEY: crypto.randomBytes(32).toString("hex"),
      GEMINI_MODEL: "gemini-2.0-flash",
      DB_PATH: path.join(this.dataRoot, "data", "gtss.db"),
      SESSION_DIR: path.join(this.dataRoot, "sessions"),
      AUTOMATION_ARTIFACTS_DIR: path.join(this.dataRoot, "artifacts", "automation"),
      GEMINI_IMAGE_SAVE_DIR: path.join(this.dataRoot, "artifacts", "gemini-images"),
      AUTOMATION_LOCKS_DIR: path.join(this.dataRoot, "data", "browser-locks"),
<<<<<<< HEAD
      BROWSER_MODE: "persistent",
      BROWSER_CHANNEL: "chrome",
=======
      // CDP is the default browser mode. The launcher starts a CDP Chrome
      // (the user's real Chrome with --remote-debugging-port and a copied
      // profile) and opens the web app inside it. This way the web app and
      // automation share the same Chrome instance — no friction, no "two
      // Chrome windows" confusion.
      BROWSER_MODE: "cdp",
      BROWSER_CHANNEL: "chrome",
      CDP_ENDPOINT: "http://127.0.0.1:9222",
      CDP_PORT: "9222",
>>>>>>> e833c74 (feat: add Windows and Linux installers for GTSS Growth Engine)
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
<<<<<<< HEAD
      // CDP endpoint — populated by CdpManager when the user starts the CDP browser.
      CDP_ENDPOINT: "",
=======
>>>>>>> e833c74 (feat: add Windows and Linux installers for GTSS Growth Engine)
      // User must set these via onboarding or Settings.
      PASSPHRASE_HASH: "",
      GEMINI_API_KEY: "",
      GMAIL_USER: "",
      GMAIL_APP_PASSWORD: "",
      PORT: "3000",
    };

    const lines = Object.entries(env).map(([k, v]) => `${k}=${v}`);
    lines.push("");
    fs.writeFileSync(this.envPath, lines.join("\n"), { mode: 0o600 });
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
    fs.writeFileSync(this.envPath, next.join("\n") + "\n", { mode: 0o600 });
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
