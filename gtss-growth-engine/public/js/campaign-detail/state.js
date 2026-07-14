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
const { fetchJSON, showToast, initSocket, getSocket } = window.gtss;

// Campaign ID comes from server-injected page data
const campaignId = Number(window.__PAGE_DATA__ && window.__PAGE_DATA__.campaignId);

// ── Mutable state ───────────────────────────────────────────────────────────
let campaign = null;
let connPage = 1;
let dmPage = 1;
const jobsLimit = 10;
let connTotalPages = 1;
let dmTotalPages = 1;
let isCheckingLock = false;

// ── DOM Refs: header ────────────────────────────────────────────────────────
const titleEl = document.getElementById("campaign-title");
const platformBadge = document.getElementById("campaign-platform-badge");
const statusBadge = document.getElementById("campaign-status-badge");
const lockDot = document.getElementById("lock-dot");
const lockText = document.getElementById("lock-text");

// ── DOM Refs: actions ───────────────────────────────────────────────────────
const pauseResumeBtn = document.getElementById("pause-resume-btn");
const pauseResumeIcon = document.getElementById("pause-resume-icon");
const pauseResumeText = document.getElementById("pause-resume-text");
const stopQueueBtn = document.getElementById("stop-queue-btn");
const stopQueueIcon = document.getElementById("stop-queue-icon");
const stopQueueText = document.getElementById("stop-queue-text");
const runConnectionBtn = document.getElementById("run-connection-btn");
const runDmBtn = document.getElementById("run-dm-btn");

// True while the campaign connection/DM queue is busy (lock or in-progress).
let queueBusy = false;
// Prevents double-click storms while a stop request is in flight.
let isStoppingQueue = false;

// ── DOM Refs: progress widgets ──────────────────────────────────────────────
const connectionsCircle = document.getElementById("connections-svg-circle");
const connectionsPctText = document.getElementById("connections-pct-text");
const connectionsRatioText = document.getElementById("connections-ratio-text");

const dmsCircle = document.getElementById("dms-svg-circle");
const dmsPctText = document.getElementById("dms-pct-text");
const dmsRatioText = document.getElementById("dms-ratio-text");

// ── DOM Refs: stat counters ─────────────────────────────────────────────────
const statConnTotal = document.getElementById("stat-conn-total");
const statConnAccepted = document.getElementById("stat-conn-accepted");
const statConnSent = document.getElementById("stat-conn-sent");
const statConnFailed = document.getElementById("stat-conn-failed");
const statConnPending = document.getElementById("stat-conn-pending");

const statDmTotal = document.getElementById("stat-dm-total");
const statDmSent = document.getElementById("stat-dm-sent");
const statDmReplied = document.getElementById("stat-dm-replied");
const statDmFailed = document.getElementById("stat-dm-failed");
const statDmPending = document.getElementById("stat-dm-pending");

// ── DOM Refs: tabs ──────────────────────────────────────────────────────────
const tabConnectionsBtn = document.getElementById("tab-connections-btn");
const tabDmsBtn = document.getElementById("tab-dms-btn");
const tabConnectionsContent = document.getElementById("tab-connections-content");
const tabDmsContent = document.getElementById("tab-dms-content");

// ── DOM Refs: tables ────────────────────────────────────────────────────────
const connectionsTableBody = document.getElementById("connections-table-body");
const connEmpty = document.getElementById("conn-table-empty");
const dmsTableBody = document.getElementById("dms-table-body");
const dmsEmpty = document.getElementById("dms-table-empty");

// ── DOM Refs: paging ────────────────────────────────────────────────────────
const connPagInfo = document.getElementById("conn-pag-info");
const connPrevBtn = document.getElementById("conn-prev-btn");
const connNextBtn = document.getElementById("conn-next-btn");

const dmsPagInfo = document.getElementById("dms-pag-info");
const dmsPrevBtn = document.getElementById("dms-prev-btn");
const dmsNextBtn = document.getElementById("dms-next-btn");

// ── DOM Refs: telemetry log ─────────────────────────────────────────────────
const streamLogContainer = document.getElementById("stream-log-container");
const clearStreamBtn = document.getElementById("clear-stream-btn");
const streamAutoscroll = document.getElementById("stream-autoscroll");
