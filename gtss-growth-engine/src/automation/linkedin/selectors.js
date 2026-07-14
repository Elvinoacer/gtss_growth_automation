/**
 * LinkedIn CSS Selector Catalog
 * Central registry of selector arrays used across the LinkedIn automation
 * module. Extracted from the original linkedin.js for maintainability.
 *
 * Each property is an array of selectors tried in order by `firstVisible` /
 * `firstVisibleIn` / `firstVisibleOnProfile` until one matches a visible
 * element on the page.
 */

const SELECTORS = {
  profileHeader: [
    "main section:has(h1.text-heading-xlarge)",
    "main section:has(.pv-text-details__left-panel)",
    "main section:has(.pv-top-card__photo-wrapper)",
    "main .pv-top-card",
    "main .ph5.pb5:has(h1)",
  ],
  connect: [
    'button[aria-label*="Invite"][aria-label*="connect"]',
    'button[aria-label*="connect" i]',
    'button:has-text("Connect")',
    '[role="button"]:has-text("Connect")',
    '.artdeco-button:has-text("Connect")',
    '[data-control-name="connect"]',
    '.artdeco-dropdown__content button:has-text("Connect")',
  ],
  message: [
    'a[href*="/messaging/compose/"]:has-text("Message")',
    'a[href*="/messaging/compose/"]',
    'a:has-text("Message")',
    'a[aria-label^="Message"]',
    'a[href*="/messaging/thread"]',
    'button:has-text("Message")',
    'button[aria-label^="Message"]',
    '[role="button"]:has-text("Message")',
    '.artdeco-button:has-text("Message")',
    '[data-control-name="message"]',
  ],
  follow: ['button:has-text("Follow")', 'button[aria-label*="Follow"]'],
  pending: ['button:has-text("Pending")', 'button[aria-label*="Pending"]'],
  more: [
    // Profile-area "More actions" button — strict selectors only.
    // NEVER use a bare `button[aria-label*="More"]` here: it matches
    // LinkedIn's top-nav "More" button (Home / My Network / Jobs /
    // Messaging / Notifications / More) which opens a completely
    // different menu (Learning, Salary, etc.) and traps the automation.
    'button[aria-label="More actions"]',
    'button[aria-label="More actions for this profile"]',
    '.pv-top-card [aria-label*="More"]',
    'section.pv-top-card button[aria-label*="More"]',
    '.ph5.pb5 button[aria-label*="More"]',
  ],
  actionDropdown: [
    ".artdeco-dropdown__content",
    ".artdeco-dropdown__content-inner",
    '[role="menu"]',
  ],
  modal: ['[role="dialog"]', ".artdeco-modal", ".send-invite"],
  premiumDialog: [
    '[role="dialog"]:has-text("Grow Your Business with Premium")',
    '[role="dialog"]:has-text("With Premium, you can message anyone")',
    '[role="dialog"]:has-text("Get Premium")',
    '[role="dialog"]:has-text("Premium")',
    '[role="dialog"]:has-text("InMail")',
    '.artdeco-modal:has-text("Premium")',
    '.artdeco-modal:has-text("InMail")',
  ],
  modalClose: [
    'button[aria-label="Dismiss"]',
    'button[aria-label="Close"]',
    'button:has-text("×")',
  ],
  addNote: [
    'button:has-text("Add a note")',
    'button[aria-label*="Add a note"]',
  ],
  noteTextarea: [
    'textarea[name="message"]',
    "textarea#custom-message",
    "textarea",
  ],
  modalSend: [
    'button:has-text("Send")',
    'button[aria-label*="Send"]',
    "button.artdeco-button--primary",
  ],
  dmEditor: [
    // Active modal specific selectors
    '.msg-overlay-conversation-bubble--is-active .msg-form__contenteditable',
    '.msg-overlay-conversation-bubble--is-active div[aria-label="Write a message…"]',
    '.msg-overlay-conversation-bubble--is-active [contenteditable="true"]',
    '.msg-overlay-conversation-bubble--is-active textarea',
    '.msg-overlay-conversation-bubble--is-active [role="textbox"]',

    // New interop Shadow DOM selectors
    '#interop-outlet [contenteditable="true"]',
    '#interop-outlet textarea',
    '#interop-outlet [role="textbox"]',

    // Legacy selectors
    '.msg-form__contenteditable[contenteditable="true"]',
    ".msg-form textarea",
    'textarea[name="message"]',
    'textarea[placeholder*="message" i]',
    'textarea[aria-label*="message" i]',
    'textarea[aria-label*="write" i]',
    '[contenteditable="true"][aria-label*="message" i]',
    '[contenteditable="true"][aria-label*="Write" i]',
    '[contenteditable="true"][data-placeholder]',
    '[role="textbox"][aria-label*="message" i]',
    '[role="textbox"][aria-label*="Write" i]',
    '[role="textbox"]',
    '[contenteditable="true"]',
    "textarea",
  ],
  dmOverlay: [
    // New interop Shadow DOM selectors
    '#interop-outlet',
    '[data-testid="interop-shadowdom"]',
    // Legacy selectors
    ".msg-overlay-conversation-bubble",
    ".msg-convo-wrapper",
    ".msg-form",
    '[role="dialog"]:has(textarea)',
    '[role="dialog"]:has([contenteditable="true"])',
    '[role="dialog"]:has([role="textbox"])',
    'aside[aria-label*="message" i]',
    'aside[aria-label*="Message" i]',
    ".msg-overlay-bubble-header",
    ".artdeco-modal--type-is-messaging",
  ],
  dmSend: [
    // Active modal specific selectors
    '.msg-overlay-conversation-bubble--is-active .msg-form__send-btn',
    '.msg-overlay-conversation-bubble--is-active button[type="submit"]',
    '.msg-overlay-conversation-bubble--is-active button[aria-label*="Send" i]',

    // New interop Shadow DOM selectors
    '#interop-outlet button[type="submit"]',
    '#interop-outlet button[aria-label*="Send" i]',

    // ── High-confidence: LinkedIn's own stable classes ──
    "button.msg-form__send-button:not([disabled])",
    "button.msg-form__send-button[aria-label]",
    "button.msg-form__send-button",

    // ── Submit buttons scoped to the message form ──
    '.msg-form__send-btn-container button[type="submit"]',
    '.msg-form button[type="submit"]',
    '.msg-form__right-actions button[type="submit"]',

    // ── aria-label based (covers icon-only send buttons) ──
    'button[aria-label="Send"][type="submit"]',
    'button[aria-label="Send"]',
    'button[aria-label="Send message"]',
    'button[aria-label*="Send" i][type="submit"]',

    // ── Scoped to messaging containers ──
    '.msg-overlay-conversation-bubble button[aria-label*="Send" i]',
    '[role="dialog"] button[aria-label*="Send" i]',
    '.msg-form button[aria-label*="Send" i]',
    '[role="dialog"] .msg-form button',

    // ── Text-based (broad fallbacks) ──
    '.msg-form button:has-text("Send")',
    '.msg-overlay-conversation-bubble button:has-text("Send")',
    '[role="dialog"] button:has-text("Send")',

    // ── Very broad fallbacks (last resort) ──
    'button:has-text("Send")',
    "button.artdeco-button--primary",
  ],
  unlikePost: [
    'button[aria-pressed="false"]:has-text("Like")',
    'button[aria-label*="React Like"]',
    'button[aria-label*="Like"][aria-pressed="false"]',
  ],
};

module.exports = { SELECTORS };
