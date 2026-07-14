/**
 * pipelineScheduler/lifecycle.js
 *
 * Pipeline-execution lifecycle helpers:
 *   - runPipelineWithLifecycle(pipelineId, trigger, limits, options)
 *       Run a single pipeline via the state service, with single-instance
 *       enforcement. Creates a NEW pipeline_executions row, runs the
 *       matching RUNNERS[pipelineId] function, and marks the execution
 *       completed/failed when the runner returns/throws.
 *
 *       `force: true` (only valid with trigger='manual') auto-clears a
 *       STUCK execution before running. If the active execution is
 *       actually progressing, refuses with a clear error so the user
 *       doesn't interrupt real work.
 *
 *   - runExistingExecution(pipelineId, executionId, trigger, limits, options)
 *       Re-run an EXISTING execution (used by retry-stage and
 *       resume-from-checkpoint). Does NOT create a new
 *       pipeline_executions row — reuses the provided executionId.
 *       Re-arms the in-memory ACTIVE_EXECUTIONS map so the runner's
 *       throwIfAborted / awaitResume / updateExecutionProgress calls
 *       work correctly.
 *
 * The split files live one directory deeper than the original
 * pipelineScheduler.js, so every `require("../X")` in the original file
 * becomes `require("../../X")` here for paths to ../../services.
 */

const pipelineState = require('../../services/pipelineStateService');
const pipelineLogger = require('../../services/pipelineLogger');
const { RUNNERS } = require('./runners');

/**
 * Run a single pipeline via the state service, with single-instance enforcement.
 *
 * @param {string} pipelineId
 * @param {string} trigger - 'cron' | 'manual' | 'api' | 'retry' | 'resume'
 * @param {Object} limits - limits_json bag
 * @param {Object} [options] - { executionId, resumeFrom, keywords, force }
 */
async function runPipelineWithLifecycle(pipelineId, trigger, limits, options = {}) {
  // `force: true` means "auto-clear any stuck execution before running".
  // We only auto-clear when the active execution is NOT making progress
  // (i.e., genuinely stuck). If it IS progressing, we refuse with a clear
  // error so the user doesn't accidentally interrupt real work.
  const wantsForce = trigger === 'manual' && options.force;
  if (!pipelineState.canStart(pipelineId, { force: wantsForce })) {
    const active = pipelineState.getActiveExecution(pipelineId);
    if (active && pipelineState.isExecutionProgressing(pipelineId)) {
      // Genuinely running — refuse with a clear error.
      const message = `Pipeline "${pipelineId}" is already running (execution ${active.id}). Wait for it to finish, or click Stop / Force Clear first.`;
      pipelineLogger.log({
        pipelineId,
        level: 'warn',
        stage: 'scheduler',
        message,
        context: { trigger, activeExecutionId: active.id },
      });
      throw new Error(message);
    }
    // Stuck — auto-clear and proceed.
    if (active) {
      pipelineLogger.log({
        pipelineId,
        level: 'warn',
        stage: 'scheduler',
        message: `Auto force-clearing stuck execution ${active.id} before ${trigger} run.`,
        context: { trigger, activeExecutionId: active.id },
      });
      pipelineState.forceClearExecution(pipelineId, `${trigger} (auto-cleared stale execution)`);
    }
  }

  const totalSteps = pipelineId === 'outreach' ? 4 : pipelineId === 'content' ? 4 : pipelineId === 'mass_follow' ? 3 : 1;
  const exec = pipelineState.createExecution(pipelineId, trigger, {
    startMessage: `Initializing ${pipelineId} pipeline…`,
    totalSteps,
    maxRetries: 3,
    limits,
    resumeFrom: options.resumeFrom || null,
    keywords: options.keywords || null,
    platforms: limits?.platforms || null,
  });

  try {
    const runner = RUNNERS[pipelineId];
    if (!runner) throw new Error(`No runner registered for pipeline "${pipelineId}"`);
    await runner(limits, {
      trigger,
      executionId: exec.id,
      resumeFrom: options.resumeFrom,
      keywords: options.keywords,
    });
    pipelineState.markExecutionCompleted(exec.id);
    return exec.id;
  } catch (err) {
    pipelineState.markExecutionFailed(exec.id, err, err.failedStage || null);
    throw err;
  }
}

/**
 * Re-run an EXISTING execution (used by retry-stage and resume-from-checkpoint).
 *
 * Unlike runPipelineWithLifecycle, this does NOT create a new
 * pipeline_executions row — it reuses the provided executionId. This is
 * the public API that the retry-stage and resume-from-checkpoint routes
 * should use, replacing the previous pattern of calling __getRunner +
 * __setActive directly (which were private APIs and easy to misuse).
 *
 * @param {string} pipelineId
 * @param {string} executionId - existing execution to re-run
 * @param {string} trigger - 'retry' | 'resume'
 * @param {Object} limits - limits_json bag
 * @param {Object} [options] - { resumeFrom, keywords }
 */
async function runExistingExecution(pipelineId, executionId, trigger, limits, options = {}) {
  if (!pipelineId || !executionId) {
    throw new Error('pipelineId and executionId are required');
  }
  const runner = RUNNERS[pipelineId];
  if (!runner) throw new Error(`No runner registered for pipeline "${pipelineId}"`);

  // Re-arm the in-memory ACTIVE_EXECUTIONS map for this existing
  // executionId. Without this, the runner's throwIfAborted / awaitResume
  // / updateExecutionProgress calls would no-op (because the
  // executionId is no longer in the map after the previous run
  // terminated).
  pipelineState.__setActive(pipelineId, executionId);

  // Transition the execution row to 'running' so the UI shows the
  // correct state. If the transition fails (e.g., the row is in a
  // terminal state and the state machine refuses), we log and proceed
  // anyway — the runner will still update progress.
  try {
    pipelineState.transitionExecution(executionId, pipelineState.STATES.RUNNING);
  } catch (err) {
    pipelineLogger.log({
      pipelineId,
      executionId,
      level: 'warn',
      stage: 'scheduler',
      message: `Could not transition execution to RUNNING: ${err.message}`,
      context: { trigger },
    });
  }

  try {
    await runner(limits, {
      trigger,
      executionId,
      resumeFrom: options.resumeFrom,
      keywords: options.keywords,
    });
    pipelineState.markExecutionCompleted(executionId);
    return executionId;
  } catch (err) {
    pipelineState.markExecutionFailed(executionId, err, err.failedStage || null);
    throw err;
  }
}

module.exports = { runPipelineWithLifecycle, runExistingExecution };
