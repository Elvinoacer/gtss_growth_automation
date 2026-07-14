/**
 * pipelines/massFollowModal.js — Mass-Follow Pipeline Target Manager modal.
 *
 * The mass_follow pipeline operates on rows in `mass_follow_targets`. This
 * modal gives the user a single, self-contained workspace for:
 *   1. Adding targets — one-by-one (form) or in bulk (paste / CSV textarea)
 *   2. Reviewing current targets — filterable, paginated table
 *   3. Retrying failed targets — single click resets them to 'pending'
 *   4. Removing targets — single or bulk (by platform / status / age)
 *
 * The wizard is intentionally step-by-step inside the modal:
 *   Step 1 → choose platform & paste handles/URLs
 *   Step 2 → review what was added
 *   Step 3 → enable the pipeline + Run Now (or wait for cron)
 */

/* global gtss */

function massFollowStatusBadge(status) {
  const colors = {
    pending:  { bg: 'rgba(148,163,184,0.12)', border: 'rgba(148,163,184,0.35)', color: '#cbd5e1' },
    running:  { bg: 'rgba(56,189,248,0.14)',  border: 'rgba(56,189,248,0.4)',  color: '#38bdf8' },
    sent:     { bg: 'rgba(34,197,94,0.12)',   border: 'rgba(34,197,94,0.35)',  color: '#4ade80' },
    accepted: { bg: 'rgba(34,197,94,0.12)',   border: 'rgba(34,197,94,0.35)',  color: '#4ade80' },
    skipped:  { bg: 'rgba(245,158,11,0.12)',  border: 'rgba(245,158,11,0.35)', color: '#fbbf24' },
    failed:   { bg: 'rgba(248,113,113,0.12)', border: 'rgba(248,113,113,0.35)',color: '#f87171' },
  };
  const c = colors[status] || colors.pending;
  return `<span style="display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:700;background:${c.bg};border:1px solid ${c.border};color:${c.color}">${gtss.escapeHtml(status)}</span>`;
}

