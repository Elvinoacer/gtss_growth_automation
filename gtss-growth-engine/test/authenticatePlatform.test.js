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
