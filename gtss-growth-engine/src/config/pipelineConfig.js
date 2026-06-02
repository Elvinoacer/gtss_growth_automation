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

module.exports = {
  stageMode,
  autoApproveVariant,
  qualificationThreshold,
  manualQualificationScore,
  pipelineCron,
  keywordsFilePath,
};
