const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

// Force test database environment
process.env.DB_PATH = "./data/test_instagram_posting.db";
process.env.TEST_SPEEDUP = "true";

// Stub out Playwright base functions on browserBase first
const browserBase = require("../src/automation/browserBase");
browserBase.dailySessionWarmup = async () => {};
browserBase.humanDelay = async () => {};
browserBase.humanTypeText = async () => {};
browserBase.firstVisible = async (page, selectors) => {
  return {
    click: async () => {},
    count: async () => 1,
    isVisible: async () => true,
    waitFor: async () => true
  };
};
browserBase.checkForInstagramBlock = async () => false;
browserBase.humanMouseMove = async () => {};

const { getDb, initializeDatabase } = require("../src/db/database");
const instagram = require("../src/automation/instagram");
const imageValidator = require("../src/utils/imageValidator");
const schedulerService = require("../src/services/schedulerService");
const scheduledPoster = require("../src/jobs/scheduledPoster");

const TEST_DIR = path.resolve(__dirname, "temp-images");

// Setup DB and clean tables before runs
function cleanDb() {
  const db = getDb();
  db.prepare("DELETE FROM posts").run();
}

async function setupTestImages() {
  if (!fs.existsSync(TEST_DIR)) {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  }

  // 1:1 Square (valid for feed)
  await sharpImage(500, 500, "square.jpg");

  // 4:5 Portrait (valid for feed)
  await sharpImage(800, 1000, "portrait.jpg");

  // 1.91:1 Landscape (valid for feed)
  await sharpImage(955, 500, "landscape.jpg");

  // 9:16 Story (valid for story)
  await sharpImage(1080, 1920, "story.jpg");

  // Too narrow (<320px)
  await sharpImage(200, 200, "too-narrow.jpg");

  // Invalid ratio
  await sharpImage(400, 600, "invalid-ratio.jpg");

  // WebP format (invalid)
  await sharpImage(500, 500, "webp-image.webp");
}

async function sharpImage(width, height, filename) {
  const sharp = require("sharp");
  await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 255, g: 0, b: 0 }
    }
  }).toFile(path.join(TEST_DIR, filename));
}

