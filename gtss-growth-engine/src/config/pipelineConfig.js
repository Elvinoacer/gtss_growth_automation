/**
 * Pipeline Configuration Helper
 *
 * Reads PIPELINE_MODE and per-stage overrides from environment variables.
 * Each stage can inherit the global mode or set its own.
 *
 * Usage:
 *   const { stageMode } = require('./pipelineConfig');
 *   stageMode('qualification') // → 'ai' | 'manual'
 */

/** Default platforms for lead-discovery / outreach DM when none are configured. */
const DEFAULT_OUTREACH_PLATFORMS = ["linkedin"];

/**
 * Platforms that are hard to automate for cold DMs (rate limits, privacy
 * controls, anti-bot). Discovery + outreach DM pipelines exclude them
 * unless the operator explicitly re-enables each flag.
 *
 *   - X: premium/verified often required for reliable DMs
 *   - Instagram: strict rate limits, message-request gates, anti-bot
 */
const X_DM_OUTREACH_SETTING_KEY = "x_dm_outreach_enabled";
const X_DM_OUTREACH_ENV_KEY = "X_DM_OUTREACH_ENABLED";
const IG_DM_OUTREACH_SETTING_KEY = "ig_dm_outreach_enabled";
const IG_DM_OUTREACH_ENV_KEY = "IG_DM_OUTREACH_ENABLED";

function getSettingValue(key) {
  try {
    const { getDb } = require("../db/database");
    return getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key)
      ?.value;
  } catch (_) {
    return null;
  }
}

function envOrSetting(envKey, settingKey, fallback = "") {
  const stored = getSettingValue(settingKey);
  if (stored !== undefined && stored !== null && String(stored).trim() !== "") {
    return String(stored);
  }
  return process.env[envKey] || fallback;
}

