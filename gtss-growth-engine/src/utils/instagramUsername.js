const INSTAGRAM_RESERVED_PATHS = new Set([
  "about",
  "accounts",
  "developer",
  "direct",
  "emails",
  "explore",
  "p",
  "reel",
  "reels",
  "stories",
  "tv",
]);

function normalizeInstagramUsername(value) {
  return String(value || "")
    .trim()
    .replace(/^@+/, "")
    .toLowerCase();
}

function extractInstagramUsernameFromProfileUrl(profileUrl) {
  if (!profileUrl) return "";

  try {
    const parsed = new URL(
      String(profileUrl).trim(),
      "https://www.instagram.com",
    );
    const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    const isInstagramHost =
      host === "instagram.com" || host.endsWith(".instagram.com");

    if (!isInstagramHost) {
      return "";
    }

    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length === 0) return "";

    const username = normalizeInstagramUsername(segments[0]);
    if (!username || INSTAGRAM_RESERVED_PATHS.has(username)) {
      return "";
    }

    return username;
  } catch (_) {
    return "";
  }
}

function resolveInstagramUsername(lead = {}) {
  const directUsername = normalizeInstagramUsername(lead.ig_username);
  if (directUsername) {
    return directUsername;
  }

  const profileUsername = extractInstagramUsernameFromProfileUrl(
    lead.profile_url,
  );
  if (profileUsername) {
    return profileUsername;
  }

  return normalizeInstagramUsername(lead.x_handle);
}

module.exports = {
  normalizeInstagramUsername,
  extractInstagramUsernameFromProfileUrl,
  resolveInstagramUsername,
};
