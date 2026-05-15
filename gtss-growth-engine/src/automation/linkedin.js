const { humanDelay, humanScroll } = require('./browserBase');
const logger = require('../utils/logger');

const SELECTORS = {
  connect: [
    'button:has-text("Connect")',
    'button[aria-label*="Invite"]',
    'button[aria-label*="connect"]',
    '[data-control-name="connect"]',
    '.artdeco-dropdown__content button:has-text("Connect")'
  ],
  message: [
    'button:has-text("Message")',
    'button[aria-label*="Message"]',
    '[data-control-name="message"]'
  ],
  pending: [
    'button:has-text("Pending")',
    'button[aria-label*="Pending"]'
  ],
  more: [
    'button[aria-label="More actions"]',
    'button[aria-label*="More"]'
  ],
  addNote: [
    'button:has-text("Add a note")',
    'button[aria-label*="Add a note"]'
  ],
  noteTextarea: [
    'textarea[name="message"]',
    'textarea#custom-message',
    'textarea'
  ],
  modalSend: [
    'button:has-text("Send")',
    'button[aria-label*="Send"]',
    'button.artdeco-button--primary'
  ],
  dmEditor: [
    '.msg-form__contenteditable[role="textbox"]',
    '[contenteditable="true"][role="textbox"]',
    '.msg-form__msg-content-container [contenteditable="true"]'
  ],
  dmSend: [
    'button.msg-form__send-button',
    'button[aria-label*="Send"]',
    'button:has-text("Send")'
  ],
  unlikePost: [
    'button[aria-pressed="false"]:has-text("Like")',
    'button[aria-label*="React Like"]',
    'button[aria-label*="Like"][aria-pressed="false"]'
  ]
};

async function firstVisible(page, selectors, timeout = 1500) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      await locator.waitFor({ state: 'visible', timeout });
      return { locator, selector };
    } catch (_) {
      // Try the next fallback selector.
    }
  }
  return null;
}

async function isAnyVisible(page, selectors) {
  const match = await firstVisible(page, selectors, 500);
  return Boolean(match);
}

async function pageContainsAny(page, phrases) {
  const text = await page.locator('body').innerText({ timeout: 2000 }).catch(() => '');
  const normalized = text.toLowerCase();
  return phrases.find((phrase) => normalized.includes(phrase.toLowerCase())) || null;
}

async function detectActionWarning(page) {
  return pageContainsAny(page, [
    'try again later',
    'weekly invitation limit',
    'you’ve reached the weekly invitation limit',
    "you've reached the weekly invitation limit",
    'something went wrong',
    'unable to send',
    'could not send',
    'add their email'
  ]);
}

