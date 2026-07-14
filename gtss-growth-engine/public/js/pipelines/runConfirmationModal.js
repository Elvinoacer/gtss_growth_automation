/**
 * pipelines/runConfirmationModal.js — Pre-run confirmation modal.
 *
 * Shows the user a compact summary of the pipeline's current settings
 * (cron, limits, platforms) plus a "Show browser window" toggle, and lets
 * them edit the limits inline before confirming. On confirm, returns a
 * payload that is merged into the /run POST body (so the user can override
 * show_browser and limits for this run without permanently saving them).
 */

/* global gtss */

/**
 * Returns a Promise that resolves to:
 *   - { limits: {...}, show_browser: bool } if the user confirms
 *   - null if the user cancels
 */
function openRunConfirmationModal(pipelineId) {
  return new Promise((resolve) => {
    const pipeline = pipelinesData.find((p) => p.id === pipelineId);
    if (!pipeline) { resolve(null); return; }
    const meta = PIPELINE_META[pipelineId] || {};
    const limits = { ...(pipeline.limits || {}) };
    const root = document.getElementById('pipeline-modal-root');
    if (!root) { resolve(null); return; }

    // Whether this pipeline launches a browser (so the "show browser" toggle
    // is relevant). Mass-follow and content both launch browsers.
    const launchesBrowser = pipelineId === 'mass_follow' || pipelineId === 'content' || pipelineId === 'outreach';
    let showBrowser = limits.show_browser === true || limits.show_browser === 'true';

    const meta2 = PIPELINE_META[pipelineId] || { stages: [] };
    const stageLabels = (meta2.stages || []).map(s => meta2.stageLabels?.[s] || s).join(' → ');

    root.innerHTML = `
      <div id="run-confirm-overlay" style="position:fixed;inset:0;z-index:3000;display:grid;place-items:center;padding:20px;background:rgba(2,6,23,0.78);animation:fadeIn 200ms ease">
        <div style="width:min(560px,100%);max-height:88vh;display:flex;flex-direction:column;border-radius:20px;
          background:linear-gradient(180deg,rgba(15,23,42,0.98),rgba(15,23,42,0.92));
          border:1px solid rgba(148,163,184,0.2);box-shadow:0 24px 80px rgba(0,0,0,0.4)">
          <div style="display:flex;align-items:center;justify-content:space-between;padding:18px 24px;border-bottom:1px solid rgba(148,163,184,0.12)">
            <div>
              <h3 style="margin:0;font-size:17px;font-weight:700;color:#f8fafc">${meta.icon || '▶'} Run "${gtss.escapeHtml(pipeline.name)}"</h3>
              <p style="margin:4px 0 0;font-size:12px;color:#94a3b8">${stageLabels}</p>
            </div>
            <button id="rc-close" type="button" style="width:32px;height:32px;border-radius:999px;border:1px solid rgba(148,163,184,0.2);background:rgba(148,163,184,0.06);color:#94a3b8;cursor:pointer;font-size:16px;display:grid;place-items:center">✕</button>
          </div>
          <div class="scroll-y" style="flex:1;overflow-y:auto;padding:20px 24px;display:flex;flex-direction:column;gap:16px">
            <div id="rc-settings-summary" style="font-size:13px;color:#cbd5e1;display:flex;flex-direction:column;gap:6px">
              ${renderRunSettingsSummary(pipelineId, limits)}
            </div>
            ${launchesBrowser ? `
            <div style="padding:12px 14px;border-radius:10px;background:rgba(15,23,42,0.5);border:1px solid rgba(148,163,184,0.18);display:flex;align-items:center;justify-content:space-between;gap:12px">
              <div>
                <div style="font-size:13px;font-weight:700;color:#e2e8f0">Show browser window</div>
                <div style="font-size:11px;color:#94a3b8;margin-top:2px">If ON, the automation browser will be visible (headed). If OFF, it runs headless in the background.</div>
              </div>
              <label style="position:relative;display:inline-block;width:46px;height:24px;cursor:pointer;flex-shrink:0">
                <input type="checkbox" id="rc-show-browser" ${showBrowser ? 'checked' : ''} style="opacity:0;width:0;height:0">
                <span id="rc-browser-slider" style="position:absolute;inset:0;border-radius:999px;transition:all 200ms;background:${showBrowser ? '#22c55e' : 'rgba(148,163,184,0.3)'};box-shadow:${showBrowser ? '0 0 12px rgba(34,197,94,0.3)' : 'none'}">
                  <span style="position:absolute;top:3px;${showBrowser ? 'right:3px' : 'left:3px'};width:18px;height:18px;border-radius:999px;background:#fff;transition:all 200px;box-shadow:0 2px 6px rgba(0,0,0,0.2)"></span>
                </span>
              </label>
            </div>` : ''}
            <div style="padding:10px 14px;border-radius:10px;background:rgba(56,189,248,0.06);border:1px solid rgba(56,189,248,0.2);font-size:12px;color:#7dd3fc;line-height:1.5">
              ℹ️ Clicking <strong>Confirm &amp; Run</strong> will apply these settings for this run. To make them permanent, use the <strong>Save</strong> button on the pipeline card.
            </div>
          </div>
          <div style="display:flex;gap:10px;padding:16px 24px;border-top:1px solid rgba(148,163,184,0.12);justify-content:flex-end">
            <button id="rc-cancel" type="button" style="padding:10px 18px;border-radius:10px;border:1px solid rgba(148,163,184,0.2);background:rgba(148,163,184,0.06);color:#94a3b8;font-size:13px;font-weight:600;cursor:pointer">Cancel</button>
            <button id="rc-confirm" type="button" style="padding:10px 22px;border-radius:10px;border:1px solid rgba(34,197,94,0.4);background:rgba(34,197,94,0.16);color:#4ade80;font-size:13px;font-weight:700;cursor:pointer">▶ Confirm &amp; Run</button>
          </div>
        </div>
      </div>
    `;

    const overlay = document.getElementById('run-confirm-overlay');
    const cleanup = (val) => { root.innerHTML = ''; resolve(val); };

    const closeBtn = document.getElementById('rc-close');
    const cancelBtn = document.getElementById('rc-cancel');
    const confirmBtn = document.getElementById('rc-confirm');
    const showBrowserCb = document.getElementById('rc-show-browser');
    const showBrowserSlider = document.getElementById('rc-browser-slider');

    closeBtn.addEventListener('click', () => cleanup(null));
    cancelBtn.addEventListener('click', () => cleanup(null));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(null); });

    if (showBrowserCb) {
      showBrowserCb.addEventListener('change', () => {
        showBrowser = showBrowserCb.checked;
        if (showBrowserSlider) {
          showBrowserSlider.style.background = showBrowser ? '#22c55e' : 'rgba(148,163,184,0.3)';
          showBrowserSlider.style.boxShadow = showBrowser ? '0 0 12px rgba(34,197,94,0.3)' : 'none';
          const knob = showBrowserSlider.querySelector('span');
          if (knob) {
            knob.style.left = showBrowser ? '' : '3px';
            knob.style.right = showBrowser ? '3px' : '';
          }
        }
      });
    }

    confirmBtn.addEventListener('click', () => {
      // Build the limits payload from the current pipeline limits + the
      // show_browser override. We don't re-read the card's form fields here
      // because the modal is a review surface — the user edits on the card
      // and clicks Save there. The modal's show_browser toggle is the one
      // override that applies to this run only.
      const payload = { limits: { ...limits } };
      if (launchesBrowser) {
        payload.limits.show_browser = showBrowser;
      }
      cleanup(payload);
    });
  });
}

