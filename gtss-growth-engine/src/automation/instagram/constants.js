/**
 * Instagram Constants
 * Central registry of CSS selector arrays, debug run ID, and human-like
 * delay ranges used by the Instagram automation module.
 * Extracted from the original instagram.js for maintainability.
 */

const path = require("path");

const INSTAGRAM_DEBUG_RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");

// ── CONSTANTS ───────────────────────────────────────────────────────────────

const IG_SELECTORS = {
  followButton: [
    'button:has-text("Follow")',
    'button:has-text("Follow Back")',
    'button:has-text("Follow back")',
    'div[role="button"]:has-text("Follow")',
    'div[role="button"]:has-text("Follow Back")',
    'div[role="button"]:has-text("Follow back")',
  ],
  unfollowButton: [
    'button:has-text("Following")',
    'button:has-text("Requested")',
    'div[role="button"]:has-text("Following")',
    'div[role="button"]:has-text("Requested")',
  ],
  unfollowConfirm: [
    'button:has-text("Unfollow")',
    'span:has-text("Unfollow")',
    "button.xyb1x0",
    'div[role="button"]:has-text("Unfollow")',
  ],
  dmComposer: [
    'div[role="textbox"][contenteditable="true"]',
    'textarea[placeholder*="Message..."]',
    'div[aria-label*="Message" i]',
  ],
  dmSend: [
    'button:has-text("Send")',
    'div[role="button"]:has-text("Send")',
    'svg[aria-label="Send"]',
  ],
  newMessage: [
    'button[aria-label="New Message"]',
    'svg[aria-label="New message"]',
    'a[href*="/direct/new"]',
  ],
  recipientSearch: [
    'input[name="query"]',
    'input[placeholder*="Search..."]',
    'input[type="text"]',
  ],
  chatNext: ['button:has-text("Next")', 'div[role="button"]:has-text("Next")'],
  postCreate: [
    'div[aria-selected="false"]:has(svg[aria-label="New post"])',
    'div:has(svg[aria-label="New post"])',
    'div:has(svg[aria-label="Create"])',
    'div[role="button"]:has(svg[aria-label="New post"])',
    'div[role="button"]:has(svg[aria-label="Create"])',
    'svg[aria-label="New post"]',
    'svg[aria-label="Create"]',
    'span:has-text("Create")',
    'a[href*="/create"] span',
    'a[href="/create/"] span',
    'div[role="button"] svg[aria-label="New post"]',
    'a[role="link"]:has(svg[aria-label="Create"])',
    'div[role="button"]:has(svg[aria-label="Create"])',
  ],
  postCreateTooltipPost: [
    'a:has(span:text-is("Post"))',
    'div[role="button"]:has(span:text-is("Post"))',
    'span:text-is("Post")',
    'div:has(span:text-is("Post"))',
    '[role="menuitem"]:has-text("Post")',
    'div[tabindex="0"]:has(span:text-is("Post"))',
  ],
  fileInput: ['input[type="file"]'],
  captionBox: [
    'div[role="dialog"] textarea[aria-label*="caption" i]',
    'div[role="dialog"] textarea[placeholder*="caption" i]',
    'div[role="dialog"] div[role="textbox"][contenteditable="true"][aria-label*="caption" i]',
    'div[role="dialog"] div[aria-label*="Write a caption" i][contenteditable="true"]',
    'div[role="dialog"] div[role="textbox"][contenteditable="true"]',
    'div[role="textbox"][contenteditable="true"]',
    'div[aria-label*="Write a caption" i]',
    'textarea[aria-label*="caption" i]',
    'textarea[placeholder*="caption" i]',
  ],
  shareButton: [
    'div[role="dialog"] button[aria-label="Share"]',
    'div[role="dialog"] div[role="button"][aria-label="Share"]',
    'div[role="dialog"] button:has-text("Share")',
    'div[role="dialog"] div[role="button"]:has-text("Share")',
    'button:has-text("Share")',
    'div[role="button"]:has-text("Share")',
  ],
  storyRing: [
    'canvas[style*="cursor: pointer"]',
    'div[role="button"][aria-label*="Story"]',
    "header img[srcset]",
  ],
  storyClose: ['svg[aria-label="Close"]', 'button[aria-label="Close"]'],
  likeButton: [
    'span[class*="like"]',
    'svg[aria-label="Like"]',
    'svg[aria-label="Unlike"]',
    'button:has(svg[aria-label="Like"])',
    'button:has(svg[aria-label="Unlike"])',
  ],
};

const IG_DELAYS = {
  betweenProfileVisits: { min: 12000, max: 25000 },
  betweenFollows: { min: 45000, max: 120000 },
  betweenLikes: { min: 20000, max: 60000 },
  betweenDMs: { min: 60000, max: 180000 },
  afterHashtagLoad: { min: 5000, max: 12000 },
  afterAction: { min: 3000, max: 8000 },
};

module.exports = {
  INSTAGRAM_DEBUG_RUN_ID,
  IG_SELECTORS,
  IG_DELAYS,
};
