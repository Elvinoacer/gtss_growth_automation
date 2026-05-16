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

/**
 * Resolve the effective mode for a given pipeline stage.
 * Checks the stage-specific env var first, then falls back to PIPELINE_MODE.
 *
 * @param {string} stage - One of: discovery, qualification, message, send
 * @returns {'ai'|'manual'}
 */
function stageMode(stage) {
  const stageKey = `${stage.toUpperCase()}_MODE`;
  const stageValue = (process.env[stageKey] || '').trim().toLowerCase();
  if (stageValue === 'ai' || stageValue === 'manual') return stageValue;
  const globalValue = (process.env.PIPELINE_MODE || 'ai').trim().toLowerCase();
  return globalValue === 'manual' ? 'manual' : 'ai';
}

/**
 * Which message variant to auto-approve after generation.
 * @returns {'A'|'B'}
 */
function autoApproveVariant() {
  const v = (process.env.MESSAGE_AUTO_APPROVE_VARIANT || 'B').toUpperCase();
  return v === 'A' ? 'A' : 'B';
}

/**
 * Leads below this score are deprioritised during AI qualification.
 * @returns {number}
 */
function qualificationThreshold() {
  const v = Number(process.env.QUALIFICATION_THRESHOLD);
  return Number.isFinite(v) && v >= 0 ? v : 50;
}

/**
 * Score assigned to all leads in manual qualification mode.
 * @returns {number}
 */
function manualQualificationScore() {
  const v = Number(process.env.QUALIFICATION_MANUAL_SCORE);
  return Number.isFinite(v) && v >= 0 ? v : 75;
}

/**
 * Cron expression for scheduled pipeline runs.
 * @returns {string}
 */
function pipelineCron() {
  return (process.env.PIPELINE_CRON || '0 8 * * *').trim();
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
