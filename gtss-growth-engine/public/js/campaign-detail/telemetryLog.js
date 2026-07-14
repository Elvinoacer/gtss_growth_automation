/**
 * campaign-detail/telemetryLog.js — Live telemetry log appender for the
 * "Terminal Log" stream container.
 *
 * Original campaign-detail.js was 684 lines; this is one of its thematic
 * splits.
 */

"use strict";

// Telemetry Log live appender
function appendTelemetryLog(logType, data) {
  const time = new Date(data.created_at || data.timestamp).toLocaleTimeString([], { hour12: false });
  const line = document.createElement("div");
  line.className = "flex gap-2.5 mb-1.5";

  if (logType === "event") {
    const colorMap = {
      connection_accepted: "text-green-400 font-bold",
      connection_sent: "text-primary-fixed-dim",
      dm_sent: "text-green-500 font-bold",
      dm_replied: "text-purple-400 font-black",
      connection_failed: "text-red-400 font-bold",
      dm_failed: "text-red-400 font-bold",
      connection_skipped: "text-slate-400"
    };

    const eventColorClass = colorMap[data.event_type] || "text-blue-400";
    const metaStr = data.metadata ? `: ${escapeHtml(data.metadata.error || data.metadata.reason || data.metadata.sentAt || "")}` : "";

    line.innerHTML = `
      <span class="text-slate-500 shrink-0">[${time}]</span>
      <span class="${eventColorClass} shrink-0 w-24 uppercase font-bold">${escapeHtml(data.event_type.replace("connection_", "conn_"))}</span>
      <span class="text-slate-200">
        Lead #${data.lead_id || "-"} ➔ ${escapeHtml(data.event_type.replace(/_/g, " "))}${metaStr}
      </span>
    `;
  } else {
    // Standard queue log format
    const levelColors = {
      ERROR: "text-red-500 font-bold",
      WARN: "text-orange-400 font-bold",
      INFO: "text-slate-400 font-semibold"
    };
    const color = levelColors[data.level] || "text-slate-300";

    line.innerHTML = `
      <span class="text-slate-500 shrink-0">[${time}]</span>
      <span class="${color} shrink-0 w-24 font-semibold uppercase">${data.queue || "QUEUE"}</span>
      <span class="text-slate-300">
        [Job #${data.jobId || "-"}] ${escapeHtml(data.message)}
      </span>
    `;
  }

  streamLogContainer.appendChild(line);

  if (streamAutoscroll.checked) {
    streamLogContainer.scrollTop = streamLogContainer.scrollHeight;
  }
}