function cleanupTestImages() {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

// Playwright Page Mock Creator
function createMockPage({ url = "https://www.instagram.com/", visibleSelectors = [], fileInputs = {} }) {
  const visible = new Set(visibleSelectors);
  const clicks = [];
  const fills = {};
  let setFilesCalledWith = null;

  return {
    url: () => url,
    goto: async (targetUrl) => {
      url = targetUrl;
    },
    evaluate: async (fn) => {
      return "";
    },
    waitForSelector: async (selector, opts) => {
      return true;
    },
    close: async () => {},
    locator: (selector) => {
      return {
        first: () => ({
          waitFor: async () => true,
          click: async () => {
            clicks.push(selector);
          },
          setInputFiles: async (file) => {
            setFilesCalledWith = file;
          },
          count: async () => 1,
          isVisible: async () => true
        }),
        waitFor: async (opts) => {
          return true;
        },
        click: async () => {
          clicks.push(selector);
        },
        setInputFiles: async (file) => {
          setFilesCalledWith = file;
        },
        count: async () => 1,
        isVisible: async () => true
      };
    },
    getClicks: () => clicks,
    getFills: () => fills,
    getSetFiles: () => setFilesCalledWith
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// TESTS
// ─────────────────────────────────────────────────────────────────────────────

test.before(async () => {
  // Fresh DB Setup
  initializeDatabase();
  cleanDb();
  await setupTestImages();
});

test.after(() => {
  cleanupTestImages();
});

test("validateForFeed correctly qualifies and rejects formats, sizes, and ratios", async () => {
  // Valid Square
  const resSquare = await imageValidator.validateForFeed(path.join(TEST_DIR, "square.jpg"));
  assert.equal(resSquare.valid, true);
  assert.equal(resSquare.aspectRatio, "square");

  // Valid Portrait
  const resPortrait = await imageValidator.validateForFeed(path.join(TEST_DIR, "portrait.jpg"));
  assert.equal(resPortrait.valid, true);
  assert.equal(resPortrait.aspectRatio, "portrait");

  // Valid Landscape
  const resLandscape = await imageValidator.validateForFeed(path.join(TEST_DIR, "landscape.jpg"));
  assert.equal(resLandscape.valid, true);
  assert.equal(resLandscape.aspectRatio, "landscape");

  // Too narrow width
  const resNarrow = await imageValidator.validateForFeed(path.join(TEST_DIR, "too-narrow.jpg"));
  assert.equal(resNarrow.valid, false);
  assert.match(resNarrow.errors[0], /width/);

  // Invalid ratio
  const resRatio = await imageValidator.validateForFeed(path.join(TEST_DIR, "invalid-ratio.jpg"));
  assert.equal(resRatio.valid, false);
  assert.match(resRatio.errors[0], /aspect ratio/);

  // Invalid format (WebP)
  const resFormat = await imageValidator.validateForFeed(path.join(TEST_DIR, "webp-image.webp"));
  assert.equal(resFormat.valid, false);
  assert.match(resFormat.errors[0], /format/);
});

test("validateForStory correctly qualifies 9:16 and rejects 1:1", async () => {
  // Valid 9:16 story
  const resStory = await imageValidator.validateForStory(path.join(TEST_DIR, "story.jpg"));
  assert.equal(resStory.valid, true);

  // 1:1 fails story aspect ratio
  const resSquare = await imageValidator.validateForStory(path.join(TEST_DIR, "square.jpg"));
  assert.equal(resSquare.valid, false);
  assert.match(resSquare.errors[0], /aspect ratio/i);
});

test("prepareForFeed converts 9:16 story media into a valid feed image", async () => {
  const sourcePath = path.join(TEST_DIR, "story.jpg");
  const prepared = await imageValidator.prepareForFeed(sourcePath);

  assert.equal(prepared.valid, true);
  assert.equal(prepared.changed, true);
  assert.match(prepared.filePath, /ig-feed-portrait\.jpg$/);

  const finalValidation = await imageValidator.validateForFeed(prepared.filePath);
  assert.equal(finalValidation.valid, true);
  assert.equal(finalValidation.aspectRatio, "portrait");
});

test("postImage successfully executes entire crop -> filter -> caption -> share sequence", async () => {
  cleanDb();
  const db = getDb();
  
  // Seed the posts table so that the post row is matched
  db.prepare(
    "INSERT INTO posts (platforms, body, media_path, status) VALUES (?, ?, ?, ?)"
  ).run(JSON.stringify(["instagram"]), "Check this out #growth", path.join(TEST_DIR, "square.jpg"), "scheduled");
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)"
  ).run("ig_blocked_until", new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString());

  const page = createMockPage({
    url: "https://www.instagram.com/",
    visibleSelectors: [
      'svg[aria-label="New post"]',
      'div[role="textbox"][contenteditable="true"]',
      'button:has-text("Share")'
    ]
  });

  const emitter = {
    events: [],
    emit: (event, payload) => {
      emitter.events.push(payload);
    }
  };

  const result = await instagram.postImage(
    page,
    {
      imagePath: path.join(TEST_DIR, "square.jpg"),
      caption: "Check this out #growth",
      locationTag: "Nairobi"
    },
    emitter
  );

  if (!result.success) {
    console.error("postImage failed in test with error:", result.error);
  }
  assert.equal(result.success, true);
  assert.match(result.postUrl, /instagram.com\/p\//);

  // Confirm DB update
  const post = db.prepare("SELECT * FROM posts ORDER BY id DESC LIMIT 1").get();
  assert.equal(post.status, "published");
  assert.equal(post.ig_post_url, result.postUrl);

  // Assert events emitted properly
  const doneEvent = emitter.events.find(e => e.type === "done");
  assert.ok(doneEvent);
  assert.match(doneEvent.message, /published/);
});

test("postImage prepares story-ratio media instead of failing feed validation", async () => {
  cleanDb();
  const db = getDb();

  db.prepare(
    "INSERT INTO posts (platforms, body, media_path, status, ig_post_type) VALUES (?, ?, ?, ?, ?)"
  ).run(JSON.stringify(["instagram"]), "Story-shaped feed", path.join(TEST_DIR, "story.jpg"), "scheduled", "feed");

  const page = createMockPage({
    url: "https://www.instagram.com/",
    visibleSelectors: [
      'svg[aria-label="New post"]',
      'div[role="textbox"][contenteditable="true"]',
      'button:has-text("Share")'
    ]
  });

  const result = await instagram.postImage(
    page,
    {
      imagePath: path.join(TEST_DIR, "story.jpg"),
      caption: "Story-shaped feed"
    },
    { emit: () => {} }
  );

  assert.equal(result.success, true);
  assert.match(page.getSetFiles(), /ig-feed-portrait\.jpg$/);
});

test("postStory successfully performs avatar click or direct navigation, upload, and story share", async () => {
  cleanDb();
  const db = getDb();

  db.prepare(
    "INSERT INTO posts (platforms, body, media_path, status, ig_post_type) VALUES (?, ?, ?, ?, ?)"
  ).run(JSON.stringify(["instagram"]), "", path.join(TEST_DIR, "story.jpg"), "scheduled", "story");

  const page = createMockPage({
    url: "https://www.instagram.com/",
    visibleSelectors: [
      'section > div > div button:has(img[alt*="profile"]):first-child'
    ]
  });

  const emitter = {
    events: [],
    emit: (event, payload) => {
      emitter.events.push(payload);
    }
  };

  const result = await instagram.postStory(
    page,
    {
      imagePath: path.join(TEST_DIR, "story.jpg")
    },
    emitter
  );

  assert.equal(result.success, true);

  // Check DB state
  const post = db.prepare("SELECT * FROM posts ORDER BY id DESC LIMIT 1").get();
  assert.equal(post.status, "published");
  assert.equal(post.ig_post_type, "story");
  assert.ok(post.ig_story_expires_at);
});

test("scheduledPoster postToInstagram dispatches story and feed types correctly", async () => {
  cleanDb();
  const db = getDb();

  // Create post object
  const postObj = {
    id: 1,
    media_path: path.join(TEST_DIR, "square.jpg"),
    body: "Test Feed",
    location_tag: "Mombasa",
    ig_post_type: "feed"
  };

  // Mock Playwright Browser and Context
  const mockPage = createMockPage({
    url: "https://www.instagram.com/",
    visibleSelectors: [
      'svg[aria-label="New post"]',
      'div[role="textbox"][contenteditable="true"]',
      'button:has-text("Share")'
    ]
  });

  const mockContext = {
    newPage: async () => mockPage,
    close: async () => {}
  };

  const mockBrowser = {
    newContext: async () => mockContext,
    close: async () => {}
  };

  const emitter = {
    events: [],
    emit: (event, payload) => {
      emitter.events.push(payload);
    }
  };

  // Seed DB so loadedPost works
  db.prepare(
    "INSERT INTO posts (id, platforms, body, media_path, status, ig_post_type) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(1, JSON.stringify(["instagram"]), "Test Feed", path.join(TEST_DIR, "square.jpg"), "scheduled", "feed");

  const result = await scheduledPoster.postToInstagram(postObj, mockBrowser, emitter);
  assert.equal(result.success, true);
});
