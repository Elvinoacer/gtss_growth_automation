/**
 * pipelines/logsModal.js — Structured Logs viewer modal.
 *
 * Searchable / filterable log list with a live-tail Socket.IO option. The
 * modal is mounted into the shared `#pipeline-modal-root` element.
 */

/* global gtss */

// ── Logs Modal ──────────────────────────────────────────────────────────────

function renderLogsModalShell(pipelineId) {
  const pipeline = pipelinesData.find(p => p.id === pipelineId) || { name: pipelineId };
  return `
    <div id="pipeline-modal" style="position:fixed;inset:0;z-index:3000;display:grid;place-items:center;padding:20px;background:rgba(2,6,23,0.78);animation:fadeIn 200ms ease">
      <div style="width:min(1100px,100%);max-height:88vh;display:flex;flex-direction:column;border-radius:20px;
        background:linear-gradient(180deg,rgba(15,23,42,0.98),rgba(15,23,42,0.92));
        border:1px solid rgba(148,163,184,0.2);box-shadow:0 24px 80px rgba(0,0,0,0.4)">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:18px 24px;border-bottom:1px solid rgba(148,163,184,0.12)">
          <div>
            <h3 style="margin:0;font-size:17px;font-weight:700;color:#f8fafc">📜 ${gtss.escapeHtml(pipeline.name)} — Logs</h3>
            <p style="margin:4px 0 0;font-size:12px;color:#94a3b8">Searchable, filterable structured logs.</p>
          </div>
          <button id="close-modal" type="button" style="width:32px;height:32px;border-radius:999px;
            border:1px solid rgba(148,163,184,0.2);background:rgba(148,163,184,0.06);
            color:#94a3b8;cursor:pointer;font-size:16px;display:grid;place-items:center">✕</button>
        </div>

        <div style="padding:14px 24px;border-bottom:1px solid rgba(148,163,184,0.1);display:flex;flex-wrap:wrap;gap:8px;align-items:center">
          <input id="logs-search" type="text" placeholder="Search messages…" class="filter-input" style="flex:1;min-width:200px" />
          <select id="logs-level" class="filter-input">
            <option value="">All levels</option>
            <option value="info">Info</option>
            <option value="success">Success</option>
            <option value="warn">Warn</option>
            <option value="error">Error</option>
            <option value="retry">Retry</option>
            <option value="debug">Debug</option>
          </select>
          <select id="logs-stage" class="filter-input">
            <option value="">All stages</option>
          </select>
          <label style="display:flex;align-items:center;gap:5px;font-size:12px;color:#94a3b8;cursor:pointer">
            <input id="logs-live" type="checkbox" style="accent-color:#0ea5e9" /> Live tail
          </label>
          <button id="logs-refresh" type="button" class="filter-input" style="cursor:pointer">Refresh</button>
        </div>

        <div id="logs-counts" style="padding:8px 24px;border-bottom:1px solid rgba(148,163,184,0.1);font-size:11px;color:#94a3b8;display:flex;gap:14px;flex-wrap:wrap"></div>

        <div id="logs-list" class="scroll-y" style="flex:1;overflow-y:auto;padding:12px 24px;background:rgba(2,6,23,0.4)">
          <div style="padding:24px;text-align:center;color:#64748b">Loading logs…</div>
        </div>
      </div>
    </div>
  `;
}

function renderLogRow(log) {
  const time = new Date(log.created_at).toLocaleTimeString('en-US', { hour12: false });
  const meta = `[${time}]${log.stage ? ` [${log.stage}]` : ''}${log.retry_attempt ? ` (retry ${log.retry_attempt})` : ''}`;
  const stack = log.stack_trace ? `<details style="margin-top:4px"><summary style="cursor:pointer;font-size:10px;color:#64748b">Stack trace</summary><pre style="margin:4px 0 0;font-size:11px;color:#94a3b8;white-space:pre-wrap">${gtss.escapeHtml(log.stack_trace)}</pre></details>` : '';
  return `<div class="log-row ${log.level}">
    <span class="log-meta">${meta}</span>
    ${gtss.escapeHtml(log.message)}
    ${stack}
  </div>`;
}

