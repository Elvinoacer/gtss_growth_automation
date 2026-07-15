/**
 * campaign-detail/state.js — Shared constants, state, and DOM refs for the
 * Campaign Detail & Telemetry page.
 *
 * Loaded first by campaign-detail.js (the document.write loader). All shared
 * top-level `const`/`let` bindings and DOM references live here so every
 * subsequently-loaded split file can reference them by bare name (they
 * resolve via the global lexical environment shared by classic <script>
 * tags).
 *
 * Original campaign-detail.js was 684 lines wrapped in an IIFE; this is one
 * of its thematic splits. The IIFE was removed because classic scripts share
 * the global lexical environment, which is exactly what the original closure
 * provided.
 */

"use strict";

/* global gtss, io */

// Shared API from app.js (loaded before this file via the HTML)
var { fetchJSON, showToast, initSocket, getSocket } = window.gtss;

// Campaign ID comes from server-injected page data
var campaignId = Number(window.__PAGE_DATA__ && window.__PAGE_DATA__.campaignId);

// ── Mutable state ───────────────────────────────────────────────────────────
var campaign = null;
var connPage = 1;
var dmPage = 1;
var jobsLimit = 10;
var connTotalPages = 1;
var dmTotalPages = 1;
var isCheckingLock = false;

// ── DOM Refs: header ────────────────────────────────────────────────────────
var titleEl = document.getElementById("campaign-title");
var platformBadge = document.getElementById("campaign-platform-badge");
var statusBadge = document.getElementById("campaign-status-badge");
var lockDot = document.getElementById("lock-dot");
var lockText = document.getElementById("lock-text");

// ── DOM Refs: actions ───────────────────────────────────────────────────────
var pauseResumeBtn = document.getElementById("pause-resume-btn");
var pauseResumeIcon = document.getElementById("pause-resume-icon");
var pauseResumeText = document.getElementById("pause-resume-text");
var stopQueueBtn = document.getElementById("stop-queue-btn");
var stopQueueIcon = document.getElementById("stop-queue-icon");
var stopQueueText = document.getElementById("stop-queue-text");
var runConnectionBtn = document.getElementById("run-connection-btn");
var runDmBtn = document.getElementById("run-dm-btn");

// True while the campaign connection/DM queue is busy (lock or in-progress).
var queueBusy = false;
// Prevents double-click storms while a stop request is in flight.
var isStoppingQueue = false;

// ── DOM Refs: progress widgets ──────────────────────────────────────────────
var connectionsCircle = document.getElementById("connections-svg-circle");
var connectionsPctText = document.getElementById("connections-pct-text");
var connectionsRatioText = document.getElementById("connections-ratio-text");

var dmsCircle = document.getElementById("dms-svg-circle");
var dmsPctText = document.getElementById("dms-pct-text");
var dmsRatioText = document.getElementById("dms-ratio-text");

// ── DOM Refs: stat counters ─────────────────────────────────────────────────
var statConnTotal = document.getElementById("stat-conn-total");
var statConnSent = document.getElementById("stat-conn-sent");
var statConnSkipped = document.getElementById("stat-conn-skipped");
var statConnFailed = document.getElementById("stat-conn-failed");
var statConnPending = document.getElementById("stat-conn-pending");

var statDmTotal = document.getElementById("stat-dm-total");
var statDmSent = document.getElementById("stat-dm-sent");
var statDmReplied = document.getElementById("stat-dm-replied");
var statDmFailed = document.getElementById("stat-dm-failed");
var statDmPending = document.getElementById("stat-dm-pending");

// ── DOM Refs: tabs ──────────────────────────────────────────────────────────
var tabConnectionsBtn = document.getElementById("tab-connections-btn");
var tabDmsBtn = document.getElementById("tab-dms-btn");
var tabConnectionsContent = document.getElementById("tab-connections-content");
var tabDmsContent = document.getElementById("tab-dms-content");

// ── DOM Refs: tables ────────────────────────────────────────────────────────
var connectionsTableBody = document.getElementById("connections-table-body");
var connEmpty = document.getElementById("conn-table-empty");
var dmsTableBody = document.getElementById("dms-table-body");
var dmsEmpty = document.getElementById("dms-table-empty");

// ── DOM Refs: paging ────────────────────────────────────────────────────────
var connPagInfo = document.getElementById("conn-pag-info");
var connPrevBtn = document.getElementById("conn-prev-btn");
var connNextBtn = document.getElementById("conn-next-btn");

var dmsPagInfo = document.getElementById("dms-pag-info");
var dmsPrevBtn = document.getElementById("dms-prev-btn");
var dmsNextBtn = document.getElementById("dms-next-btn");

// ── DOM Refs: telemetry log ─────────────────────────────────────────────────
var streamLogContainer = document.getElementById("stream-log-container");
var clearStreamBtn = document.getElementById("clear-stream-btn");
var streamAutoscroll = document.getElementById("stream-autoscroll");
