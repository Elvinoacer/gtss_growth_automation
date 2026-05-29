const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const FEED_RATIOS = [
  { type: "portrait", ratio: 4 / 5, width: 1080, height: 1350 },
  { type: "square", ratio: 1, width: 1080, height: 1080 },
  { type: "landscape", ratio: 1.91, width: 1080, height: 565 },
];

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".avi",
  ".mkv",
  ".m4v",
]);

function getMediaKind(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  return "unknown";
}

function closestFeedRatio(ratio) {
  return FEED_RATIOS.slice().sort(
    (a, b) =>
      Math.abs(Math.log(ratio / a.ratio)) -
      Math.abs(Math.log(ratio / b.ratio)),
  )[0];
}

function normalizedFeedImagePath(filePath, targetType) {
  const parsed = path.parse(filePath);
  return path.join(
    parsed.dir,
    `${parsed.name}-ig-feed-${targetType || "normalized"}.jpg`,
  );
}

/**
 * Validates an image file for Instagram Feed publishing.
 * @param {string} filePath - Absolute path to the image file
 * @returns {Promise<{ valid: boolean, errors: string[], warnings: string[], aspectRatio: 'square'|'portrait'|'landscape'|null }>}
 */
async function validateForFeed(filePath) {
  const errors = [];
  const warnings = [];

  try {
    if (!fs.existsSync(filePath)) {
      return {
        valid: false,
        errors: ["File does not exist on disk."],
        warnings,
        aspectRatio: null
      };
    }

    const stats = fs.statSync(filePath);
    const fileSizeMB = stats.size / (1024 * 1024);
    if (fileSizeMB >= 8) {
      errors.push(`File size (${fileSizeMB.toFixed(2)}MB) exceeds maximum limit of 8MB.`);
    }

    const metadata = await sharp(filePath).metadata();
    const format = metadata.format;
    if (format !== "jpeg" && format !== "png") {
      errors.push(`Invalid image format: ${format}. Only JPEG and PNG are allowed.`);
    }

    const width = metadata.width;
    const height = metadata.height;
    if (width < 320 || width > 1080) {
      errors.push(`Image width (${width}px) is outside the allowed range of 320px to 1080px.`);
    }

    // Calculate aspect ratio
    const ratio = width / height;

    // Check ratio: must be 1:1 (+-2%), 4:5 (+-2%), or 1.91:1 (+-2%)
    // Square: 1.0. Tolerance 2%: [0.98, 1.02]
    // Portrait: 4/5 = 0.8. Tolerance 2%: [0.784, 0.816]
    // Landscape: 1.91. Tolerance 2%: [1.8718, 1.9482]
    let matchedType = null;
    if (ratio >= 0.98 && ratio <= 1.02) {
      matchedType = "square";
    } else if (ratio >= 0.784 && ratio <= 0.816) {
      matchedType = "portrait";
    } else if (ratio >= 1.8718 && ratio <= 1.9482) {
      matchedType = "landscape";
    } else {
      errors.push(`Invalid aspect ratio: ${ratio.toFixed(4)}. Must be square (1:1), portrait (4:5), or landscape (1.91:1) within 2% tolerance.`);
    }

    const valid = errors.length === 0;
    return {
      valid,
      errors,
      warnings,
      aspectRatio: matchedType
    };
  } catch (err) {
    return {
      valid: false,
      errors: [`Error parsing image: ${err.message}`],
      warnings,
      aspectRatio: null
    };
  }
}

async function prepareForFeed(filePath) {
  if (!fs.existsSync(filePath)) {
    return {
      filePath,
      changed: false,
      valid: false,
      errors: ["File does not exist on disk."],
      warnings: [],
      aspectRatio: null,
    };
  }

  if (getMediaKind(filePath) === "video") {
    return {
      filePath,
      changed: false,
      valid: true,
      errors: [],
      warnings: ["Video feed media bypassed image aspect validation."],
      aspectRatio: "video",
    };
  }

  const initial = await validateForFeed(filePath);
  if (initial.valid) {
    return { filePath, changed: false, ...initial };
  }

  const metadata = await sharp(filePath).metadata();
  const ratio = metadata.width / metadata.height;
  const target = closestFeedRatio(ratio);
  const outputPath = normalizedFeedImagePath(filePath, target.type);

  await sharp(filePath)
    .rotate()
    .flatten({ background: "#ffffff" })
    .resize(target.width, target.height, {
      fit: "contain",
      background: "#ffffff",
      withoutEnlargement: false,
    })
    .jpeg({ quality: 88, mozjpeg: true })
    .toFile(outputPath);

  const finalValidation = await validateForFeed(outputPath);
  return {
    filePath: outputPath,
    changed: true,
    valid: finalValidation.valid,
    errors: finalValidation.errors,
    warnings: [
      `Prepared feed media from ${metadata.width}x${metadata.height} (${ratio.toFixed(4)}) to ${target.width}x${target.height} (${target.type}).`,
      ...finalValidation.warnings,
    ],
    aspectRatio: finalValidation.aspectRatio,
    originalPath: filePath,
  };
}

/**
 * Validates an image file for Instagram Story publishing.
 * @param {string} filePath - Absolute path to the image file
 * @returns {Promise<{ valid: boolean, errors: string[], warnings: string[] }>}
 */
async function validateForStory(filePath) {
  const errors = [];
  const warnings = [];

  try {
    if (!fs.existsSync(filePath)) {
      return {
        valid: false,
        errors: ["File does not exist on disk."],
        warnings
      };
    }

    const stats = fs.statSync(filePath);
    const fileSizeMB = stats.size / (1024 * 1024);
    if (fileSizeMB >= 30) {
      errors.push(`File size (${fileSizeMB.toFixed(2)}MB) exceeds maximum story limit of 30MB.`);
    }

    const metadata = await sharp(filePath).metadata();
    const format = metadata.format;
    if (format !== "jpeg" && format !== "png") {
      errors.push(`Invalid image format: ${format}. Only JPEG and PNG are allowed.`);
    }

    // Check ratio: must be 9:16 (+-3%)
    // 9/16 = 0.5625. Tolerance 3%: [0.5456, 0.5794]
    const ratio = metadata.width / metadata.height;
    if (ratio < 0.5456 || ratio > 0.5794) {
      errors.push(`Story aspect ratio is ${ratio.toFixed(4)}, which deviates from standard 9:16.`);
    }

    const valid = errors.length === 0;
    return {
      valid,
      errors,
      warnings
    };
  } catch (err) {
    return {
      valid: false,
      errors: [`Error parsing story image: ${err.message}`],
      warnings
    };
  }
}

module.exports = {
  validateForFeed,
  validateForStory,
  prepareForFeed,
  getMediaKind,
};
