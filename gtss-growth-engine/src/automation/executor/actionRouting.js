/**
 * Executor — Action Routing (runAutomationAction)
 *
 * runAutomationAction(action, browserState, emit) is the central dispatcher
 * that turns a queued action into an actual browser operation:
 *
 *   - Instagram actions are handled inline via a switch on actionType
 *     (instagram_dm / instagram_follow / instagram_like /
 *     instagram_story_view / instagram_warmup_advance), using the
 *     ./instagram and ./instagramWarmup modules.
 *   - All other platforms are loaded via `require('./${platform}')` and
 *     routed to either sendConnectionRequest / followUser (for connect /
 *     follow actions, with an optional warm-up like first) or
 *     sendDirectMessage (for dm actions, with a belt-and-suspenders
 *     bringToFront first).
 *
 * Returns an outcome object: { outcome, reason, isMessageRequest? }.
 *
 * Extracted from the original automation/executor.js for maintainability.
 */

const { normalizeActionType } = require('../../db/database');
const { humanDelay } = require('../browserBase');
const { isWithinLimit } = require('./limits');
const { determineActionType } = require('./actionTypes');

async function runAutomationAction(action, browserState, emit) {
  const { platform } = action;
  const actionType = action.action_type || determineActionType(action);

  // Handle specific Instagram actions directly via switch routing
  if (platform === 'instagram') {
    const instagram = require('../instagram');
    const instagramWarmup = require('../instagramWarmup');
    const { page } = browserState;
    const limits = require('../../config/limits');

    const normalized = normalizeActionType(actionType);
    const hasLimit =
      limits.instagram && typeof limits.instagram[normalized] === 'number';
    if (hasLimit && !isWithinLimit('instagram', actionType)) {
      emit('warn', `Instagram action ${actionType} limit reached. Skipping.`);
      return {
        outcome: 'skipped',
        reason: `Daily limit reached for instagram ${actionType}`,
      };
    }

    // Extract username from profile_url
    const username = action.profile_url
      ? action.profile_url.replace(/\/$/, '').split('/').pop()
      : '';

    switch (actionType) {
      case 'instagram_dm': {
        const result = await instagram.sendDM(
          page,
          { username, message: action.body },
          emit,
        );
        return {
          outcome: result.success ? 'sent' : 'failed',
          reason: result.error || null,
          isMessageRequest: result.isMessageRequest,
        };
      }
      case 'instagram_follow': {
        const result = await instagram.followAccount(page, { username }, emit);
        return {
          outcome: result.success ? 'sent' : 'failed',
          reason: result.error || null,
        };
      }
      case 'instagram_like': {
        const result = await instagram.likeRecentPost(page, { username }, emit);
        return {
          outcome: result.success ? 'sent' : 'failed',
          reason: result.error || null,
        };
      }
      case 'instagram_story_view': {
        const result = await instagram.viewStory(page, { username }, emit);
        return {
          outcome: result.success ? 'sent' : 'failed',
          reason: result.error || null,
        };
      }
      case 'instagram_warmup_advance': {
        const result = await instagramWarmup.advanceWarmupStep(
          page,
          { leadId: action.lead_id },
          emit,
        );
        return {
          outcome: result.success ? 'sent' : 'failed',
          reason: result.error || null,
        };
      }
    }
  }

  let automationModule;

  try {
    automationModule = require(`../${platform}`);
  } catch (err) {
    emit('error', `Automation module for ${platform} not implemented.`);
    return { outcome: 'failed', reason: 'Module not implemented' };
  }

  const { page } = browserState;

  if (
    (actionType === 'connect' || actionType === 'follow') &&
    (automationModule.sendConnectionRequest || automationModule.followUser)
  ) {
    if (automationModule.likeRecentPost) {
      emit('info', 'Warming up: liking a recent post...');
      await automationModule.likeRecentPost(page, action.profile_url, emit);
      await humanDelay(3000, 6000);
    }
    if (actionType === 'follow' && automationModule.followUser) {
      return await automationModule.followUser(page, action.profile_url, emit);
    }
    const connectionNote = action.connection_note || action.connect_note || '';
    return await automationModule.sendConnectionRequest(
      page,
      action.profile_url,
      connectionNote,
      emit,
    );
  } else if (actionType === 'dm' && automationModule.sendDirectMessage) {
    // Bug #6 fix: bring the automation tab to front at the architecture level
    // before handing the page to any platform module. This is belt-and-suspenders
    // for platforms that may not call bringToFront internally — every DM action
    // gets it for free, so no platform module can forget it.
    const { page: dmPage } = browserState;
    if (dmPage && typeof dmPage.bringToFront === 'function') {
      await dmPage.bringToFront().catch(() => {});
      await new Promise((r) => setTimeout(r, 150));
    }
    return await automationModule.sendDirectMessage(
      page,
      action.profile_url,
      action.body,
      emit,
      action.lead_name || null,
    );
  } else {
    emit('error', `Action ${actionType} not supported for ${platform}.`);
    return { outcome: 'failed', reason: 'Unsupported action' };
  }
}

module.exports = { runAutomationAction };
