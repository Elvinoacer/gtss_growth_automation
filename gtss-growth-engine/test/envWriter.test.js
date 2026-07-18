/**
 * Regression: envWriter must honour GTSS_ENV_PATH / DOTENV_CONFIG_PATH so
 * packaged installs write to the writable userData .env, not the read-only
 * bundled server tree (Cross-Platform Gap Analysis P0 #1).
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { getEnvPath, upsertEnvValue } = require("../src/utils/envWriter");

describe("envWriter", () => {
  let tmpDir;
  let envPath;
  const prevGtss = process.env.GTSS_ENV_PATH;
  const prevDotenv = process.env.DOTENV_CONFIG_PATH;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gtss-envwriter-"));
    envPath = path.join(tmpDir, ".env");
  });

  after(() => {
    if (prevGtss === undefined) delete process.env.GTSS_ENV_PATH;
    else process.env.GTSS_ENV_PATH = prevGtss;
    if (prevDotenv === undefined) delete process.env.DOTENV_CONFIG_PATH;
    else process.env.DOTENV_CONFIG_PATH = prevDotenv;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  });

  it("prefers GTSS_ENV_PATH over defaults", () => {
    process.env.GTSS_ENV_PATH = envPath;
    delete process.env.DOTENV_CONFIG_PATH;
    assert.equal(getEnvPath(), envPath);
  });

  it("falls back to DOTENV_CONFIG_PATH when GTSS_ENV_PATH is unset", () => {
    delete process.env.GTSS_ENV_PATH;
    process.env.DOTENV_CONFIG_PATH = envPath;
    assert.equal(getEnvPath(), envPath);
  });

  it("writes and updates keys at the configured path", () => {
    process.env.GTSS_ENV_PATH = envPath;
    delete process.env.DOTENV_CONFIG_PATH;

    upsertEnvValue("PASSPHRASE_HASH", "hash-v1");
    assert.ok(fs.existsSync(envPath));
    let content = fs.readFileSync(envPath, "utf8");
    assert.match(content, /^PASSPHRASE_HASH=hash-v1$/m);

    upsertEnvValue("PASSPHRASE_HASH", "hash-v2");
    upsertEnvValue("PIPELINE_MODE", "ai");
    content = fs.readFileSync(envPath, "utf8");
    assert.match(content, /^PASSPHRASE_HASH=hash-v2$/m);
    assert.match(content, /^PIPELINE_MODE=ai$/m);
    assert.ok(!content.includes("hash-v1"));
  });

  it("does not write into the server-root .env when GTSS_ENV_PATH is set", () => {
    process.env.GTSS_ENV_PATH = envPath;
    delete process.env.DOTENV_CONFIG_PATH;
    const serverRootEnv = path.join(__dirname, "..", ".env");
    const existedBefore = fs.existsSync(serverRootEnv);
    const mtimeBefore = existedBefore ? fs.statSync(serverRootEnv).mtimeMs : null;

    upsertEnvValue("TEST_KEY_ISOLATION", "yes");

    assert.ok(fs.readFileSync(envPath, "utf8").includes("TEST_KEY_ISOLATION=yes"));
    if (existedBefore) {
      assert.equal(fs.statSync(serverRootEnv).mtimeMs, mtimeBefore);
    } else {
      assert.equal(fs.existsSync(serverRootEnv), false);
    }
  });
});
