#!/usr/bin/env node
/**
 * gtss-growth — npm global CLI entry point.
 *
 * This is what gets installed on PATH when a developer runs:
 *
 *     npm install -g gtss-growth-desktop
 *
 * Behaviour:
 *   1. If a native install of GTSS Growth Engine is already present on this
 *      machine, launch it directly.
 *   2. Otherwise, detect the OS and download the appropriate native installer
 *      (.exe / .deb / .rpm / .AppImage / .dmg) from GitHub Releases, then run
 *      it. This is the same hybrid path as install.sh.
 *   3. If GitHub is unreachable, fall back to running the Electron app
 *      directly from this npm package (developer mode — requires the user to
 *      have cloned the repo with the desktop/ source).
 *
 * Non-technical users should NOT use this path. They should use the curl
 * installer (install.sh) or download the native installer directly from the
 * website. This script is primarily for developers.
 */

const { spawn, spawnSync } = require("child_process");
const os = require("os");
const fs = require("fs");
const path = require("path");
const https = require("https");
const { execSync } = require("child_process");

const PACKAGE = require("../package.json");
const VERSION = PACKAGE.version;
// Match the repo configured in install.sh, install.ps1, and
// electron-builder.yml — these were previously hardcoded as "gtss" /
// "growth-automation" which would have pointed at a non-existent repo.
const GITHUB_OWNER = "Elvinoacer";
const GITHUB_REPO = "gtss_growth_automation";

const PLATFORM = process.platform;
const ARCH = process.arch;

// ─── Logging ────────────────────────────────────────────────────────────────

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  red: "\x1b[31m",
};

function log(msg) {
  console.log(`${C.bold}${C.blue}[gtss-growth]${C.reset} ${msg}`);
}
function warn(msg) {
  console.warn(`${C.bold}${C.yellow}[gtss-growth]${C.reset} ${msg}`);
}
function err(msg) {
  console.error(`${C.bold}${C.red}[gtss-growth]${C.reset} ${msg}`);
}
function ok(msg) {
  console.log(`${C.bold}${C.green}[gtss-growth]${C.reset} ${msg}`);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(`${C.bold}GTSS Growth Engine${C.reset} ${C.dim}v${VERSION}${C.reset}\n`);

  // 1. If already installed natively, just launch it.
  const installed = findNativeInstall();
  if (installed) {
    log(`Found existing install at ${installed.path}`);
    await launchNative(installed);
    return;
  }

  // 2. Try to download the native installer from GitHub Releases.
  log("No native install found. Attempting to download from GitHub Releases...");
  const downloaded = await tryDownloadInstaller();
  if (downloaded) {
    log(`Downloaded installer: ${downloaded}`);
    await runInstaller(downloaded);
    return;
  }

  // 3. Fallback: developer mode — run Electron from this package source.
  warn("Could not download a native installer. Falling back to developer mode.");
  await runDevMode();
}

// ─── Native install discovery ──────────────────────────────────────────────

function findNativeInstall() {
  if (PLATFORM === "win32") {
    const candidates = [
      path.join(process.env.PROGRAMFILES || "C:\\Program Files", "GTSS Growth Engine", "GTSS Growth Engine.exe"),
      path.join(process.env.LOCALAPPDATA || "", "Programs", "GTSS Growth Engine", "GTSS Growth Engine.exe"),
    ];
    for (const c of candidates) {
      if (c && fs.existsSync(c)) return { path: c, kind: "exe" };
    }
    return null;
  }
  if (PLATFORM === "darwin") {
    const macPath = "/Applications/GTSS Growth Engine.app";
    if (fs.existsSync(macPath)) return { path: macPath, kind: "app" };
    return null;
  }
  // Linux — check for desktop file and AppImage.
  const desktopFiles = [
    path.join(os.homedir(), ".local", "share", "applications", "gtss-growth-engine.desktop"),
    "/usr/share/applications/gtss-growth-engine.desktop",
  ];
  for (const f of desktopFiles) {
    if (fs.existsSync(f)) {
      const content = fs.readFileSync(f, "utf8");
      const m = /^Exec=(.+)$/m.exec(content);
      if (m) return { path: m[1].trim(), kind: "desktop" };
    }
  }
  // Check for AppImage in common locations.
  const appimageDirs = [path.join(os.homedir(), "Applications"), "/opt", "/usr/local/bin"];
  for (const dir of appimageDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const entries = fs.readdirSync(dir);
      for (const e of entries) {
        if (/GTSS.*\.AppImage$/i.test(e)) {
          return { path: path.join(dir, e), kind: "appimage" };
        }
      }
    } catch (_) {}
  }
  return null;
}

async function launchNative(installed) {
  log(`Launching GTSS Growth Engine...`);
  if (installed.kind === "app") {
    spawn("open", [installed.path], { stdio: "inherit", detached: true });
  } else if (installed.kind === "appimage") {
    spawn(installed.path, [], { stdio: "inherit", detached: true });
  } else {
    spawn(installed.path, [], { stdio: "inherit", detached: true });
  }
  ok("Launched. The desktop app will open in a moment.");
}

// ─── Installer download ────────────────────────────────────────────────────