function parseBoolSetting(raw) {
  const v = String(raw || "")
    .trim()
    .toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Whether X is allowed in lead discovery + outreach DM send flows.
 * Default: false (disabled). Operators re-enable for premium accounts.
 * @returns {boolean}
 */
function isXDmOutreachEnabled() {
  return parseBoolSetting(
    envOrSetting(X_DM_OUTREACH_ENV_KEY, X_DM_OUTREACH_SETTING_KEY, "false"),
  );
}

/**
 * Whether Instagram is allowed in lead discovery + outreach DM send flows.
 * Default: false — IG rate-limits DMs aggressively and many accounts block
 * message requests. Mass-follow / warmup / content posting are unaffected.
 * @returns {boolean}
 */
function isIgDmOutreachEnabled() {
  return parseBoolSetting(
    envOrSetting(IG_DM_OUTREACH_ENV_KEY, IG_DM_OUTREACH_SETTING_KEY, "false"),
  );
}

/**
 * Platforms currently blocked from discovery → outreach DM (flags off).
 * @returns {string[]}
 */
function disabledOutreachDmPlatforms() {
  const blocked = [];
  if (!isXDmOutreachEnabled()) blocked.push("x");
  if (!isIgDmOutreachEnabled()) blocked.push("instagram");
  return blocked;
}

/**
 * Strip platforms whose DM outreach flag is off (X and/or Instagram).
 * Non-arrays yield []. Empty still means "no platforms" at call sites
 * that treat empty as "no filter" — callers should apply defaults first.
 * @param {string[]|unknown} platforms
 * @returns {string[]}
 */
function filterOutreachPlatforms(platforms) {
  const list = Array.isArray(platforms)
    ? platforms
        .map((platform) => String(platform || "").trim().toLowerCase())
        .filter(Boolean)
    : [];
  const blocked = new Set(disabledOutreachDmPlatforms());
  if (blocked.size === 0) return list;
  return list.filter((platform) => !blocked.has(platform));
}

/**
 * Human-readable note for logs / UI when platforms were stripped.
 * @param {string[]} before
 * @param {string[]} after
 * @returns {string|null}
 */
function describeStrippedOutreachPlatforms(before, after) {
  const beforeSet = new Set(
    (before || []).map((p) => String(p).toLowerCase()),
  );
  const afterSet = new Set((after || []).map((p) => String(p).toLowerCase()));
  const stripped = [...beforeSet].filter((p) => !afterSet.has(p));
  if (stripped.length === 0) return null;
  const labels = stripped.map((p) =>
    p === "x" ? "X" : p === "instagram" ? "Instagram" : p,
  );
  return `${labels.join(" & ")} excluded from discovery/DM (disabled by default). Re-enable under Settings → Pipeline Configuration when ready.`;
}

/**
 * Default discovery / outreach platform list (LinkedIn; never X/IG unless enabled).
 * @returns {string[]}
 */
function defaultOutreachPlatforms() {
  return filterOutreachPlatforms([...DEFAULT_OUTREACH_PLATFORMS]);
}

/**
 * Resolve the effective mode for a given pipeline stage.
 * Checks the stage-specific env var first, then falls back to PIPELINE_MODE.
 *
 * @param {string} stage - One of: discovery, qualification, message, send
 * @returns {'ai'|'manual'}
 */
function stageMode(stage) {
  const stageKey = `${stage.toUpperCase()}_MODE`;
  const settingKey = `${stage}_mode`;
  const stageValue = envOrSetting(stageKey, settingKey, '').trim().toLowerCase();
  if (stageValue === 'ai' || stageValue === 'manual') return stageValue;
  const globalValue = envOrSetting('PIPELINE_MODE', 'pipeline_mode', 'ai').trim().toLowerCase();
  return globalValue === 'manual' ? 'manual' : 'ai';
}

/**
 * Which message variant to auto-approve after generation.
 * @returns {'A'|'B'}
 */
function autoApproveVariant() {
  const v = envOrSetting('MESSAGE_AUTO_APPROVE_VARIANT', 'message_auto_approve_variant', 'B').toUpperCase();
  return v === 'A' ? 'A' : 'B';
}

/**
 * Leads below this score are deprioritised during AI qualification.
 * @returns {number}
 */
function qualificationThreshold() {
  const v = Number(envOrSetting('QUALIFICATION_THRESHOLD', 'qualification_threshold'));
  return Number.isFinite(v) && v >= 0 ? v : 50;
}

/**
 * Score assigned to all leads in manual qualification mode.
 * @returns {number}
 */
function manualQualificationScore() {
  const v = Number(envOrSetting('QUALIFICATION_MANUAL_SCORE', 'qualification_manual_score'));
  return Number.isFinite(v) && v >= 0 ? v : 75;
}

/**
 * Cron expression for scheduled pipeline runs.
 * @returns {string}
 */
function pipelineCron() {
  return envOrSetting('PIPELINE_CRON', 'pipeline_cron', '0 8 * * *').trim();
}

/**
 * Path to the keywords JSON configuration file.
 * @returns {string}
 */
function keywordsFilePath() {
  return process.env.PIPELINE_DISCOVERY_KEYWORDS_FILE || './src/config/keywords.json';
}

/**
 * Resolve the source for outreach message generation.
 * 'ai' = use Gemini (API key first, Gemini Web fallback) — the user's
 *        preferred default for full lead-discovery runs.
 * 'template' = use the canonical templates from settings/templates.json
 *              (manual control, no AI calls).
 *
 * The setting is read from `message_generation_source` (DB) or
 * MESSAGE_GENERATION_SOURCE env var. Default: 'ai'.
 *
 * @returns {'ai'|'template'}
 */
function messageGenerationSource() {
  const v = envOrSetting('MESSAGE_GENERATION_SOURCE', 'message_generation_source', 'ai')
    .trim()
    .toLowerCase();
  return v === 'template' ? 'template' : 'ai';
}

module.exports = {
  stageMode,
  autoApproveVariant,
  qualificationThreshold,
  manualQualificationScore,
  pipelineCron,
  keywordsFilePath,
  messageGenerationSource,
  isXDmOutreachEnabled,
  isIgDmOutreachEnabled,
  disabledOutreachDmPlatforms,
  filterOutreachPlatforms,
  describeStrippedOutreachPlatforms,
  defaultOutreachPlatforms,
  DEFAULT_OUTREACH_PLATFORMS,
  X_DM_OUTREACH_SETTING_KEY,
  X_DM_OUTREACH_ENV_KEY,
  IG_DM_OUTREACH_SETTING_KEY,
  IG_DM_OUTREACH_ENV_KEY,
};
