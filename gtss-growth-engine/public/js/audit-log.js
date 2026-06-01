function auditQuery() {
  const params = new URLSearchParams();
  const type = document.getElementById("audit-type").value;
  const status = document.getElementById("audit-status").value;
  const platform = document.getElementById("audit-platform").value.trim();
  if (type) params.set("type", type);
  if (status) params.set("status", status);
  if (platform) params.set("platform", platform);
  return params.toString();
}

async function loadAudit() {
  const query = auditQuery();
  const data = await window.gtss.fetchJSON(`/api/audit${query ? `?${query}` : ""}`);
  document.getElementById("audit-export").href = `/api/audit/export${query ? `?${query}` : ""}`;
  const feed = document.getElementById("audit-feed");
  const entries = data.entries || [];
  if (!entries.length) {
    feed.innerHTML = `<div class="audit-entry audit-meta">No audit entries found.</div>`;
    return;
  }
  feed.innerHTML = entries
    .map((entry) => `
      <article class="audit-entry">
        <strong>${window.gtss.escapeHtml(entry.summary)}</strong>
        <span class="audit-meta">${window.gtss.escapeHtml(entry.activity_type)} | ${window.gtss.escapeHtml(entry.status || "unknown")} | ${window.gtss.escapeHtml(entry.platform || "all")}</span>
        <span class="audit-meta">${new Date(entry.created_at).toLocaleString()} | ${window.gtss.escapeHtml(entry.entity_type || "")} ${window.gtss.escapeHtml(entry.entity_id || "")}</span>
      </article>
    `)
    .join("");
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("audit-refresh").addEventListener("click", loadAudit);
  ["audit-type", "audit-status"].forEach((id) => {
    document.getElementById(id).addEventListener("change", loadAudit);
  });
  loadAudit().catch((error) => window.gtss.showToast(error.message, "error"));
});
