/**
 * pipelines/executionsModal.js — Execution History modal + Execution Detail modal.
 *
 * `renderExecutionsModal` shows the list of recent executions; clicking a row
 * opens `renderExecutionDetailModal` which shows full state, error, stack
 * trace, checkpoints, and the last 200 logs. Both modals mount into the shared
 * `#pipeline-modal-root` element.
 */

/* global gtss */

// ── Executions Modal ────────────────────────────────────────────────────────

function renderExecutionsModal(pipelineId, executions) {
  const root = document.getElementById('pipeline-modal-root');
  const pipeline = pipelinesData.find(p => p.id === pipelineId) || { name: pipelineId };

  const rowsHtml = executions.length === 0
    ? `<div style="padding:32px;text-align:center;color:#64748b">No executions recorded yet. Click "Run Now" to start the first one.</div>`
    : executions.map(exec => {
        const meta = STATE_META[exec.status] || STATE_META.idle;
        return `
          <div style="display:grid;grid-template-columns:auto 1fr auto;gap:12px;padding:12px;border-bottom:1px solid rgba(148,163,184,0.1);cursor:pointer"
            data-exec-row="${exec.id}" data-pipeline="${pipelineId}">
            <div style="font-family:monospace;font-size:12px;color:#64748b">${String(exec.id).slice(0,8)}</div>
            <div style="min-width:0">
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
                ${statusBadge(exec.status)}
                <span style="font-size:11px;color:#64748b">trigger: ${exec.trigger}</span>
                ${exec.retry_count > 0 ? `<span class="stage-pill failed">↻ ${exec.retry_count} retries</span>` : ''}
              </div>
              <div style="font-size:12px;color:#94a3b8">
                ${exec.current_stage ? `<strong>Stage:</strong> ${exec.current_stage} · ` : ''}
                Started ${formatRelative(exec.started_at)} · Duration ${formatDuration(exec.duration_ms)}
              </div>
              ${exec.error_message ? `<div style="font-size:11px;color:#f87171;margin-top:4px;word-break:break-word">${gtss.escapeHtml(exec.error_message.slice(0, 200))}${exec.error_message.length > 200 ? '…' : ''}</div>` : ''}
            </div>
            <div style="font-size:11px;color:#64748b;text-align:right">
              ${exec.progress || 0}%
            </div>
          </div>
        `;
      }).join('');

  root.innerHTML = `
    <div id="pipeline-modal" style="position:fixed;inset:0;z-index:3000;display:grid;place-items:center;padding:20px;background:rgba(2,6,23,0.78);animation:fadeIn 200ms ease">
      <div style="width:min(900px,100%);max-height:85vh;display:flex;flex-direction:column;border-radius:20px;
        background:linear-gradient(180deg,rgba(15,23,42,0.98),rgba(15,23,42,0.92));
        border:1px solid rgba(148,163,184,0.2);box-shadow:0 24px 80px rgba(0,0,0,0.4)">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:18px 24px;border-bottom:1px solid rgba(148,163,184,0.12)">
          <div>
            <h3 style="margin:0;font-size:17px;font-weight:700;color:#f8fafc">${gtss.escapeHtml(pipeline.name)} — Execution History</h3>
            <p style="margin:4px 0 0;font-size:12px;color:#94a3b8">Click any execution to view full detail, checkpoints, and logs.</p>
          </div>
          <button id="close-modal" type="button" style="width:32px;height:32px;border-radius:999px;
            border:1px solid rgba(148,163,184,0.2);background:rgba(148,163,184,0.06);
            color:#94a3b8;cursor:pointer;font-size:16px;display:grid;place-items:center">✕</button>
        </div>
        <div class="scroll-y" style="flex:1;overflow-y:auto">${rowsHtml}</div>
      </div>
    </div>
  `;

  const overlay = document.getElementById('pipeline-modal');
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.id === 'close-modal') {
      overlay.remove();
    }
  });
  overlay.querySelectorAll('[data-exec-row]').forEach(row => {
    row.addEventListener('click', () => {
      const eid = row.dataset.execRow;
      const pid = row.dataset.pipeline;
      loadExecutionDetail(pid, eid);
    });
  });
}

