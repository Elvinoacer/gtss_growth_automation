async function loadAssets() {
  const data = await window.gtss.fetchJSON("/api/assets");
  const stats = await window.gtss.fetchJSON("/api/assets/stats");
  const settings = await window.gtss.fetchJSON("/api/settings");
  document.getElementById("asset-source").value = settings.content_asset_source || "ai";
  document.getElementById("asset-media-type").value = settings.content_library_media_type || "image";
  document.getElementById("asset-next").textContent = stats.next
    ? `Next up: ${stats.next.name}`
    : "No library assets yet";
  renderAssets(data.assets || []);
}

function renderAssets(assets) {
  const grid = document.getElementById("asset-grid");
  if (!assets.length) {
    grid.innerHTML = `<div class="asset-card asset-meta">No assets uploaded.</div>`;
    return;
  }
  grid.innerHTML = assets
    .map((asset) => {
      const media =
        asset.media_type === "video"
          ? `<video src="${asset.file_url}" muted controls></video>`
          : `<img src="${asset.file_url}" alt="">`;
      return `
        <article class="asset-card">
          ${media}
          <strong>${window.gtss.escapeHtml(asset.name)}</strong>
          <span class="asset-meta">${asset.media_type} | used ${asset.times_used || 0} times</span>
          <span class="asset-meta">${(asset.tags || []).map(window.gtss.escapeHtml).join(", ")}</span>
          <button type="button" data-delete-asset="${asset.id}">Delete</button>
        </article>
      `;
    })
    .join("");
}

async function uploadAssets(event) {
  event.preventDefault();
  const files = document.getElementById("asset-files").files;
  if (!files.length) return window.gtss.showToast("Choose at least one file", "warning");
  const form = new FormData();
  [...files].forEach((file) => form.append("assets", file));
  form.append("tags", document.getElementById("asset-tags").value || "");
  await fetch("/api/assets/upload", { method: "POST", body: form }).then(async (res) => {
    if (!res.ok) throw new Error((await res.json()).error || "Upload failed");
  });
  window.gtss.showToast("Assets uploaded", "success");
  document.getElementById("asset-upload-form").reset();
  loadAssets();
}

async function saveAssetSettings() {
  await window.gtss.fetchJSON("/api/settings", {
    method: "PATCH",
    body: JSON.stringify({
      content_asset_source: document.getElementById("asset-source").value,
      content_library_media_type: document.getElementById("asset-media-type").value,
    }),
  });
  window.gtss.showToast("Asset settings saved", "success");
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("asset-upload-form").addEventListener("submit", uploadAssets);
  document.getElementById("save-asset-settings").addEventListener("click", saveAssetSettings);
  document.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-delete-asset]");
    if (!button) return;
    await window.gtss.fetchJSON(`/api/assets/${button.dataset.deleteAsset}`, { method: "DELETE" });
    loadAssets();
  });
  loadAssets().catch((error) => window.gtss.showToast(error.message, "error"));
});
