/**
 * LinkedIn Detection Helpers
 * Functions for detecting Premium-required blocks, messaging-blocked states,
 * and action warnings (rate-limit / error banners) on LinkedIn pages.
 * Extracted from the original linkedin.js for maintainability.
 */

const { humanDelay } = require("../browserBase");
const { firstVisible, firstVisibleOnProfile } = require("./profileActions");
const { dismissPremiumDialog } = require("./messagingFrame");

async function detectPremiumRequired(page, { dismissIfFound = true } = {}) {
  // Do not search the entire page for the word "Premium". LinkedIn renders
  // upgrades in navigation and sidebars even when a normal DM composer is
  // open; treating that text as a block was causing false premium skips.
  // This exact message is rendered by LinkedIn's current interop modal (as
  // captured in the Grace Kimanthi run). Playwright locators pierce LinkedIn's
  // open shadow root, unlike document.querySelector()/innerText.
  const explicitPremiumMessage = page
    .getByText(/with premium, you can message anyone/i)
    .first();
  const hasExplicitPremiumMessage = await explicitPremiumMessage
    .isVisible({ timeout: 120 })
    .catch(() => false);

  const token = `gtss-premium-block-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const premiumSelector = await page
    .evaluate((marker) => {
      const containers = document.querySelectorAll(
        '#interop-outlet, [data-testid="interop-shadowdom"], [role="dialog"], .artdeco-modal',
      );
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 160 && rect.height > 80 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      for (const container of containers) {
        if (!visible(container)) continue;
        const text = String(container.innerText || container.textContent || '')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase();
        const isMessagingPremiumBlock =
          text.includes('with premium, you can message anyone') ||
          text.includes('grow your business with premium') ||
          text.includes('inmail credits') ||
          (/\bpremium\b/.test(text) && /\b(message|inmail)\b/.test(text) && /\b(get|try|upgrade|required)\b/.test(text));
        if (!isMessagingPremiumBlock) continue;
        container.setAttribute('data-gtss-premium-block', marker);
        return `[data-gtss-premium-block="${marker}"]`;
      }
      return null;
    }, token)
    .catch(() => null);
  if (!hasExplicitPremiumMessage && !premiumSelector) return null;

  // CRITICAL: dismiss the dialog before returning. The previous comment said
  // "we are navigating away immediately, so there is no point cleaning up" —
  // but the caller does NOT navigate away after premium_required in either
  // runner (executor + dmQueue). The dialog stays open, LinkedIn's React
  // keeps running, and LinkedIn itself then auto-redirects the tab (or spawns
  // a new tab) to a /talent/job-posting-redirect/ upsell page — this is the
  // source of the "two tabs active, one is /job-posting" symptom.
  if (dismissIfFound) {
    await dismissPremiumDialog(page, 1200);
  }

  return {
    outcome: "premium_required",
    reason: "LinkedIn Premium required to message this profile",
  };
}

async function detectMessagingBlocked(page, timeout = 700) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const premium = await detectPremiumRequired(page);
    if (premium) return premium;

    await humanDelay(80, 130);
  }

  return null;
}

async function isAnyVisible(page, selectors) {
  const match = await firstVisible(page, selectors, 500);
  return Boolean(match);
}

async function isAnyVisibleOnProfile(page, selectors) {
  const match = await firstVisibleOnProfile(page, selectors, 500);
  return Boolean(match);
}

async function pageContainsAny(page, phrases) {
  const text = await page
    .locator("body")
    .innerText({ timeout: 2000 })
    .catch(() => "");
  const normalized = text.toLowerCase();
  return (
    phrases.find((phrase) => normalized.includes(phrase.toLowerCase())) || null
  );
}

async function detectActionWarning(page) {
  return pageContainsAny(page, [
    "try again later",
    "weekly invitation limit",
    "you’ve reached the weekly invitation limit",
    "you've reached the weekly invitation limit",
    "something went wrong",
    "unable to send",
    "could not send",
    "add their email",
  ]);
}

module.exports = {
  detectPremiumRequired,
  detectMessagingBlocked,
  isAnyVisible,
  isAnyVisibleOnProfile,
  pageContainsAny,
  detectActionWarning,
};
