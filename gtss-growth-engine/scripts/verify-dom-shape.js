/**
 * verify-dom-shape.js — Sanity-check that tiktokSearch.js selectors match
 * the real TikTok search DOM captured in people.html / usersresult.html.
 *
 * Self-contained (does NOT require tiktokSearch.js, which would pull in the
 * full browserBase → database chain). Inlines the selector strings so this
 * can run in a bare checkout without node_modules installed.
 *
 * Run: node scripts/verify-dom-shape.js [path-to-html]
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

// Look for the captured TikTok search DOM in a few sensible locations:
// project root, engine root, or alongside this script. Accepts both
// people.html (legacy name) and usersresult.html (current name).
// The user can also pass an absolute path as the first CLI argument.
const candidateFilenames = ["people.html", "usersresult.html"];
const candidatePaths = [
  process.argv[2],
  ...candidateFilenames.flatMap((f) => [
    path.resolve(__dirname, "../../", f),
    path.resolve(__dirname, "../", f),
    path.resolve(__dirname, f),
  ]),
].filter(Boolean);
const htmlPath = candidatePaths.find((p) => fs.existsSync(p));
if (!htmlPath) {
  console.error("TikTok search DOM export not found. Checked:");
  candidatePaths.forEach((p) => p && console.error(`  - ${p}`));
  console.error("\nCopy the TikTok search DOM export to one of these paths, or pass its location as the first CLI argument:");
  console.error("  node scripts/verify-dom-shape.js /path/to/usersresult.html");
  process.exit(1);
}
console.log(`Using DOM export at: ${htmlPath}\n`);
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

// 3. Confirm the card-container shape: each anchor should contain a
//    div[data-fmp="true"] (the canonical card container). This catches
//    the ancestor:: vs descendant:: bug we just fixed in tiktokSearch.js
//    — if TikTok ever moves the data-fmp div OUTSIDE the anchor, our
//    scoping logic breaks.
const anchorWithFmpRe = /<a[^>]*class="link-a11y-focus"[^>]*href="\/@[^"]+"[^>]*>[\s\S]*?<div[^>]*data-fmp="true"/g;
const anchorsWithFmp = (html.match(anchorWithFmpRe) || []).length;
console.log(`\nCard-container shape check:`);
console.log(`  Anchors with div[data-fmp="true"] as a descendant: ${anchorsWithFmp}/${usernames.length}`);
if (anchorsWithFmp === usernames.length && usernames.length > 0) {
  console.log(`  ✓ div[data-fmp="true"] is a descendant of every anchor (descendant:: selector is correct)`);
} else if (anchorsWithFmp === 0 && usernames.length > 0) {
  console.log(`  ⚠ div[data-fmp="true"] is NOT inside any anchor — selectors may need to flip back to ancestor::`);
} else {
  console.log(`  ⚠ Mixed: some anchors have div[data-fmp] inside, some don't. Selectors may be inconsistent.`);
}

// 4. Confirm the Follow button is INSIDE the anchor (the critical
//    invariant for the click-blocker logic in followUserCard).
const anchorWithButtonRe = /<a[^>]*class="link-a11y-focus"[^>]*href="\/@[^"]+"[^>]*>[\s\S]*?<button[^>]*data-e2e="follow-back"/g;
const anchorsWithButton = (html.match(anchorWithButtonRe) || []).length;
console.log(`\nFollow-button-inside-anchor check:`);
console.log(`  Anchors with button[data-e2e="follow-back"] as a descendant: ${anchorsWithButton}/${usernames.length}`);
if (anchorsWithButton === usernames.length && usernames.length > 0) {
  console.log(`  ✓ Follow button lives INSIDE the anchor — click-blocker (preventDefault on anchor) is required`);
} else {
  console.log(`  ℹ Follow button is not inside every anchor — click-blocker may not be needed for all cards`);
}

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
