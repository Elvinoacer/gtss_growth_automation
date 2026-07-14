function formatPlatformLabel(platform) {
  const key = String(platform || "")
    .trim()
    .toLowerCase();
  if (!key) return "";
  if (key === "linkedin") return "LinkedIn";
  if (key === "x") return "X";
  if (key === "instagram") return "Instagram";
  if (key === "facebook") return "Facebook";

  return key
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

async function loadPlatformCatalog() {
  try {
    const data = await fetchJSON("/api/platforms");
    return Array.isArray(data.platforms) ? data.platforms : [];
  } catch (error) {
    return [];
  }
}