function renderMassFollowTargetsModal(id) {
  return `
    <div id="mass-follow-modal-overlay" style="position:fixed;inset:0;background:rgba(2,6,15,0.7);backdrop-filter:blur(6px);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px">
      <div class="glass-panel" style="position:relative;width:100%;max-width:1100px;max-height:92vh;display:flex;flex-direction:column;border-radius:24px;overflow:hidden">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:20px 24px;border-bottom:1px solid rgba(148,163,184,0.18)">
          <div>
            <h2 style="font-size:20px;font-weight:700;color:#f8fafc;margin:0">🎯 Mass-Follow Target Manager</h2>
            <p style="font-size:12px;color:#94a3b8;margin:4px 0 0 0">Step-by-step: add targets → review → run the pipeline.</p>
          </div>
          <button id="mass-follow-close-btn" type="button" style="background:rgba(148,163,184,0.1);border:1px solid rgba(148,163,184,0.18);color:#94a3b8;width:36px;height:36px;border-radius:10px;cursor:pointer;font-size:18px">✕</button>
        </div>

        <div style="flex:1;overflow-y:auto;padding:20px 24px">
          <!-- ── Step 1: Add targets ──────────────────────────────────── -->
          <section style="margin-bottom:24px">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
              <span style="display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:999px;background:rgba(168,85,247,0.2);color:#c4b5fd;font-size:12px;font-weight:700">1</span>
              <h3 style="font-size:15px;font-weight:700;color:#e2e8f0;margin:0">Add Follow Targets</h3>
            </div>
            <p style="font-size:12px;color:#94a3b8;margin:0 0 12px 34px">Pick a platform, then paste one handle or profile URL per line. Bare handles (e.g. <code>@acme</code>) are accepted — they'll be sent to the platform adapter as-is.</p>

            <div style="margin-left:34px;display:flex;flex-direction:column;gap:10px">
              <div style="display:flex;flex-wrap:wrap;gap:6px">
                ${MASS_FOLLOW_PLATFORMS.map(p => `
                  <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;padding:7px 13px;border-radius:10px;border:1px solid rgba(148,163,184,0.18);background:transparent;color:#e2e8f0;font-size:13px;font-weight:500">
                    <input type="radio" name="mass-follow-platform" value="${p}" ${p === 'instagram' ? 'checked' : ''}>
                    ${gtss.formatPlatformLabel(p)}
                  </label>
                `).join('')}
              </div>
              <textarea id="mass-follow-targets-input" rows="6" placeholder="https://instagram.com/acme&#10;@brand&#10;https://x.com/handle" style="width:100%;padding:12px;border-radius:10px;border:1px solid rgba(148,163,184,0.2);background:rgba(15,23,42,0.5);color:#e2e8f0;font-family:'Geist Mono','JetBrains Mono',monospace;font-size:13px;resize:vertical"></textarea>
              <div style="display:flex;gap:8px;align-items:center">
                <button id="mass-follow-add-btn" type="button" style="padding:9px 18px;border-radius:10px;border:1px solid rgba(168,85,247,0.4);background:rgba(168,85,247,0.18);color:#c4b5fd;font-size:13px;font-weight:600;cursor:pointer">➕ Add Targets</button>
                <button id="mass-follow-import-leads-btn" type="button" style="padding:9px 18px;border-radius:10px;border:1px solid rgba(56,189,248,0.35);background:rgba(56,189,248,0.1);color:#38bdf8;font-size:13px;font-weight:600;cursor:pointer">Import from Leads</button>
                <span id="mass-follow-add-feedback" style="font-size:12px;color:#94a3b8"></span>
              </div>
            </div>
          </section>

          <!-- ── Step 2: Review targets ──────────────────────────────── -->
          <section style="margin-bottom:24px">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
              <div style="display:flex;align-items:center;gap:10px">
                <span style="display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:999px;background:rgba(168,85,247,0.2);color:#c4b5fd;font-size:12px;font-weight:700">2</span>
                <h3 style="font-size:15px;font-weight:700;color:#e2e8f0;margin:0">Review & Manage Targets</h3>
              </div>
              <div style="display:flex;gap:6px;align-items:center">
                <select id="mass-follow-filter-platform" style="padding:5px 10px;border-radius:8px;border:1px solid rgba(148,163,184,0.18);background:rgba(15,23,42,0.5);color:#e2e8f0;font-size:12px">
                  <option value="">All platforms</option>
                  ${MASS_FOLLOW_PLATFORMS.map(p => `<option value="${p}">${gtss.formatPlatformLabel(p)}</option>`).join('')}
                </select>
                <select id="mass-follow-filter-status" style="padding:5px 10px;border-radius:8px;border:1px solid rgba(148,163,184,0.18);background:rgba(15,23,42,0.5);color:#e2e8f0;font-size:12px">
                  <option value="">All statuses</option>
                  <option value="pending">Pending</option>
                  <option value="running">Running</option>
                  <option value="sent">Sent</option>
                  <option value="skipped">Skipped</option>
                  <option value="failed">Failed</option>
                </select>
                <button id="mass-follow-clear-btn" type="button" style="padding:5px 12px;border-radius:8px;border:1px solid rgba(248,113,113,0.3);background:rgba(248,113,113,0.08);color:#f87171;font-size:12px;font-weight:600;cursor:pointer" title="Bulk-delete by filter (you'll be asked to confirm)">🗑 Clear…</button>
              </div>
            </div>
            <div id="mass-follow-summary" style="margin-left:34px;margin-bottom:10px;font-size:12px;color:#94a3b8">Loading…</div>
            <div id="mass-follow-table" style="margin-left:34px;border:1px solid rgba(148,163,184,0.18);border-radius:12px;overflow:hidden;max-height:340px;overflow-y:auto">Loading…</div>
          </section>

          <!-- ── Step 3: Run ─────────────────────────────────────────── -->
          <section>
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
              <span style="display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:999px;background:rgba(168,85,247,0.2);color:#c4b5fd;font-size:12px;font-weight:700">3</span>
              <h3 style="font-size:15px;font-weight:700;color:#e2e8f0;margin:0">Run the Pipeline</h3>
            </div>
            <p style="font-size:12px;color:#94a3b8;margin:0 0 12px 34px">Enable the pipeline on the parent card (top-left toggle), then either wait for the cron schedule or trigger a manual run now. The pipeline respects each platform's daily/hourly limits and active window.</p>
            <div style="margin-left:34px;display:flex;gap:10px;flex-wrap:wrap">
              <button id="mass-follow-run-now-btn" type="button" style="padding:10px 18px;border-radius:10px;border:1px solid rgba(34,197,94,0.3);background:rgba(34,197,94,0.1);color:#22c55e;font-size:13px;font-weight:600;cursor:pointer">▶ Run Now</button>
              <a href="/pipelines" onclick="document.getElementById('mass-follow-close-btn').click();return true" style="padding:10px 18px;border-radius:10px;border:1px solid rgba(148,163,184,0.2);background:rgba(148,163,184,0.06);color:#94a3b8;font-size:13px;font-weight:600;cursor:pointer;text-decoration:none;display:inline-block">← Back to Pipelines</a>
            </div>
          </section>
        </div>
      </div>
    </div>
  `;
}

