/**
 * postCarousel tests.
 *
 * Verifies:
 *  - happy-path carousel post (2 images + caption + location tag) — toast
 *    verification path
 *  - validation failure on non-existent image path
 *  - fallback to profile-page verification when the success toast is missing
 *
 * Uses sharp to generate disposable test PNGs in the test directory.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { getDb, instagram, createMockPage } = require("./_helpers");

test("postCarousel executes successfully and updates DB", async () => {
  const db = getDb();
  db.prepare("DELETE FROM posts").run();

  const sharp = require("sharp");
  const testImg1 = path.join(__dirname, "test_img1.png");
  const testImg2 = path.join(__dirname, "test_img2.png");

  // Create dummy test images
  await sharp({
    create: {
      width: 500,
      height: 500,
      channels: 3,
      background: { r: 255, g: 0, b: 0 },
    },
  })
    .png()
    .toFile(testImg1);

  await sharp({
    create: {
      width: 500,
      height: 500,
      channels: 3,
      background: { r: 0, g: 255, b: 0 },
    },
  })
    .png()
    .toFile(testImg2);

  // Insert mock post
  const mockPostId = db
    .prepare(
      `
    INSERT INTO posts (platforms, body, media_paths, ig_post_type, status)
    VALUES ('["instagram"]', 'Carousel Caption Test', ?, 'carousel', 'pending')
  `,
    )
    .run(JSON.stringify([testImg1, testImg2])).lastInsertRowid;

  const mockPage = createMockPage({
    url: "https://www.instagram.com/",
    visibleSelectors: [
      'svg[aria-label="Create"]',
      'input[type="file"]',
      'button:has-text("Next")',
      'div[role="textbox"][contenteditable="true"]',
      'button:has-text("Share")',
      '[aria-label*="Post shared"]',
      'span:has-text("Add location")',
      'input[placeholder*="Add location"]',
    ],
    resultsList: ["New York"],
  });

  const result = await instagram.postCarousel(mockPage, {
    imagePaths: [testImg1, testImg2],
    caption: "Carousel Caption Test",
    locationTag: "New York",
  });

  if (!result.success) {
    console.error("DEBUG: postCarousel failed with", result);
  }
  assert.equal(result.success, true);
  assert.match(result.postUrl, /C[a-z0-9]+/);

  // Verify DB state
  const updatedPost = db
    .prepare("SELECT * FROM posts WHERE id = ?")
    .get(mockPostId);
  assert.equal(updatedPost.status, "published");
  assert.ok(updatedPost.published_at);
  assert.equal(updatedPost.ig_post_url, result.postUrl);

  // Clean up
  fs.unlinkSync(testImg1);
  fs.unlinkSync(testImg2);
});

test("postCarousel fails when validation fails on a non-existent image", async () => {
  const mockPage = createMockPage({
    url: "https://www.instagram.com/",
    visibleSelectors: [],
  });

  const result = await instagram.postCarousel(mockPage, {
    imagePaths: ["non_existent_file.png"],
    caption: "Failing test",
  });

  assert.equal(result.success, false);
  assert.match(result.error, /Validation failed/);
});

test("postCarousel falls back to profile page verification when toast not found", async () => {
  const db = getDb();
  db.prepare("DELETE FROM posts").run();

  const sharp = require("sharp");
  const testImg1 = path.join(__dirname, "test_img1.png");

  // Create dummy test image
  await sharp({
    create: {
      width: 500,
      height: 500,
      channels: 3,
      background: { r: 255, g: 0, b: 0 },
    },
  })
    .png()
    .toFile(testImg1);

  // Insert mock post
  const mockPostId = db
    .prepare(
      `
    INSERT INTO posts (platforms, body, media_paths, ig_post_type, status)
    VALUES ('["instagram"]', 'Fallback Caption', ?, 'carousel', 'pending')
  `,
    )
    .run(JSON.stringify([testImg1])).lastInsertRowid;

  const mockPage = createMockPage({
    url: "https://www.instagram.com/",
    visibleSelectors: [
      'svg[aria-label="Create"]',
      'input[type="file"]',
      'button:has-text("Next")',
      'div[role="textbox"][contenteditable="true"]',
      'button:has-text("Share")',
      'a:has(svg[aria-label="Profile"])',
      'article a[href*="/p/"]',
    ],
  });

  const result = await instagram.postCarousel(mockPage, {
    imagePaths: [testImg1],
    caption: "Fallback Caption",
  });

  if (!result.success) {
    console.error("DEBUG: fallback postCarousel failed with", result);
  }
  assert.equal(result.success, true);
  assert.equal(result.postUrl, "https://www.instagram.com/p/Cverification123/");

  const updatedPost = db
    .prepare("SELECT * FROM posts WHERE id = ?")
    .get(mockPostId);
  assert.equal(updatedPost.status, "published");
  assert.equal(
    updatedPost.ig_post_url,
    "https://www.instagram.com/p/Cverification123/",
  );

  // Clean up
  fs.unlinkSync(testImg1);
});
