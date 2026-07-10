// asset-library.js — Asset Library UI
//
// Supports:
//   - Uploading images and videos
//   - Grouping assets into multi-image posts / carousels
//   - Labeling groups and choosing post type (carousel/video/single)
//   - Per-asset tags, rename, delete
//   - Toggling the content pipeline's asset source (AI vs library)
//
// Refined to match the polished asset-library.html layout: header stats,
// toolbar with primary/secondary actions, hover-to-reveal remove buttons,
// dedicated empty states, and consistent card design.

const assetState = {
  assets: [],
  groups: [],
  settings: {},
  stats: {},
};

async function loadAll() {
  const [assetsRes, groupsRes, settingsRes, statsRes] = await Promise.all([
    window.gtss.fetchJSON("/api/assets"),
    window.gtss.fetchJSON("/api/assets/groups").catch(() => ({ groups: [] })),
    window.gtss.fetchJSON("/api/settings"),
    window.gtss.fetchJSON("/api/assets/stats"),
  ]);
  assetState.assets = assetsRes.assets || [];
  assetState.groups = groupsRes.groups || [];
  assetState.settings = settingsRes || {};
  assetState.stats = statsRes || {};

  document.getElementById("asset-source").value =
    assetState.settings.content_asset_source || "ai";
  document.getElementById("asset-media-type").value =
    assetState.settings.content_library_media_type || "image";

  updateHeaderStats();
  renderGroups();
  renderAssets();
}

function updateHeaderStats() {
  const nextEl = document.getElementById("asset-next");
  const nextHeaderEl = document.getElementById("stat-next");
  const assetsEl = document.getElementById("stat-assets");
  const groupsEl = document.getElementById("stat-groups");

  let nextLabel = "No library assets yet";
  if (assetState.stats.nextGroup) {
    nextLabel = `Next: "${assetState.stats.nextGroup.group.name}" (${assetState.stats.nextGroup.assets.length} asset${assetState.stats.nextGroup.assets.length === 1 ? "" : "s"})`;
  } else if (assetState.stats.next) {
    nextLabel = `Next: ${assetState.stats.next.name}`;
  }

  if (nextEl) nextEl.textContent = nextLabel;
  if (nextHeaderEl) nextHeaderEl.textContent = nextLabel;
  if (assetsEl) assetsEl.textContent = String(assetState.assets.length || 0);
  if (groupsEl) groupsEl.textContent = String(assetState.groups.length || 0);
}

function renderGroups() {
  const container = document.getElementById("groups-list");
  if (!assetState.groups || assetState.groups.length === 0) {
    container.innerHTML = `
      <div class="group-empty">
        <div style="font-size: 13px; color: var(--gtss-text); font-weight: 600; margin-bottom: 4px;">No groups yet</div>
        <div>Create one above to start grouping assets for multi-image posts.</div>
      </div>`;
    return;
  }
  container.innerHTML = assetState.groups
    .map((group) => {
      const assets = group.assets || [];
      const thumbs = assets
        .map(
          (asset, idx) => `
        <div class="group-asset-thumb" data-asset-id="${asset.id}" data-group-id="${group.id}">
          ${asset.media_type === "video"
            ? `<video src="${asset.file_url}" muted></video>`
            : `<img src="${asset.file_url}" alt="">`}
          <span class="pos-badge">#${idx + 1}</span>
          <button class="remove-x" type="button" data-remove-from-group="${asset.id}" data-group-id="${group.id}" title="Remove from group">✕</button>
        </div>`,
        )
        .join("");
      return `
        <article class="group-card" data-group-id="${group.id}">
          <div class="group-header">
            <div>
              <h3>${window.gtss.escapeHtml(group.name)} <span class="group-badge">${group.post_type}</span></h3>
              ${group.label && group.label !== group.name ? `<div class="asset-meta">${window.gtss.escapeHtml(group.label)}</div>` : ""}
              <div class="group-meta-row">
                <span>used ${group.times_used || 0} time${(group.times_used || 0) === 1 ? "" : "s"}</span>
                <span aria-hidden="true">·</span>
                <span>${assets.length} asset${assets.length === 1 ? "" : "s"}</span>
              </div>
            </div>
            <div class="group-actions">
              <button type="button" data-rename-group="${group.id}">Rename</button>
              <button type="button" data-delete-group="${group.id}">Delete group</button>
            </div>
          </div>
          <div class="group-assets">${thumbs || '<div class="group-empty">No assets in this group yet. Use the dropdown on each asset below to assign it.</div>'}</div>
        </article>
      `;
    })
    .join("");
}

