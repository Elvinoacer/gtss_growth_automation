const assert = require("node:assert/strict");
const test = require("node:test");

const { isManualAuthComplete } = require("../src/automation/executor");

function mockPage(url) {
  return {
    url: () => url,
  };
}

test("manual auth detection accepts post-login Facebook and Instagram urls", () => {
  assert.equal(
    isManualAuthComplete(mockPage("https://www.facebook.com/"), "facebook"),
    true,
  );
  assert.equal(
    isManualAuthComplete(
      mockPage("https://www.facebook.com/profile.php"),
      "facebook",
    ),
    true,
  );
  assert.equal(
    isManualAuthComplete(
      mockPage("https://www.facebook.com/login"),
      "facebook",
    ),
    false,
  );

  assert.equal(
    isManualAuthComplete(mockPage("https://www.instagram.com/"), "instagram"),
    true,
  );
  assert.equal(
    isManualAuthComplete(
      mockPage("https://www.instagram.com/accounts/login/"),
      "instagram",
    ),
    false,
  );
});

test("manual auth detection accepts Gemini/Google post-login urls", () => {
  // When the Google sign-in flow completes, the browser lands on
  // gemini.google.com — that's the success signal for both the "google"
  // and "gemini" platform keys.
  assert.equal(
    isManualAuthComplete(
      mockPage("https://gemini.google.com/app"),
      "google",
    ),
    true,
  );
  assert.equal(
    isManualAuthComplete(
      mockPage("https://gemini.google.com/"),
      "gemini",
    ),
    true,
  );

  // While the Google sign-in flow is in progress, the URL stays under
  // accounts.google.com — that's NOT yet authenticated.
  assert.equal(
    isManualAuthComplete(
      mockPage("https://accounts.google.com/signin/v2/identifier"),
      "google",
    ),
    false,
  );
  assert.equal(
    isManualAuthComplete(
      mockPage("https://accounts.google.com/serviceLogin"),
      "gemini",
    ),
    false,
  );
});

test("manual auth detection accepts LinkedIn and X post-login urls", () => {
  // LinkedIn: /feed is the authenticated home page.
  assert.equal(
    isManualAuthComplete(mockPage("https://www.linkedin.com/feed/"), "linkedin"),
    true,
  );
  assert.equal(
    isManualAuthComplete(mockPage("https://www.linkedin.com/login"), "linkedin"),
    false,
  );

  // X: /home is the authenticated timeline.
  assert.equal(
    isManualAuthComplete(mockPage("https://x.com/home"), "x"),
    true,
  );
  assert.equal(
    isManualAuthComplete(mockPage("https://x.com/i/flow/login"), "x"),
    false,
  );
});
