/**
 * x/selectors.js
 *
 * Every X (Twitter) CSS / data-testid selector used by the X automation
 * adapter. Kept as one constant so selector updates live in one place —
 * when X ships a UI change, only this file needs editing.
 *
 * Each property is an ORDERED array of selectors: the action helpers try
 * them in order via `firstVisible` / `firstVisibleOnProfile` and use the
 * first match that becomes visible. This redundancy is intentional — X
 * frequently A/B-tests selector shapes, so each entry includes the
 * canonical data-testid plus aria-label / text-content fallbacks.
 *
 * Selector groups:
 *   - profileHeader   — the wrapping element of a profile page (used to
 *                       scope follow / message button lookups so we don't
 *                       accidentally match buttons in the side rail)
 *   - emptyState      — "Account suspended" / "This account doesn't exist"
 *   - follow / unfollow / pending  — the three Follow-button states
 *   - message         — the Message button on a profile page
 *   - dmComposer / dmSend / dmMessageEntry  — DM composer + send button
 *                                              + post-send confirmation
 *   - tweet           — a single tweet article on the timeline
 *   - like / unlike   — the Like button (two states)
 *   - toast           — generic toast / alert (rate-limit / try-again)
 */

const SELECTORS = {
  profileHeader: [
    '[data-testid="UserProfileHeader_Items"]',
    '[data-testid="primaryColumn"]',
    'main[role="main"]',
  ],
  emptyState: [
    '[data-testid="emptyState"]',
    '.css-175oi2r:has-text("Account suspended")',
    '.css-175oi2r:has-text("This account doesn’t exist")',
  ],
  follow: [
    '[data-testid$="-follow"]',
    '[data-testid="follow"]',
    'button:has-text("Follow")',
  ],
  unfollow: [
    '[data-testid$="-unfollow"]',
    '[data-testid="unfollow"]',
    'button:has-text("Following")',
    'button:has-text("Unfollow")',
  ],
  pending: [
    'button:has-text("Pending")',
    'button:has-text("Requested")',
  ],
  message: [
    '[data-testid="sendDMFromProfile"]',
    'button[aria-label="Message"]',
    '[aria-label*="Message" i]',
  ],
  dmComposer: [
    '[data-testid="dmComposerTextInput"]',
    'div[data-testid="dmComposerTextInput"]',
    'div[role="textbox"]',
    '[contenteditable="true"]',
  ],
  dmSend: [
    '[data-testid="dmComposerSendButton"]',
    'button[aria-label="Send"]',
    'button:has-text("Send")',
  ],
  dmMessageEntry: [
    '[data-testid="messageEntry"]',
    '.css-175oi2r:has-text("Sent")',
  ],
  tweet: [
    'article[data-testid="tweet"]',
    '[data-testid="tweet"]',
  ],
  like: [
    '[data-testid="like"]',
    'button[aria-label*="Like"]',
  ],
  unlike: [
    '[data-testid="unlike"]',
    'button[aria-label*="Liked"]',
  ],
  toast: [
    '[data-testid="toast"]',
    '[role="alert"]',
    '.Toastify__toast',
  ],
};

module.exports = { SELECTORS };
