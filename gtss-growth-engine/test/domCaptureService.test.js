const test = require("node:test");
const assert = require("node:assert/strict");
const { isPlatformPage } = require("../src/services/domCaptureService");

test("DOM recorder only considers pages belonging to the selected platform", () => {
  assert.equal(isPlatformPage("https://www.linkedin.com/in/example", "linkedin"), true);
  assert.equal(isPlatformPage("https://x.com/example", "x"), true);
  assert.equal(isPlatformPage("https://mobile.twitter.com/example", "x"), true);
  assert.equal(isPlatformPage("https://www.facebook.com/example", "facebook"), true);
  assert.equal(isPlatformPage("https://www.instagram.com/example", "instagram"), true);
  assert.equal(isPlatformPage("https://notlinkedin.com/in/example", "linkedin"), false);
  assert.equal(isPlatformPage("about:blank", "linkedin"), false);
});
