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

var { fetchJSON, showToast, getSocket } = window.gtss;

// ---- State ----
var currentFilter = "all";
var currentSort = "score_desc";
var currentPage = 1;
var pageLimit = 20;
var totalLeads = 0;
var selectedIds = new Set();
var openDrawerLead = null;
var activeSocketHandler = null;
var activeJobId = null;
var cachedLeads = [];

// ---- DOM refs ----
var statPending = document.getElementById("stat-pending");
var statQualified = document.getElementById("stat-qualified");
var statDeprioritized = document.getElementById("stat-deprioritized");
var statOverridden = document.getElementById("stat-overridden");
var statScoringFailed = document.getElementById("stat-scoring-failed");
var tabPending = document.getElementById("tab-pending");
var tabApproved = document.getElementById("tab-approved");
var tabRejected = document.getElementById("tab-rejected");
var tabOverridden = document.getElementById("tab-overridden");
var tabScoringFailed = document.getElementById("tab-scoring-failed");

var runAllBtn = document.getElementById("run-all-btn");
var stopQualificationBtn = document.getElementById("stop-qualification-btn");
var manualActionsMenu = document.getElementById("manual-actions-menu");
var manualActionsTrigger = document.getElementById(
  "manual-actions-trigger",
);
var manualActionsDropdown = document.getElementById(
  "manual-actions-dropdown",
);
var manualQualifyAllBtn = document.getElementById("manual-qualify-all-btn");
var manualQualifySelectedBtn = document.getElementById(
  "manual-qualify-selected-btn",
);
var retryFailedBtn = document.getElementById("retry-failed-btn");
var progressPanel = document.getElementById("progress-panel");
var progressFill = document.getElementById("progress-fill");
var progressText = document.getElementById("progress-text");
var progressLabelText = document.getElementById("progress-label-text");

var filterTabs = document.getElementById("filter-tabs");
var sortSelect = document.getElementById("sort-select");
var totalBadge = document.getElementById("total-badge");
var leadsBody = document.getElementById("leads-body");
var emptyState = document.getElementById("empty-state");
var bulkBar = document.getElementById("bulk-bar");
var bulkCount = document.getElementById("bulk-count");
var bulkApprove = document.getElementById("bulk-approve");
var bulkReject = document.getElementById("bulk-reject");
var selectAll = document.getElementById("select-all");
var prevPage = document.getElementById("prev-page");
var nextPage = document.getElementById("next-page");
var pageLabel = document.getElementById("page-label");

// Drawer refs
var drawerOverlay = document.getElementById("drawer-overlay");
var drawer = document.getElementById("drawer");
var drawerClose = document.getElementById("drawer-close");
var drawerName = document.getElementById("drawer-name");
var drawerPlatformBadge = document.getElementById("drawer-platform-badge");
var drawerScoreBadge = document.getElementById("drawer-score-badge");
var drawerRole = document.getElementById("drawer-role");
var drawerCompany = document.getElementById("drawer-company");
var drawerLocation = document.getElementById("drawer-location");
var drawerWebsite = document.getElementById("drawer-website");
var drawerProfileUrl = document.getElementById("drawer-profile-url");
var drawerReasoning = document.getElementById("drawer-reasoning");
var drawerScoreInput = document.getElementById("drawer-score-input");
var drawerSaveScore = document.getElementById("drawer-save-score");
var drawerNotes = document.getElementById("drawer-notes");
var drawerManualQualify = document.getElementById("drawer-manual-qualify");
var drawerApprove = document.getElementById("drawer-approve");
var drawerReject = document.getElementById("drawer-reject");
var drawerSkip = document.getElementById("drawer-skip");
