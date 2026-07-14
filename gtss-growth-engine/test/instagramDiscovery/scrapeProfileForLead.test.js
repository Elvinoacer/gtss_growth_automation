/**
 * scrapeProfileForLead tests — single-profile metadata scraper.
 *
 * Verifies the scraper extracts display name, verified badge, bio, website,
 * email, phone, business category, and last post date — and that it clicks
 * the first grid post then closes the modal.
 */

const assert = require("node:assert/strict");
const test = require("node:test");

const { scrapeProfileForLead, createMockPage } = require("./_helpers");

test("scrapeProfileForLead scrapes all metadata fields and clicks first post", async () => {
  const mockPage = createMockPage({
    url: "https://www.instagram.com/business_user/",
    visibleSelectors: [
      "header section h1",
      'span[title="Verified"]',
      "header section span", // bio selector
      'header a[href*="l.instagram.com"]',
      'a[href^="mailto:"]',
      'a[href^="tel:"]',
      'header section div[class*="category"]',
      'article a[href*="/p/"]',
      "time[datetime]",
      'svg[aria-label="Close"]',
    ],
    textOverrides: {
      "header section h1": "The Nairobi Cafe",
      "header section span": "Best restaurant grill in Nairobi",
      'header section div[class*="category"]': "Restaurant & Grill",
    },
  });

  const lead = await scrapeProfileForLead(mockPage, "business_user");
  assert.ok(lead);
  assert.equal(lead.username, "business_user");
  assert.equal(lead.display_name, "The Nairobi Cafe");
  assert.equal(lead.is_verified, true);
  assert.equal(lead.bio, "Best restaurant grill in Nairobi");
  assert.equal(lead.website, "https://example.com");
  assert.equal(lead.email, "business@example.com");
  assert.equal(lead.phone, "+254700000000");
  assert.equal(lead.is_business, true);
  assert.equal(lead.business_category, "Restaurant & Grill");
  assert.equal(lead.last_post_date, "2026-05-17T20:00:00.000Z");

  // Verified clicks: opened first grid post and closed it
  assert.ok(mockPage.clicks.includes('article a[href*="/p/"]'));
  assert.ok(mockPage.clicks.includes('svg[aria-label="Close"]'));
});
