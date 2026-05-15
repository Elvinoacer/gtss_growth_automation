const { createBrowser, closeBrowser } = require('./browserBase');

async function run() {
  const browserState = await createBrowser('local', {
    headless: true,
    trace: false,
    userDataDir: './profiles/local-check'
  });

  try {
    await browserState.page.goto('http://localhost:3000/login');
  } finally {
    await closeBrowser(browserState.browser, 'local', browserState.context, {
      mode: browserState.mode,
      shouldCloseBrowser: browserState.shouldCloseBrowser,
      lock: browserState.lock
    });
  }
}

module.exports = { run };