function pickAsset(assets) {
  const archSuffix = ARCH === "arm64" ? "arm64" : "x64";
  if (PLATFORM === "win32") {
    // Prefer NSIS .exe, fall back to .msi.
    return (
      assets.find((a) => new RegExp(`Setup.*${archSuffix}.*\\.exe$`).test(a.name)) ||
      assets.find((a) => /\.exe$/.test(a.name) && !/blockmap$/.test(a.name)) ||
      assets.find((a) => new RegExp(`${archSuffix}.*\\.msi$`).test(a.name)) ||
      assets.find((a) => /\.msi$/.test(a.name))
    );
  }
  if (PLATFORM === "darwin") {
    return (
      assets.find((a) => new RegExp(`.*${archSuffix}.*\\.dmg$`).test(a.name)) ||
      assets.find((a) => /\.dmg$/.test(a.name))
    );
  }
  // Linux — prefer AppImage (no root needed), then .deb, then .rpm.
  return (
    assets.find((a) => new RegExp(`.*${archSuffix}.*\\.AppImage$`).test(a.name)) ||
    assets.find((a) => /\.AppImage$/.test(a.name)) ||
    assets.find((a) => new RegExp(`.*${archSuffix}.*\\.deb$`).test(a.name)) ||
    assets.find((a) => /\.deb$/.test(a.name)) ||
    assets.find((a) => /\.rpm$/.test(a.name))
  );
}

async function fetchLatestRelease() {
  return new Promise((resolve, reject) => {
    const request = (urlOrOpts) => {
      https
        .get(urlOrOpts, (res) => {
          // Follow redirects by re-entering the same handler (do NOT use
          // arguments.callee — illegal in strict mode / async functions).
          if (
            res.statusCode === 301 ||
            res.statusCode === 302 ||
            res.statusCode === 307 ||
            res.statusCode === 308
          ) {
            if (!res.headers.location) {
              reject(new Error(`GitHub API redirect without Location header (${res.statusCode})`));
              return;
            }
            request(res.headers.location);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`GitHub API returned ${res.statusCode}`));
            return;
          }
          let data = "";
          res.on("data", (b) => (data += b));
          res.on("end", () => {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(e);
            }
          });
        })
        .on("error", reject);
    };

    request({
      hostname: "api.github.com",
      path: `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
      headers: {
        "User-Agent": "gtss-growth-cli",
        Accept: "application/vnd.github+json",
      },
    });
  });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const get = (u) => {
      https.get(u, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          get(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          fs.unlinkSync(dest);
          reject(new Error(`Download failed: ${res.statusCode}`));
          return;
        }
        const total = parseInt(res.headers["content-length"] || "0", 10);
        let received = 0;
        res.on("data", (chunk) => {
          received += chunk.length;
          if (total) {
            const pct = Math.floor((received / total) * 100);
            process.stdout.write(`\r${C.dim}  ${pct}% (${Math.floor(received / 1024 / 1024)}MB / ${Math.floor(total / 1024 / 1024)}MB)${C.reset}`);
          }
        });
        res.pipe(file);
        file.on("finish", () => {
          file.close(() => {
            process.stdout.write("\n");
            resolve(dest);
          });
        });
      }).on("error", reject);
    };
    get(url);
  });
}

async function tryDownloadInstaller() {
  try {
    const release = await fetchLatestRelease();
    if (!release || !release.assets) {
      warn("Latest release has no downloadable assets.");
      return null;
    }
    const asset = pickAsset(release.assets);
    if (!asset) {
      warn(`No installer asset available for ${PLATFORM}/${ARCH}.`);
      return null;
    }
    log(`Downloading ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MB)...`);
    const tmpDir = os.tmpdir();
    const dest = path.join(tmpDir, asset.name);
    await downloadFile(asset.browser_download_url, dest);
    ok(`Downloaded to ${dest}`);
    return dest;
  } catch (e) {
    warn(`Download failed: ${e.message}`);
    return null;
  }
}

async function runInstaller(file) {
  log(`Running installer: ${file}`);
  if (PLATFORM === "win32") {
    spawn(file, ["/S"], { stdio: "inherit", detached: false });
  } else if (PLATFORM === "darwin") {
    spawn("open", [file], { stdio: "inherit", detached: false });
  } else {
    // Linux — make AppImage executable; for .deb / .rpm, prompt sudo.
    if (/\.AppImage$/.test(file)) {
      fs.chmodSync(file, 0o755);
      log("AppImage is ready. Launching...");
      spawn(file, [], { stdio: "inherit", detached: true });
    } else if (/\.deb$/.test(file)) {
      warn("Installing .deb requires sudo. Run:");
      console.log(`  sudo dpkg -i ${file}`);
    } else if (/\.rpm$/.test(file)) {
      warn("Installing .rpm requires sudo. Run:");
      console.log(`  sudo rpm -i ${file}`);
    }
  }
}

// ─── Dev fallback ───────────────────────────────────────────────────────────

async function runDevMode() {
  const desktopDir = path.resolve(__dirname, "..");
  const electronInstalled = fs.existsSync(path.join(desktopDir, "node_modules", ".bin", "electron"));
  if (!electronInstalled) {
    err("Electron is not installed. Run `npm install` inside the desktop/ directory first.");
    process.exit(1);
  }
  log("Starting Electron in dev mode...");
  const electronBin = path.join(desktopDir, "node_modules", ".bin", "electron");
  spawn(electronBin, [desktopDir, "--dev"], { stdio: "inherit", detached: false });
}

// ─── Run ────────────────────────────────────────────────────────────────────

main().catch((e) => {
  err(`Fatal: ${e.message}`);
  process.exit(1);
});