function refreshLogsModal(pipelineId, data) {
  const list = document.getElementById('logs-list');
  const counts = document.getElementById('logs-counts');
  if (!list) return;

  const logs = data.logs || [];
  if (logs.length === 0) {
    list.innerHTML = `<div style="padding:24px;text-align:center;color:#64748b">No logs match the current filters.</div>`;
  } else {
    // Render oldest-first for natural reading flow
    list.innerHTML = logs.slice().reverse().map(renderLogRow).join('');
  }

  if (counts) {
    const c = data.counts || {};
    counts.innerHTML = `
      <span>Total: <strong style="color:#e2e8f0">${c.total || logs.length}</strong></span>
      <span style="color:#38bdf8">Info: ${c.info || 0}</span>
      <span style="color:#22c55e">Success: ${c.success || 0}</span>
      <span style="color:#fbbf24">Warn: ${c.warn || 0}</span>
      <span style="color:#f87171">Errors: ${c.error || 0}</span>
      <span style="color:#a78bfa">Retries: ${c.retry || 0}</span>
      <span style="color:#64748b">Debug: ${c.debug || 0}</span>
    `;
  }

  // Populate stage filter from observed stages
  const stageSelect = document.getElementById('logs-stage');
  if (stageSelect) {
    const stages = [...new Set(logs.map(l => l.stage).filter(Boolean))].sort();
    const currentVal = stageSelect.value;
    stageSelect.innerHTML = '<option value="">All stages</option>' +
      stages.map(s => `<option value="${s}"${s === currentVal ? ' selected' : ''}>${s}</option>`).join('');
  }
}

function attachLogsModalListeners(pipelineId) {
  const overlay = document.getElementById('pipeline-modal');
  if (!overlay) return;

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.id === 'close-modal') {
      if (activeLogsSub) { try { activeLogsSub.off(); } catch (_) {} activeLogsSub = null; }
      overlay.remove();
    }
  });

  const refresh = async (btn) => {
    const search = document.getElementById('logs-search')?.value || '';
    const level = document.getElementById('logs-level')?.value || '';
    const stage = document.getElementById('logs-stage')?.value || '';

    // When triggered by the Refresh button, wrap the fetch in button
    // feedback so the user sees a spinner + a brief "✓ Refreshed" flash.
    // When triggered by filter changes (no btn), just run the fetch.
    const run = () => loadLogs(pipelineId, { search, level, stage, limit: 300 });
    if (btn) {
      try {
        const data = await withButtonFeedback(btn, 'Refresh', run, { successLabel: 'Refreshed', silent: true });
        refreshLogsModal(pipelineId, data);
      } catch (_) { /* loadLogs already toasted */ }
    } else {
      const data = await run();
      refreshLogsModal(pipelineId, data);
    }
  };

  document.getElementById('logs-refresh')?.addEventListener('click', (e) => refresh(e.currentTarget));
  let searchTimer = null;
  document.getElementById('logs-search')?.addEventListener('input', () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => refresh(null), 300);
  });
  document.getElementById('logs-level')?.addEventListener('change', () => refresh(null));
  document.getElementById('logs-stage')?.addEventListener('change', () => refresh(null));

  // Live tail via Socket.IO
  const liveCheckbox = document.getElementById('logs-live');
  liveCheckbox?.addEventListener('change', () => {
    if (liveCheckbox.checked) {
      activeLogsSub = gtss.initSocket({
        'pipeline:log': (log) => {
          if (log.pipeline_id !== pipelineId) return;
          const list = document.getElementById('logs-list');
          if (!list) return;
          // Prepend new log (we render oldest-first via reverse, so prepend visually = at the bottom)
          const wrapper = document.createElement('div');
          wrapper.innerHTML = renderLogRow(log);
          const newRow = wrapper.firstElementChild;
          if (newRow) list.appendChild(newRow);
          // Auto-scroll to bottom
          list.scrollTop = list.scrollHeight;
        },
      });
    } else {
      if (activeLogsSub) { try { activeLogsSub.off(); } catch (_) {} activeLogsSub = null; }
    }
  });
}