async function loadMassFollowTargets(filters = {}) {
  const params = new URLSearchParams();
  if (filters.platform) params.set('platform', filters.platform);
  if (filters.status) params.set('status', filters.status);
  params.set('limit', '200');
  const res = await gtss.fetchJSON(`/api/pipelines/mass-follow/targets?${params.toString()}`);
  if (!res.ok) throw new Error(res.error || 'Failed to load targets');
  return res.data;
}

function renderMassFollowTable(data) {
  if (!data || !data.targets || data.targets.length === 0) {
    return `<div style="padding:32px;text-align:center;color:#64748b;font-size:13px">No targets match the current filter.</div>`;
  }
  const rows = data.targets.map((t) => `
    <tr style="border-bottom:1px solid rgba(148,163,184,0.08)">
      <td style="padding:8px 12px;font-size:12px;color:#cbd5e1">${gtss.escapeHtml(t.platform)}</td>
      <td style="padding:8px 12px;font-size:12px;color:#e2e8f0;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${gtss.escapeHtml(t.profile_url)}">
        ${t.handle ? `<strong>${gtss.escapeHtml(t.handle)}</strong> ` : ''}<a href="${gtss.escapeHtml(t.profile_url)}" target="_blank" rel="noopener" style="color:#38bdf8;text-decoration:none">${gtss.escapeHtml(t.profile_url)}</a>
      </td>
      <td style="padding:8px 12px">${massFollowStatusBadge(t.status)}</td>
      <td style="padding:8px 12px;font-size:11px;color:#94a3b8">${t.retry_count || 0}/${t.max_retries || 3}${t.error_message ? ` · <span style="color:#f87171" title="${gtss.escapeHtml(t.error_message)}">err</span>` : ''}</td>
      <td style="padding:8px 12px;font-size:11px;color:#94a3b8">${formatRelative(t.attempted_at || t.sent_at || t.created_at)}</td>
      <td style="padding:8px 12px;text-align:right;white-space:nowrap">
        ${t.status === 'failed' ? `<button class="mf-retry-btn" data-target-id="${t.id}" style="padding:4px 10px;border-radius:7px;border:1px solid rgba(56,189,248,0.3);background:rgba(56,189,248,0.08);color:#38bdf8;font-size:11px;font-weight:600;cursor:pointer">↻ Retry</button>` : ''}
        <button class="mf-delete-btn" data-target-id="${t.id}" style="padding:4px 10px;border-radius:7px;border:1px solid rgba(248,113,113,0.3);background:rgba(248,113,113,0.06);color:#f87171;font-size:11px;font-weight:600;cursor:pointer">Delete</button>
      </td>
    </tr>
  `).join('');
  return `
    <table style="width:100%;border-collapse:collapse;font-family:'Geist',system-ui,sans-serif">
      <thead>
        <tr style="background:rgba(15,23,42,0.5);font-size:11px;text-transform:uppercase;letter-spacing:0.1em;color:#64748b">
          <th style="padding:8px 12px;text-align:left;font-weight:700">Platform</th>
          <th style="padding:8px 12px;text-align:left;font-weight:700">Target</th>
          <th style="padding:8px 12px;text-align:left;font-weight:700">Status</th>
          <th style="padding:8px 12px;text-align:left;font-weight:700">Retries</th>
          <th style="padding:8px 12px;text-align:left;font-weight:700">Last activity</th>
          <th style="padding:8px 12px;text-align:right;font-weight:700">Actions</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderMassFollowSummary(data) {
  if (!data || !data.summary) return '';
  const platformSummaries = Object.entries(data.summary).map(([platform, statuses]) => {
    const parts = Object.entries(statuses).map(([status, count]) => `${status}: <strong style="color:#cbd5e1">${count}</strong>`).join(' · ');
    return `<div style="margin-bottom:4px"><span style="display:inline-block;min-width:80px;font-weight:600;color:#c4b5fd">${gtss.formatPlatformLabel(platform)}</span> ${parts}</div>`;
  }).join('');
  return `<div>Total: <strong style="color:#e2e8f0">${data.total || 0}</strong></div>${platformSummaries}`;
}

async function refreshMassFollowTable(filters) {
  const tableEl = document.getElementById('mass-follow-table');
  const summaryEl = document.getElementById('mass-follow-summary');
  if (tableEl) tableEl.innerHTML = `<div style="padding:24px;text-align:center;color:#64748b;font-size:12px">Loading…</div>`;
  try {
    const data = await loadMassFollowTargets(filters);
    if (tableEl) tableEl.innerHTML = renderMassFollowTable(data);
    if (summaryEl) summaryEl.innerHTML = renderMassFollowSummary(data);
  } catch (err) {
    if (tableEl) tableEl.innerHTML = `<div style="padding:24px;text-align:center;color:#f87171;font-size:12px">Failed to load: ${gtss.escapeHtml(err.message)}</div>`;
  }
}

async function openMassFollowTargetsModal(id /* pipelineId, always 'mass_follow' */) {
  const root = document.getElementById('pipeline-modal-root');
  if (!root) return;
  root.innerHTML = renderMassFollowTargetsModal(id);

  const overlay = document.getElementById('mass-follow-modal-overlay');
  const closeBtn = document.getElementById('mass-follow-close-btn');
  const close = () => { root.innerHTML = ''; };
  closeBtn.addEventListener('click', close);
  // Click outside the inner panel also closes
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  // ESC closes
  const escHandler = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', escHandler); } };
  document.addEventListener('keydown', escHandler);

  // Filter changes
  const platformFilter = document.getElementById('mass-follow-filter-platform');
  const statusFilter = document.getElementById('mass-follow-filter-status');
  const getFilters = () => ({
    platform: platformFilter.value,
    status: statusFilter.value,
  });
  platformFilter.addEventListener('change', () => refreshMassFollowTable(getFilters()));
  statusFilter.addEventListener('change', () => refreshMassFollowTable(getFilters()));

  // Initial load
  await refreshMassFollowTable({});

  // Add button
  const addBtn = document.getElementById('mass-follow-add-btn');
  const input = document.getElementById('mass-follow-targets-input');
  const feedback = document.getElementById('mass-follow-add-feedback');
  addBtn.addEventListener('click', async () => {
    const checkedPlatform = document.querySelector('input[name="mass-follow-platform"]:checked');
    const platform = checkedPlatform ? checkedPlatform.value : 'instagram';
    const text = input.value.trim();
    if (!text) {
      feedback.textContent = 'Paste at least one handle or URL.';
      feedback.style.color = '#fbbf24';
      return;
    }
    // Split on newlines (and optionally commas), trim, dedupe
    const lines = text
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const targets = lines.map((line) => ({ platform, profile_url: line }));
    feedback.textContent = `Adding ${targets.length} target(s)…`;
    feedback.style.color = '#94a3b8';
    addBtn.disabled = true;
    try {
      const res = await gtss.fetchJSON('/api/pipelines/mass-follow/targets', {
        method: 'POST',
        body: JSON.stringify({ targets }),
      });
      if (res.ok) {
        const d = res.data;
        feedback.innerHTML = `<span style="color:#4ade80">✓ Added ${d.inserted} new, updated ${d.updated}${d.errors ? `, ${d.errors} error(s)` : ''}</span>`;
        input.value = '';
        await refreshMassFollowTable(getFilters());
      } else {
        feedback.innerHTML = `<span style="color:#f87171">✗ ${gtss.escapeHtml(res.error || 'Add failed')}</span>`;
      }
    } catch (err) {
      feedback.innerHTML = `<span style="color:#f87171">✗ ${gtss.escapeHtml(err.message)}</span>`;
    } finally {
      addBtn.disabled = false;
    }
  });

  // Import discovered/qualified leads into the reviewable target queue.
  const importLeadsBtn = document.getElementById('mass-follow-import-leads-btn');
  importLeadsBtn.addEventListener('click', async () => {
    const filters = getFilters();
    importLeadsBtn.disabled = true;
    importLeadsBtn.textContent = 'Importing...';
    feedback.textContent = 'Importing discovered and qualified leads...';
    feedback.style.color = '#94a3b8';
    try {
      const body = {
        platforms: filters.platform ? [filters.platform] : MASS_FOLLOW_PLATFORMS,
        limit: 200,
      };
      const res = await gtss.fetchJSON('/api/pipelines/mass-follow/targets/import-leads', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const d = res.data;
        feedback.innerHTML = `<span style="color:#4ade80">Imported ${d.inserted || 0} new, updated ${d.updated || 0} from ${d.considered || 0} lead(s)</span>`;
        await refreshMassFollowTable(getFilters());
      } else {
        feedback.innerHTML = `<span style="color:#f87171">${gtss.escapeHtml(res.error || 'Import failed')}</span>`;
      }
    } catch (err) {
      feedback.innerHTML = `<span style="color:#f87171">${gtss.escapeHtml(err.message)}</span>`;
    } finally {
      importLeadsBtn.disabled = false;
      importLeadsBtn.textContent = 'Import from Leads';
    }
  });

  // Per-row actions (retry / delete) — delegated
  const tableEl = document.getElementById('mass-follow-table');
  tableEl.addEventListener('click', async (e) => {
    const retryBtn = e.target.closest('.mf-retry-btn');
    const deleteBtn = e.target.closest('.mf-delete-btn');
    if (retryBtn) {
      const targetId = retryBtn.dataset.targetId;
      try {
        const res = await gtss.fetchJSON(`/api/pipelines/mass-follow/targets/${targetId}/retry`, { method: 'POST' });
        if (res.ok) {
          gtss.showToast('Target reset to pending', 'success');
          await refreshMassFollowTable(getFilters());
        } else {
          gtss.showToast(res.error || 'Retry failed', 'error', 6000);
        }
      } catch (err) {
        gtss.showToast(err.message, 'error', 6000);
      }
    } else if (deleteBtn) {
      const targetId = deleteBtn.dataset.targetId;
      if (!confirm('Delete this target?')) return;
      try {
        const res = await gtss.fetchJSON(`/api/pipelines/mass-follow/targets/${targetId}`, { method: 'DELETE' });
        if (res.ok) {
          gtss.showToast('Target deleted', 'success');
          await refreshMassFollowTable(getFilters());
        } else {
          gtss.showToast(res.error || 'Delete failed', 'error', 6000);
        }
      } catch (err) {
        gtss.showToast(err.message, 'error', 6000);
      }
    }
  });

  // Clear button — opens a small inline confirm
  const clearBtn = document.getElementById('mass-follow-clear-btn');
  clearBtn.addEventListener('click', async () => {
    const filters = getFilters();
    const description = [
      filters.platform ? `platform=${filters.platform}` : null,
      filters.status ? `status=${filters.status}` : null,
    ].filter(Boolean).join(', ') || 'ALL targets';
    const daysStr = prompt(`Bulk-delete targets. Enter a minimum age in days (older than which to delete), or leave blank to ignore age.\n\nWill delete: ${description}`);
    if (daysStr === null) return;
    const olderThanDays = Number(daysStr) || 0;
    if (!confirm(`Delete ${description}${olderThanDays > 0 ? ` older than ${olderThanDays} day(s)` : ''}? This cannot be undone.`)) return;
    try {
      const res = await gtss.fetchJSON('/api/pipelines/mass-follow/targets/clear', {
        method: 'POST',
        body: JSON.stringify({
          platform: filters.platform || undefined,
          status: filters.status || undefined,
          older_than_days: olderThanDays > 0 ? olderThanDays : undefined,
        }),
      });
      if (res.ok) {
        gtss.showToast(`Deleted ${res.data.deleted} target(s)`, 'success');
        await refreshMassFollowTable(getFilters());
      } else {
        gtss.showToast(res.error || 'Clear failed', 'error', 6000);
      }
    } catch (err) {
      gtss.showToast(err.message, 'error', 6000);
    }
  });

  // Run Now button — triggers the same /api/pipelines/mass_follow/run endpoint
  // as the parent card's Run button.
  const runNowBtn = document.getElementById('mass-follow-run-now-btn');
  runNowBtn.addEventListener('click', async () => {
    runNowBtn.disabled = true;
    runNowBtn.textContent = '⏳ Triggering…';
    try {
      const res = await gtss.fetchJSON('/api/pipelines/mass_follow/run', { method: 'POST' });
      if (res.ok) {
        gtss.showToast('Mass-follow pipeline started', 'success');
        close();
        loadPipelines();
      } else {
        gtss.showToast(res.error || 'Run failed', 'error', 6000);
      }
    } catch (err) {
      gtss.showToast(err.message, 'error', 6000);
    } finally {
      runNowBtn.disabled = false;
      runNowBtn.textContent = '▶ Run Now';
    }
  });
}
