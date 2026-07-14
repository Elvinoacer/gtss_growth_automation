/* global gtss, io */
/**
 * qualification/state.js — Shared state + DOM refs for the Lead
 * Qualification page.
 *
 * Declares every shared `const`/`let` binding FIRST so all other split
 * files in the qualification/ subdirectory can reference them by bare name
 * at parse time. The original qualification.js was a single IIFE ~864
 * lines long; this file hoists the IIFE's top-of-body declarations (gtss
 * API destructure, mutable state vars, and every cached DOM-element
 * reference) into the global lexical environment shared by classic
 * <script> tags.
 *
 * Exposes (via global scope):
 *   - gtss API destructured from window.gtss: fetchJSON, showToast, getSocket
 *   - List state: currentFilter, currentSort, currentPage, pageLimit (const),
 *     totalLeads, selectedIds, openDrawerLead, activeSocketHandler,
 *     activeJobId, cachedLeads
 *   - Cached DOM refs: stat-card / tab-counter refs, run-all +
 *     stop-qualification + manual-actions menu refs, progress-panel refs,
 *     filter-tabs / sort-select / total-badge / leads-body / empty-state /
 *     bulk-bar / bulk buttons / select-all / pagination refs, and every
 *     drawer-* ref (drawerOverlay, drawer, drawerClose, drawerName,
 *     drawerPlatformBadge, drawerScoreBadge, drawerRole, drawerCompany,
 *     drawerLocation, drawerWebsite, drawerProfileUrl, drawerReasoning,
 *     drawerScoreInput, drawerSaveScore, drawerNotes, drawerManualQualify,
 *     drawerApprove, drawerReject, drawerSkip)
 */

const { fetchJSON, showToast, getSocket } = window.gtss;

// ---- State ----
let currentFilter = "all";
let currentSort = "score_desc";
let currentPage = 1;
const pageLimit = 20;
let totalLeads = 0;
let selectedIds = new Set();
let openDrawerLead = null;
let activeSocketHandler = null;
let activeJobId = null;
let cachedLeads = [];

// ---- DOM refs ----
const statPending = document.getElementById("stat-pending");
const statQualified = document.getElementById("stat-qualified");
const statDeprioritized = document.getElementById("stat-deprioritized");
const statOverridden = document.getElementById("stat-overridden");
const statScoringFailed = document.getElementById("stat-scoring-failed");
const tabPending = document.getElementById("tab-pending");
const tabApproved = document.getElementById("tab-approved");
const tabRejected = document.getElementById("tab-rejected");
const tabOverridden = document.getElementById("tab-overridden");
const tabScoringFailed = document.getElementById("tab-scoring-failed");

const runAllBtn = document.getElementById("run-all-btn");
const stopQualificationBtn = document.getElementById("stop-qualification-btn");
const manualActionsMenu = document.getElementById("manual-actions-menu");
const manualActionsTrigger = document.getElementById(
  "manual-actions-trigger",
);
const manualActionsDropdown = document.getElementById(
  "manual-actions-dropdown",
);
const manualQualifyAllBtn = document.getElementById("manual-qualify-all-btn");
const manualQualifySelectedBtn = document.getElementById(
  "manual-qualify-selected-btn",
);
const retryFailedBtn = document.getElementById("retry-failed-btn");
const progressPanel = document.getElementById("progress-panel");
const progressFill = document.getElementById("progress-fill");
const progressText = document.getElementById("progress-text");
const progressLabelText = document.getElementById("progress-label-text");

const filterTabs = document.getElementById("filter-tabs");
const sortSelect = document.getElementById("sort-select");
const totalBadge = document.getElementById("total-badge");
const leadsBody = document.getElementById("leads-body");
const emptyState = document.getElementById("empty-state");
const bulkBar = document.getElementById("bulk-bar");
const bulkCount = document.getElementById("bulk-count");
const bulkApprove = document.getElementById("bulk-approve");
const bulkReject = document.getElementById("bulk-reject");
const selectAll = document.getElementById("select-all");
const prevPage = document.getElementById("prev-page");
const nextPage = document.getElementById("next-page");
const pageLabel = document.getElementById("page-label");

// Drawer refs
const drawerOverlay = document.getElementById("drawer-overlay");
const drawer = document.getElementById("drawer");
const drawerClose = document.getElementById("drawer-close");
const drawerName = document.getElementById("drawer-name");
const drawerPlatformBadge = document.getElementById("drawer-platform-badge");
const drawerScoreBadge = document.getElementById("drawer-score-badge");
const drawerRole = document.getElementById("drawer-role");
const drawerCompany = document.getElementById("drawer-company");
const drawerLocation = document.getElementById("drawer-location");
const drawerWebsite = document.getElementById("drawer-website");
const drawerProfileUrl = document.getElementById("drawer-profile-url");
const drawerReasoning = document.getElementById("drawer-reasoning");
const drawerScoreInput = document.getElementById("drawer-score-input");
const drawerSaveScore = document.getElementById("drawer-save-score");
const drawerNotes = document.getElementById("drawer-notes");
const drawerManualQualify = document.getElementById("drawer-manual-qualify");
const drawerApprove = document.getElementById("drawer-approve");
const drawerReject = document.getElementById("drawer-reject");
const drawerSkip = document.getElementById("drawer-skip");
