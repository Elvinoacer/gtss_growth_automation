// asset-library.js — Asset Library UI
//
// Supports:
//   - Uploading images and videos
//   - Grouping assets into multi-image posts / carousels
//   - Labeling groups and choosing post type (carousel/video/single)
//   - Per-asset tags, rename, delete
//   - Toggling the content pipeline's asset source (AI vs library)

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

  const nextEl = document.getElementById("asset-next");
  if (assetState.stats.nextGroup) {
    nextEl.textContent = `Next up: group "${assetState.stats.nextGroup.group.name}" (${assetState.stats.nextGroup.assets.length} asset(s))`;
  } else if (assetState.stats.next) {
    nextEl.textContent = `Next up: ${assetState.stats.next.name}`;
  } else {
    nextEl.textContent = "No library assets yet";
  }

  renderGroups();
  renderAssets();
}

function renderGroups() {
  const container = document.getElementById("groups-list");
  if (!assetState.groups || assetState.groups.length === 0) {
    container.innerHTML = `<div class="group-empty">No groups yet. Create one above to start grouping assets for multi-image posts.</div>`;
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
              <div class="asset-meta">used ${group.times_used || 0} time(s) · ${assets.length} asset(s)</div>
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
    grid.innerHTML = `<div class="asset-card asset-meta">No assets uploaded.</div>`;
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
      return `
        <article class="asset-card" data-asset-id="${asset.id}">
          ${media}
          <strong>${window.gtss.escapeHtml(asset.name)}</strong>
          <span class="asset-meta">${asset.media_type} | used ${asset.times_used || 0} times</span>
          <span class="asset-meta">tags: ${(asset.tags || []).map(window.gtss.escapeHtml).join(", ") || "—"}</span>
          ${groupTag}
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
