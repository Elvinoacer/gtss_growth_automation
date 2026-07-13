const { chromium } = require("playwright");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const PLATFORM_DOMAINS = {
  linkedin: ["linkedin.com"],
  x: ["x.com", "twitter.com"],
  facebook: ["facebook.com", "fb.com"],
  instagram: ["instagram.com"],
};

const VALID_PIPELINES = new Set(["discovery", "dm_send", "follow", "dm_check"]);

function capturesDir() {
  return path.resolve(
    process.env.DOM_CAPTURE_DIR || path.join(process.cwd(), "data", "dom-captures"),
  );
}

function cdpEndpoint() {
  return process.env.DOM_CAPTURE_CDP_ENDPOINT || process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";
}

function normalizePlatform(platform) {
  const value = String(platform || "").trim().toLowerCase();
  if (!PLATFORM_DOMAINS[value]) throw new Error("Unsupported platform");
  return value;
}

function normalizePipeline(pipeline) {
  const value = String(pipeline || "").trim().toLowerCase();
  if (!VALID_PIPELINES.has(value)) throw new Error("Unsupported pipeline");
  return value;
}

function isPlatformPage(url, platform) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return PLATFORM_DOMAINS[platform].some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
    );
  } catch (_) {
    return false;
  }
}

async function serializeFrame(frame) {
  return frame.evaluate(() => {
    const documentClone = document.documentElement.cloneNode(true);
    const sourceControls = document.querySelectorAll("input, textarea, select");
    const clonedControls = documentClone.querySelectorAll("input, textarea, select");
    sourceControls.forEach((source, index) => {
      const clone = clonedControls[index];
      if (!clone) return;
      if (source instanceof HTMLInputElement) {
        clone.setAttribute("value", source.type === "password" ? "[REDACTED]" : source.value);
      } else if (source instanceof HTMLTextAreaElement) {
        clone.textContent = source.value;
      } else if (source instanceof HTMLSelectElement) {
        Array.from(clone.options).forEach((option, optionIndex) => {
          option.toggleAttribute("selected", source.options[optionIndex].selected);
        });
      }
    });
    return {
      title: document.title,
      url: location.href,
      readyState: document.readyState,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      dialogCount: document.querySelectorAll('[role="dialog"], dialog').length,
      formCount: document.forms.length,
      editableCount: document.querySelectorAll('[contenteditable="true"], textarea, input:not([type="hidden"])').length,
      html: documentClone.outerHTML,
    };
  });
}

async function getPlatformPages(platform) {
  const normalizedPlatform = normalizePlatform(platform);
  const browser = await chromium.connectOverCDP(cdpEndpoint());
  try {
    const pages = browser.contexts().flatMap((context) => context.pages());
    return pages
      .filter((page) => !page.isClosed() && isPlatformPage(page.url(), normalizedPlatform))
      .map((page, index) => ({
        index,
        url: page.url(),
        title: "",
      }));
  } finally {
    await browser.close();
  }
}

async function captureDom({ platform, pipeline, label, pageIndex = 0 }) {
  const normalizedPlatform = normalizePlatform(platform);
  const normalizedPipeline = normalizePipeline(pipeline);
  const normalizedLabel = String(label || "checkpoint").trim().slice(0, 100) || "checkpoint";
  const selectedIndex = Number(pageIndex);
  if (!Number.isInteger(selectedIndex) || selectedIndex < 0) {
    throw new Error("Invalid browser tab selection");
  }

  const browser = await chromium.connectOverCDP(cdpEndpoint());
  try {
    const pages = browser
      .contexts()
      .flatMap((context) => context.pages())
      .filter((page) => !page.isClosed() && isPlatformPage(page.url(), normalizedPlatform));
    const page = pages[selectedIndex];
    if (!page) throw new Error(`No open ${normalizedPlatform} tab was found at that selection`);

    const capturedAt = new Date().toISOString();
    const captureId = `${capturedAt.replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`;
    const destination = path.join(capturesDir(), normalizedPlatform, normalizedPipeline, captureId);
    await fs.mkdir(destination, { recursive: true });

    const pageDetails = await serializeFrame(page);
    const childFrames = page.frames().filter((frame) => frame !== page.mainFrame());
    const frameDetails = await Promise.all(
      childFrames.map(async (frame, index) => {
        try {
          const details = await serializeFrame(frame);
          return { index, ...details };
        } catch (_) {
          return null;
        }
      }),
    );
    const capturedFrames = frameDetails.filter(Boolean);

    const metadata = {
      captureId,
      capturedAt,
      platform: normalizedPlatform,
      pipeline: normalizedPipeline,
      label: normalizedLabel,
      ...pageDetails,
      html: undefined,
      frames: capturedFrames.map(({ index, title, url, readyState, dialogCount, formCount, editableCount }) => ({
        index,
        title,
        url,
        readyState,
        dialogCount,
        formCount,
        editableCount,
        file: `frames/frame-${index}.html`,
      })),
      files: { dom: "dom.html", metadata: "metadata.json", screenshot: "screenshot.png" },
    };
    await fs.mkdir(path.join(destination, "frames"), { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(destination, "dom.html"), pageDetails.html, "utf8"),
      fs.writeFile(path.join(destination, "metadata.json"), JSON.stringify(metadata, null, 2), "utf8"),
      ...capturedFrames.map((frame) =>
        fs.writeFile(path.join(destination, "frames", `frame-${frame.index}.html`), frame.html, "utf8"),
      ),
      page.screenshot({ path: path.join(destination, "screenshot.png"), fullPage: true }).catch(() => null),
    ]);

    return { ...metadata, path: destination };
  } finally {
    await browser.close();
  }
}

async function listCaptures(limit = 50) {
  const root = capturesDir();
  const results = [];
  try {
    const platforms = await fs.readdir(root, { withFileTypes: true });
    for (const platform of platforms.filter((entry) => entry.isDirectory())) {
      const pipelines = await fs.readdir(path.join(root, platform.name), { withFileTypes: true });
      for (const pipeline of pipelines.filter((entry) => entry.isDirectory())) {
        const captures = await fs.readdir(path.join(root, platform.name, pipeline.name), { withFileTypes: true });
        for (const capture of captures.filter((entry) => entry.isDirectory())) {
          try {
            const metadataPath = path.join(root, platform.name, pipeline.name, capture.name, "metadata.json");
            results.push(JSON.parse(await fs.readFile(metadataPath, "utf8")));
          } catch (_) {
            // A partially written capture is ignored until a later successful capture.
          }
        }
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return results
    .sort((a, b) => String(b.capturedAt).localeCompare(String(a.capturedAt)))
    .slice(0, Math.max(1, Math.min(Number(limit) || 50, 200)));
}

module.exports = { captureDom, getPlatformPages, listCaptures, isPlatformPage };