function renderAssets() {
  const grid = document.getElementById("asset-grid");
  if (!assetState.assets || assetState.assets.length === 0) {
    grid.innerHTML = `
      <div class="asset-empty-state">
        <div class="icon" aria-hidden="true">📁</div>
        <div class="title">No assets uploaded yet</div>
        <div class="desc">Use the upload field above to add images or videos. Uploaded assets will appear here, ready to be grouped for carousels.</div>
      </div>`;
    return;
  }
  // Build a list of group options for the assign dropdown.
  const groupOptions = assetState.groups
    .map((g) => `<option value="${g.id}">${window.gtss.escapeHtml(g.name)}</option>`)
    .join("");
  grid.innerHTML = assetState.assets
    .map((asset) => {
      const media =
        asset.media_type === "video"
          ? `<video src="${asset.file_url}" muted controls></video>`
          : `<img src="${asset.file_url}" alt="">`;
      const groupTag = asset.group_id
        ? `<span class="group-tag">in group #${asset.group_id}</span>`
        : "";
      const currentGroup = asset.group_id ? asset.group_id : "";
      const tags = (asset.tags || [])
        .map((t) => `<span class="asset-tag-pill">${window.gtss.escapeHtml(t)}</span>`)
        .join("");
      const mediaTypeLabel = asset.media_type === "video" ? "Video" : "Image";
      return `
        <article class="asset-card" data-asset-id="${asset.id}">
          <div class="asset-media">${media}</div>
          <strong title="${window.gtss.escapeHtml(asset.name)}">${window.gtss.escapeHtml(asset.name)}</strong>
          <div class="asset-meta-row">
            <span class="asset-meta">${mediaTypeLabel}</span>
            <span aria-hidden="true">·</span>
            <span class="asset-meta">used ${asset.times_used || 0}×</span>
            ${groupTag}
          </div>
          <div class="asset-meta-row">${tags || '<span class="asset-meta">no tags</span>'}</div>
          <div class="asset-actions">
            <select class="assign-select" data-assign-asset="${asset.id}">
              <option value="">— assign to group —</option>
              ${assetState.groups
                .map((g) => `<option value="${g.id}"${String(g.id) === String(currentGroup) ? " selected" : ""}>${window.gtss.escapeHtml(g.name)}</option>`)
                .join("")}
            </select>
          </div>
          <div class="asset-actions">
            <button type="button" data-rename-asset="${asset.id}">Rename</button>
            <button type="button" data-delete-asset="${asset.id}">Delete</button>
          </div>
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
  loadAll();
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

async function createGroup() {
  const name = document.getElementById("new-group-name").value.trim();
  const label = document.getElementById("new-group-label").value.trim();
  const postType = document.getElementById("new-group-type").value;
  if (!name) return window.gtss.showToast("Enter a group name", "warning");
  await window.gtss.fetchJSON("/api/assets/groups", {
    method: "POST",
    body: JSON.stringify({ name, label: label || name, post_type: postType }),
  });
  window.gtss.showToast(`Group "${name}" created`, "success");
  document.getElementById("new-group-name").value = "";
  document.getElementById("new-group-label").value = "";
  loadAll();
}

async function assignAssetToGroup(assetId, groupId) {
  // Pull the current group's asset list, append the new asset, and re-PUT
  // the full ordered list so positions stay consistent.
  const group = assetState.groups.find((g) => String(g.id) === String(groupId));
  if (!group) return;
  const existing = (group.assets || []).map((a) => a.id);
  if (!existing.includes(Number(assetId))) existing.push(Number(assetId));
  await window.gtss.fetchJSON(`/api/assets/groups/${groupId}/assets`, {
    method: "POST",
    body: JSON.stringify({ assetIds: existing }),
  });
  window.gtss.showToast("Asset added to group", "success");
  loadAll();
}

async function removeFromGroup(assetId, groupId) {
  const group = assetState.groups.find((g) => String(g.id) === String(groupId));
  if (!group) return;
  const remaining = (group.assets || [])
    .map((a) => a.id)
    .filter((id) => id !== Number(assetId));
  await window.gtss.fetchJSON(`/api/assets/groups/${groupId}/assets`, {
    method: "POST",
    body: JSON.stringify({ assetIds: remaining }),
  });
  window.gtss.showToast("Removed from group", "info");
  loadAll();
}

async function renameGroup(groupId) {
  const group = assetState.groups.find((g) => String(g.id) === String(groupId));
  if (!group) return;
  const name = prompt("New group name:", group.name);
  if (name === null) return;
  const label = prompt("New label (optional):", group.label || group.name);
  await window.gtss.fetchJSON(`/api/assets/groups/${groupId}`, {
    method: "PATCH",
    body: JSON.stringify({
      name: name.trim() || group.name,
      label: (label || name).trim(),
    }),
  });
  loadAll();
}

async function deleteGroup(groupId) {
  const group = assetState.groups.find((g) => String(g.id) === String(groupId));
  if (!group) return;
  if (!confirm(`Delete group "${group.name}"?\n\nThe assets themselves will NOT be deleted — they will just be ungrouped.`)) return;
  await window.gtss.fetchJSON(`/api/assets/groups/${groupId}`, { method: "DELETE" });
  window.gtss.showToast("Group deleted", "info");
  loadAll();
}

async function renameAsset(assetId) {
  const asset = assetState.assets.find((a) => String(a.id) === String(assetId));
  if (!asset) return;
  const name = prompt("New asset name:", asset.name);
  if (name === null) return;
  await window.gtss.fetchJSON(`/api/assets/${assetId}`, {
    method: "PATCH",
    body: JSON.stringify({ name: name.trim() }),
  });
  loadAll();
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("asset-upload-form").addEventListener("submit", uploadAssets);
  document.getElementById("save-asset-settings").addEventListener("click", saveAssetSettings);
  document.getElementById("create-group-btn").addEventListener("click", createGroup);

  document.addEventListener("click", async (event) => {
    const deleteBtn = event.target.closest("[data-delete-asset]");
    if (deleteBtn) {
      await window.gtss.fetchJSON(`/api/assets/${deleteBtn.dataset.deleteAsset}`, { method: "DELETE" });
      loadAll();
      return;
    }
    const renameAssetBtn = event.target.closest("[data-rename-asset]");
    if (renameAssetBtn) {
      renameAsset(renameAssetBtn.dataset.renameAsset);
      return;
    }
    const renameGroupBtn = event.target.closest("[data-rename-group]");
    if (renameGroupBtn) {
      renameGroup(renameGroupBtn.dataset.renameGroup);
      return;
    }
    const deleteGroupBtn = event.target.closest("[data-delete-group]");
    if (deleteGroupBtn) {
      deleteGroup(deleteGroupBtn.dataset.deleteGroup);
      return;
    }
    const removeFromGroupBtn = event.target.closest("[data-remove-from-group]");
    if (removeFromGroupBtn) {
      removeFromGroup(removeFromGroupBtn.dataset.removeFromGroup, removeFromGroupBtn.dataset.groupId);
      return;
    }
  });

  document.addEventListener("change", async (event) => {
    const assignSelect = event.target.closest("[data-assign-asset]");
    if (!assignSelect) return;
    const assetId = assignSelect.dataset.assignAsset;
    const groupId = assignSelect.value;
    if (!groupId) {
      // Unassign: post empty assetIds list to the previous group, then null-out via PATCH.
      const asset = assetState.assets.find((a) => String(a.id) === String(assetId));
      if (asset && asset.group_id) {
        const group = assetState.groups.find((g) => String(g.id) === String(asset.group_id));
        if (group) {
          const remaining = (group.assets || []).map((a) => a.id).filter((id) => id !== Number(assetId));
          await window.gtss.fetchJSON(`/api/assets/groups/${group.id}/assets`, {
            method: "POST",
            body: JSON.stringify({ assetIds: remaining }),
          });
        }
      }
      // Also explicitly null out group_id on the asset row.
      await window.gtss.fetchJSON(`/api/assets/${assetId}`, {
        method: "PATCH",
        body: JSON.stringify({ group_id: 0, position: 0 }),
      });
      window.gtss.showToast("Removed from group", "info");
      loadAll();
      return;
    }
    assignAssetToGroup(assetId, groupId);
  });

  loadAll().catch((error) => window.gtss.showToast(error.message, "error"));
});
