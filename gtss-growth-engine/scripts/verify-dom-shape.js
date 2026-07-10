/**
 * verify-dom-shape.js — Sanity-check that tiktokSearch.js selectors match
 * the real TikTok search DOM captured in people.html.
 *
 * Self-contained (does NOT require tiktokSearch.js, which would pull in the
 * full browserBase → database chain). Inlines the selector strings so this
 * can run in a bare checkout without node_modules installed.
 *
 * Run: node scripts/verify-dom-shape.js
 */
const fs = require("fs");
const path = require("path");

// Inlined from tiktokSearch.js — kept in sync manually.
const SELECTORS = {
  userCardLink: [
    'a.link-a11y-focus[href^="/@"]',
    'a[href^="/@"][class*="link"]',
  ],
  followButton: [
    'button[data-e2e="follow-back"]',
    'button[data-testid="tux-web-button"][data-e2e="follow-back"]',
  ],
};

// Look for people.html in a few sensible locations: project root, engine
// root, or alongside this script. The user can also pass an absolute path
// as the first CLI argument.
const candidatePaths = [
  process.argv[2],
  path.resolve(__dirname, "../../people.html"),
  path.resolve(__dirname, "../people.html"),
  path.resolve(__dirname, "people.html"),
].filter(Boolean);
const htmlPath = candidatePaths.find((p) => fs.existsSync(p));
if (!htmlPath) {
  console.error("people.html not found. Checked:");
  candidatePaths.forEach((p) => console.error(`  - ${p}`));
  console.error("\nCopy the TikTok search DOM export to one of these paths, or pass its location as the first CLI argument:");
  console.error("  node scripts/verify-dom-shape.js /path/to/people.html");
  process.exit(1);
}
console.log(`Using people.html at: ${htmlPath}\n`);
const html = fs.readFileSync(htmlPath, "utf8");

// 1. Count user-card anchors (href="/@<username>").
const anchorRe = /<a[^>]*href="\/@([^"?#\/]+)"[^>]*>/g;
const usernames = [];
let m;
while ((m = anchorRe.exec(html)) !== null) {
  usernames.push(m[1]);
}
console.log(`Found ${usernames.length} user-card anchors:`);
usernames.forEach((u, i) => console.log(`  ${i + 1}. @${u}`));

// 2. Count follow-back buttons + their labels.
const followBtnRe = /<button[^>]*data-e2e="follow-back"[^>]*>[\s\S]*?<div[^>]*>\s*(Follow|Following|Requested|Pending)\s*<\/div>/g;
const buttonLabels = [];
while ((m = followBtnRe.exec(html)) !== null) {
  buttonLabels.push(m[1]);
}
console.log(`\nFound ${buttonLabels.length} follow-back buttons:`);
const labelCounts = {};
buttonLabels.forEach((l) => { labelCounts[l] = (labelCounts[l] || 0) + 1; });
Object.entries(labelCounts).forEach(([l, c]) => console.log(`  ${l}: ${c}`));

console.log("\nSelector verification:");
console.log(`  userCardLink[0]: ${SELECTORS.userCardLink[0]}`);
console.log(`  → matches anchors with href="/@...": ${usernames.length > 0 ? "YES" : "NO"}`);
console.log(`  followButton[0]: ${SELECTORS.followButton[0]}`);
console.log(`  → matches buttons with data-e2e="follow-back": ${buttonLabels.length > 0 ? "YES" : "NO"}`);

if (usernames.length === buttonLabels.length) {
  console.log(`\n✓ Card count matches button count (${usernames.length} cards, ${buttonLabels.length} buttons)`);
} else {
  console.log(`\n⚠ Card count (${usernames.length}) ≠ button count (${buttonLabels.length}) — some cards may lack buttons`);
}

console.log("\nDOM shape verification complete.");