function renderExecutionDetailModal(pipelineId, data) {
  const root = document.getElementById('pipeline-modal-root');
  const { execution, checkpoints, logs } = data;

  const cpStatus = {};
  for (const cp of checkpoints) cpStatus[cp.stage] = cp.status;

  const meta = PIPELINE_META[pipelineId] || { stages: [] };

  const logsHtml = (logs || []).slice().reverse().map(log => renderLogRow(log)).join('');

  const checkpointsHtml = checkpoints.length === 0
    ? `<div style="padding:16px;color:#64748b;font-size:12px">No checkpoints recorded.</div>`
    : checkpoints.map(cp => `
        <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-radius:8px;background:rgba(15,23,42,0.4);margin-bottom:4px">
          <div style="display:flex;align-items:center;gap:8px">
            <span class="stage-pill ${cp.status === 'completed' ? 'done' : cp.status === 'failed' ? 'failed' : 'skipped'}">${cp.status}</span>
            <strong style="font-size:13px;color:#e2e8f0">${cp.stage}</strong>
            ${cp.attempt > 1 ? `<span style="font-size:11px;color:#a78bfa">attempt ${cp.attempt}</span>` : ''}
          </div>
          <div style="font-size:11px;color:#64748b">
            ${formatRelative(cp.created_at)}${cp.duration_ms ? ` · ${formatDuration(cp.duration_ms)}` : ''}
            ${cp.error_message ? ` · <span style="color:#f87171">${gtss.escapeHtml(cp.error_message.slice(0, 60))}${cp.error_message.length > 60 ? '…' : ''}</span>` : ''}
          </div>
        </div>
      `).join('');

  root.innerHTML = `
    <div id="pipeline-modal" style="position:fixed;inset:0;z-index:3000;display:grid;place-items:center;padding:20px;background:rgba(2,6,23,0.78);animation:fadeIn 200ms ease">
      <div style="width:min(1000px,100%);max-height:88vh;display:flex;flex-direction:column;border-radius:20px;
        background:linear-gradient(180deg,rgba(15,23,42,0.98),rgba(15,23,42,0.92));
        border:1px solid rgba(148,163,184,0.2);box-shadow:0 24px 80px rgba(0,0,0,0.4)">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:18px 24px;border-bottom:1px solid rgba(148,163,184,0.12)">
          <div style="min-width:0">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px">
              ${statusBadge(execution.status)}
              <span style="font-family:monospace;font-size:11px;color:#64748b">${execution.id}</span>
              <span style="font-size:11px;color:#64748b">trigger: ${execution.trigger}</span>
            </div>
            <h3 style="margin:0;font-size:17px;font-weight:700;color:#f8fafc">Execution Detail</h3>
          </div>
          <button id="close-modal" type="button" style="width:32px;height:32px;border-radius:999px;
            border:1px solid rgba(148,163,184,0.2);background:rgba(148,163,184,0.06);
            color:#94a3b8;cursor:pointer;font-size:16px;display:grid;place-items:center">✕</button>
        </div>

        <div class="scroll-y" style="flex:1;overflow-y:auto;padding:20px 24px;display:flex;flex-direction:column;gap:18px">

          <div>
            <h4 style="margin:0 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:0.1em;color:#64748b">Summary</h4>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px">
              <div class="metric-card"><div class="metric-label">Started</div><div class="metric-value" style="font-size:12px">${formatDate(execution.started_at)}</div></div>
              <div class="metric-card"><div class="metric-label">Finished</div><div class="metric-value" style="font-size:12px">${execution.finished_at ? formatDate(execution.finished_at) : '—'}</div></div>
              <div class="metric-card"><div class="metric-label">Duration</div><div class="metric-value">${formatDuration(execution.duration_ms)}</div></div>
              <div class="metric-card"><div class="metric-label">Progress</div><div class="metric-value">${execution.progress || 0}%</div><div class="metric-sub">${execution.completed_steps || 0}/${execution.total_steps || 0} steps</div></div>
              <div class="metric-card"><div class="metric-label">Retries</div><div class="metric-value">${execution.retry_count || 0}</div><div class="metric-sub">max ${execution.max_retries || 3}</div></div>
              <div class="metric-card"><div class="metric-label">Current Stage</div><div class="metric-value" style="font-size:13px">${execution.current_stage || '—'}</div></div>
            </div>
            ${execution.current_message ? `<div style="margin-top:8px;padding:8px 10px;border-radius:8px;background:rgba(15,23,42,0.5);font-size:12px;color:#cbd5e1"><strong>Last message:</strong> ${gtss.escapeHtml(execution.current_message)}</div>` : ''}
          </div>

          ${execution.error_message ? `
            <div>
              <h4 style="margin:0 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:0.1em;color:#f87171">Error</h4>
              <div style="padding:12px;border-radius:8px;background:rgba(248,113,113,0.06);border:1px solid rgba(248,113,113,0.3);font-family:monospace;font-size:12px;color:#fca5a5;white-space:pre-wrap;word-break:break-word">${gtss.escapeHtml(execution.error_message)}</div>
              ${execution.stack_trace ? `<details style="margin-top:6px"><summary style="cursor:pointer;font-size:11px;color:#64748b">Stack trace</summary><pre style="padding:10px;border-radius:6px;background:rgba(15,23,42,0.6);font-size:11px;color:#94a3b8;overflow-x:auto;max-height:300px">${gtss.escapeHtml(execution.stack_trace)}</pre></details>` : ''}
              ${execution.failed_stage ? `
                <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
                  <button type="button" class="pipeline-action-btn" data-action="retry-stage-detail" data-pipeline="${pipelineId}" data-exec="${execution.id}" data-stage="${execution.failed_stage}"
                    style="${actionStyle({ border: 'rgba(167,139,250,0.3)', bg: 'rgba(167,139,250,0.1)', text: '#a78bfa' }, true)}">↻ Retry Failed Step (${execution.failed_stage})</button>
                  <button type="button" class="pipeline-action-btn" data-action="resume-checkpoint-detail" data-pipeline="${pipelineId}" data-exec="${execution.id}"
                    style="${actionStyle({ border: 'rgba(34,197,94,0.3)', bg: 'rgba(34,197,94,0.1)', text: '#4ade80' }, true)}">⏵ Resume from Checkpoint</button>
                  <button type="button" class="pipeline-action-btn" data-action="force-clear-detail" data-pipeline="${pipelineId}"
                    style="${actionStyle({ border: 'rgba(248,113,113,0.4)', bg: 'rgba(248,113,113,0.12)', text: '#f87171' }, true)}" title="Force-clear any stuck execution so a new run can start">✕ Force Clear Stuck Run</button>
                </div>
              ` : `
                <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
                  <button type="button" class="pipeline-action-btn" data-action="retry-stage-detail" data-pipeline="${pipelineId}" data-exec="${execution.id}" data-stage=""
                    style="${actionStyle({ border: 'rgba(167,139,250,0.3)', bg: 'rgba(167,139,250,0.1)', text: '#a78bfa' }, true)}" title="Retry from the first stage (no failed_stage was recorded)">↻ Retry from Start</button>
                  <button type="button" class="pipeline-action-btn" data-action="resume-checkpoint-detail" data-pipeline="${pipelineId}" data-exec="${execution.id}"
                    style="${actionStyle({ border: 'rgba(34,197,94,0.3)', bg: 'rgba(34,197,94,0.1)', text: '#4ade80' }, true)}">⏵ Resume from Checkpoint</button>
                  <button type="button" class="pipeline-action-btn" data-action="force-clear-detail" data-pipeline="${pipelineId}"
                    style="${actionStyle({ border: 'rgba(248,113,113,0.4)', bg: 'rgba(248,113,113,0.12)', text: '#f87171' }, true)}" title="Force-clear any stuck execution so a new run can start">✕ Force Clear Stuck Run</button>
                </div>
              `}
            </div>
          ` : ''}

          <div>
            <h4 style="margin:0 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:0.1em;color:#64748b">Checkpoints (${checkpoints.length})</h4>
            ${checkpointsHtml}
          </div>

          <div>
            <h4 style="margin:0 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:0.1em;color:#64748b">Logs (${logs.length})</h4>
            <div style="max-height:400px;overflow-y:auto;padding:4px;background:rgba(2,6,23,0.4);border-radius:8px;border:1px solid rgba(148,163,184,0.1)">
              ${logsHtml || '<div style="padding:12px;color:#64748b;font-size:12px">No logs recorded.</div>'}
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  const overlay = document.getElementById('pipeline-modal');
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.id === 'close-modal') {
      overlay.remove();
    }
  });
  overlay.querySelectorAll('[data-action="retry-stage-detail"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const pid = btn.dataset.pipeline;
      const eid = btn.dataset.exec;
      const stage = btn.dataset.stage || null;
      retryStage(pid, stage, eid, btn);
      overlay.remove();
    });
  });
  overlay.querySelectorAll('[data-action="resume-checkpoint-detail"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const pid = btn.dataset.pipeline;
      const eid = btn.dataset.exec;
      resumeFromCheckpoint(pid, eid, btn);
      overlay.remove();
    });
  });
  overlay.querySelectorAll('[data-action="force-clear-detail"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const pid = btn.dataset.pipeline;
      forceClearPipeline(pid, btn);
      overlay.remove();
    });
  });
}