/**
 * Render a compact, read-only summary of the pipeline's current settings for
 * the pre-run confirmation modal.
 */
function renderRunSettingsSummary(pipelineId, limits) {
  const meta = PIPELINE_META[pipelineId] || {};
  const parts = [];
  const platforms = Array.isArray(limits.platforms) ? limits.platforms : [];
  if (platforms.length > 0) {
    parts.push(`<div><span style="color:#64748b;font-weight:700">Platforms:</span> ${platforms.map(p => gtss.formatPlatformLabel(p)).join(', ')}</div>`);
  }
  for (const field of (meta.limitFields || [])) {
    if (field.type === 'per_platform') continue; // too verbose for the summary
    let val = limits[field.key] !== undefined ? limits[field.key] : field.default;
    if (val === '' || val === undefined || val === null) {
      if (field.key === 'topic') {
        parts.push(`<div style="color:#fbbf24"><span style="color:#64748b;font-weight:700">Topic:</span> ⚠ not set — set a topic on the card before running</div>`);
      }
      continue;
    }
    const label = field.label.split(' (')[0]; // shorten
    let displayVal = val;
    if (field.type === 'select' && (val === true || val === false)) displayVal = val ? 'true' : 'false';
    parts.push(`<div><span style="color:#64748b;font-weight:700">${gtss.escapeHtml(label)}:</span> ${gtss.escapeHtml(String(displayVal))}</div>`);
  }
  if (parts.length === 0) parts.push('<div style="color:#64748b">No configurable settings for this pipeline.</div>');
  return parts.join('');
}