function messageSnippet(message) {
  return String(message || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

async function verifyDmSent(page, editorSelector, message) {
  await humanDelay(1500, 2500);
  const editorText = await page.locator(editorSelector).first().innerText({ timeout: 1000 }).catch(() => '');
  if (!editorText.trim()) return { verified: true, reason: 'Composer cleared' };

  const snippet = messageSnippet(message);
  if (snippet && await page.getByText(snippet, { exact: false }).last().isVisible({ timeout: 1500 }).catch(() => false)) {
    return { verified: true, reason: 'Message snippet visible' };
  }

  const warning = await detectActionWarning(page);
  if (warning) return { verified: false, reason: `LinkedIn warning: ${warning}` };

  return { verified: false, reason: 'Message composer did not clear after send' };
}

/**
 * Type a string character by character with human-like delays
 */
async function typeLikeHuman(page, selector, text) {
  // Focus the element first
  await page.focus(selector);
  
  for (let i = 0; i < text.length; i++) {
    await page.keyboard.type(text[i]);
    // Random delay between 50 and 150ms between keypresses
    const delay = Math.floor(Math.random() * 100) + 50;
    await humanDelay(delay, delay + 20); // slight variation
  }
}

async function typeIntoFirstVisible(page, selectors, text) {
  const match = await firstVisible(page, selectors, 2000);
  if (!match) {
    throw new Error(`No visible input found for selectors: ${selectors.join(', ')}`);
  }

  await match.locator.focus();
  for (let i = 0; i < text.length; i++) {
    await page.keyboard.type(text[i]);
    const delay = Math.floor(Math.random() * 100) + 50;
    await humanDelay(delay, delay + 20);
  }

  return match.selector;
}

/**
 * Perform a LinkedIn connection request with an optional note.
 */
async function sendConnectionRequest(page, profileUrl, message, emit) {
  try {
    emit('info', `Navigating to ${profileUrl}`);
    await page.goto(profileUrl, { waitUntil: 'domcontentloaded' });
    await humanDelay(3000, 5000);
    await humanScroll(page);

    emit('info', 'Page loaded. Locating Connect action...');
    
    const messageBtnVisible = await isAnyVisible(page, SELECTORS.message);
    const isPending = await isAnyVisible(page, SELECTORS.pending);
    
    if (isPending) {
      emit('warn', 'Connection request is already pending.');
      return { outcome: 'already_connected' };
    }

    let connectMatch = await firstVisible(page, SELECTORS.connect);

    // Sometimes Connect is hidden under a "More" menu
    if (!connectMatch) {
      emit('info', 'Connect action not immediately visible. Checking More menu...');
      const moreMatch = await firstVisible(page, SELECTORS.more, 1000);
      if (moreMatch) {
        await moreMatch.locator.click();
        await humanDelay(1000, 2000);
        connectMatch = await firstVisible(page, SELECTORS.connect, 2000);
      }
    }

    if (!connectMatch) {
      emit('warn', 'Could not find Connect action. Maybe already connected or followed?');
      if (messageBtnVisible) {
        return { outcome: 'already_connected' };
      }
      return { outcome: 'failed', reason: 'Button not found' };
    }

    emit('info', `Clicking Connect (${connectMatch.selector})...`);
    await connectMatch.locator.click();
    await humanDelay(2000, 3000);

    // If there's a message, look for "Add a note"
    if (message) {
      const addNoteMatch = await firstVisible(page, SELECTORS.addNote, 2000);
      if (addNoteMatch) {
        emit('info', 'Adding connection note...');
        await addNoteMatch.locator.click();
        await humanDelay(1000, 2000);

        emit('info', 'Typing message...');
        await typeIntoFirstVisible(page, SELECTORS.noteTextarea, message);
        await humanDelay(1000, 2000);
      } else {
        emit('warn', 'Add-note option not found. This request may send without a note.');
      }
    }

    // Look for the "Send" button (can be "Send" or "Send without a note")
    const sendMatch = await firstVisible(page, SELECTORS.modalSend, 3000);
    if (sendMatch && !(await sendMatch.locator.isDisabled().catch(() => false))) {
      emit('info', `Clicking Send (${sendMatch.selector})...`);
      await sendMatch.locator.click();
      await humanDelay(2000, 4000);

      const warning = await detectActionWarning(page);
      if (warning) {
        emit('error', `LinkedIn warning after Connect: ${warning}`);
        return { outcome: 'failed', reason: `LinkedIn warning: ${warning}` };
      }
      
      const nowPending = await isAnyVisible(page, SELECTORS.pending);
      if (nowPending) {
        emit('info', 'Connection request moved to pending.');
        return { outcome: 'sent' };
      }

      emit('info', 'Connection request submitted.');
      return { outcome: 'sent' };
    } else {
      // Maybe we hit a limit or email is required
      const isEmailRequired = await page.locator('input[type="email"]').isVisible();
      if (isEmailRequired) {
         emit('error', 'LinkedIn requires an email to connect with this user.');
         return { outcome: 'failed', reason: 'Email required' };
      }

      emit('error', 'Could not find "Send" button in modal.');
      return { outcome: 'failed', reason: 'Send button not found' };
    }

  } catch (err) {
    logger.error('LinkedIn Connection Request Failed', { profileUrl, error: err.message });
    emit('error', `Connection failed: ${err.message}`);
    return { outcome: 'failed', reason: err.message };
  }
}

/**
 * Send a Direct Message on LinkedIn to a 1st-degree connection.
 */
async function sendDirectMessage(page, profileUrl, message, emit) {
  try {
    emit('info', `Navigating to ${profileUrl}`);
    await page.goto(profileUrl, { waitUntil: 'domcontentloaded' });
    await humanDelay(3000, 5000);
    await humanScroll(page);

    const messageMatch = await firstVisible(page, SELECTORS.message, 3000);
    if (!messageMatch) {
       emit('warn', 'Could not find "Message" button. Ensure you are connected 1st-degree.');
       return { outcome: 'failed', reason: 'Not connected or cannot message' };
    }

    emit('info', `Clicking Message (${messageMatch.selector})...`);
    await messageMatch.locator.click();
    await humanDelay(2000, 3000);

    // The messaging overlay should pop up. Find the editor.
    const editorMatch = await firstVisible(page, SELECTORS.dmEditor, 5000);
    if (!editorMatch) {
       emit('error', 'Could not find message textarea in the chat overlay.');
       return { outcome: 'failed', reason: 'Textarea not found' };
    }

    emit('info', 'Typing DM...');
    await typeLikeHuman(page, editorMatch.selector, message);
    await humanDelay(1000, 2000);

    // Find the Send button
    const sendMatch = await firstVisible(page, SELECTORS.dmSend, 3000);
    if (sendMatch && !(await sendMatch.locator.isDisabled().catch(() => false))) {
       emit('info', `Clicking Send (${sendMatch.selector})...`);
       await sendMatch.locator.click();
       const verification = await verifyDmSent(page, editorMatch.selector, message);
       if (!verification.verified) {
         emit('error', `DM send could not be verified: ${verification.reason}`);
         return { outcome: 'failed', reason: verification.reason };
       }
       emit('info', `DM sent successfully (${verification.reason}).`);
       return { outcome: 'sent' };
    } else {
       // Could try pressing Enter if the button isn't visible/enabled normally
       emit('info', 'Pressing Enter to send...');
       await page.keyboard.press('Enter');
       const verification = await verifyDmSent(page, editorMatch.selector, message);
       if (!verification.verified) {
         emit('error', `DM send via Enter could not be verified: ${verification.reason}`);
         return { outcome: 'failed', reason: verification.reason };
       }
       emit('info', `DM sent via Enter key (${verification.reason}).`);
       return { outcome: 'sent' };
    }

  } catch (err) {
    logger.error('LinkedIn DM Failed', { profileUrl, error: err.message });
    emit('error', `DM failed: ${err.message}`);
    return { outcome: 'failed', reason: err.message };
  }
}

/**
 * Like a recent post on the user's profile to warm them up.
 */
async function likeRecentPost(page, profileUrl, emit) {
  try {
    // LinkedIn post URLs often look like /in/username/recent-activity/all/
    const activityUrl = profileUrl.replace(/\/$/, '') + '/recent-activity/all/';
    emit('info', `Navigating to activity feed: ${activityUrl}`);
    
    await page.goto(activityUrl, { waitUntil: 'domcontentloaded' });
    await humanDelay(3000, 5000);
    await humanScroll(page);

    // Look for posts
    // Note: LinkedIn changes classes frequently, these are approximate representations
    const likeMatch = await firstVisible(page, SELECTORS.unlikePost, 3000);

    if (!likeMatch) {
      emit('info', 'No unliked posts found on the recent activity page.');
      return { outcome: 'no_posts' };
    }

    emit('info', `Found an unliked post (${likeMatch.selector}). Liking the most recent one...`);

    // Scroll element into view
    await likeMatch.locator.scrollIntoViewIfNeeded();
    await humanDelay(1000, 2000);
    
    await likeMatch.locator.click();
    await humanDelay(2000, 3000);

    emit('info', 'Successfully liked a recent post.');
    return { outcome: 'liked' };

  } catch (err) {
    logger.error('LinkedIn Like Post Failed', { profileUrl, error: err.message });
    emit('error', `Liking post failed: ${err.message}`);
    return { outcome: 'failed', reason: err.message };
  }
}

module.exports = {
  sendConnectionRequest,
  sendDirectMessage,
  likeRecentPost
};
