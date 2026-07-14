/**
 * parseIgCount tests — Instagram count-string parser (K/M suffix, commas, etc.).
 */

const assert = require("node:assert/strict");
const test = require("node:test");

const { parseIgCount } = require("./_helpers");

test("parseIgCount parses standard metrics and handles K/M suffixes", () => {
  assert.equal(parseIgCount("2.3K"), 2300);
  assert.equal(parseIgCount("1.2M"), 1200000);
  assert.equal(parseIgCount("150"), 150);
  assert.equal(parseIgCount("2,500"), 2500);
  assert.equal(parseIgCount("  10.5k  "), 10500);
  assert.equal(parseIgCount(null), 0);
  assert.equal(parseIgCount(500), 500);
});
