/**
 * pipelines/formatHelpers.js — Date / duration formatting and small render
 * helpers (status badge, live dot, action button style, disabled attribute).
 *
 * Pure functions shared by the card renderers, the executions modal, and the
 * detail modal. They take a value and return an HTML string; they do not
 * touch the DOM directly.
 */

/* global gtss */

function formatDate(dateStr) {
  if (!dateStr) return 'Never';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return String(dateStr);
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit',
  });
}

function formatRelative(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '—';
  const diffMs = Date.now() - d.getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function formatDuration(ms) {
  if (ms === null || ms === undefined) return '—';
  const num = Number(ms);
  if (!Number.isFinite(num) || num < 0) return '—';
  if (num < 1000) return `${Math.round(num)}ms`;
  if (num < 60_000) return `${(num / 1000).toFixed(1)}s`;
  if (num < 3_600_000) return `${(num / 60_000).toFixed(1)}m`;
  return `${(num / 3_600_000).toFixed(2)}h`;
}

function formatUptime(ms) {
  if (!ms) return '—';
  return formatDuration(ms);
}

function statusBadge(state) {
  const meta = STATE_META[state] || STATE_META.idle;
  return `<span style="display:inline-flex;align-items:center;gap:5px;padding:4px 11px;border-radius:999px;font-size:11px;font-weight:700;background:${meta.bg};color:${meta.color};border:1px solid ${meta.color}33">${meta.icon} ${meta.label}</span>`;
}

function liveDot(state) {
  const cls = state === 'running' ? '' : state === 'failed' ? 'error' : state === 'paused' ? 'warn' : 'idle';
  return `<span class="live-dot ${cls}"></span>`;
}

function actionStyle(color, enabled = true) {
  const disabled = !enabled;
  return `padding:8px 14px;border-radius:10px;border:1px solid ${disabled ? 'rgba(100,116,139,0.2)' : color.border};
    background:${disabled ? 'rgba(100,116,139,0.08)' : color.bg};color:${disabled ? '#64748b' : color.text};font-size:12px;font-weight:600;
    cursor:${disabled ? 'not-allowed' : 'pointer'};opacity:${disabled ? '0.55' : '1'};transition:all 150ms`;
}

function disabledAttr(enabled) {
  return enabled ? '' : ' disabled aria-disabled="true"';
}
