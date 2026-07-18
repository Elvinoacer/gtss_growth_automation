/* global gtss, io */
/**
 * messages/state.js — Shared state + DOM refs for the Message Generator page.
 *
 * Declares every shared `const`/`let` binding FIRST so all other split files
 * in the messages/ subdirectory can reference them by bare name at parse
 * time. The original messages.js was a single IIFE ~886 lines long; this
 * file hoists the IIFE's top-of-body declarations (gtss API destructure,
 * mutable state vars, and every cached DOM-element reference) into the
 * global lexical environment shared by classic <script> tags.
 *
 * Exposes (via global scope):
 *   - gtss API destructured from window.gtss: fetchJSON, showToast, getSocket
 *   - List state: currentFilter, currentPlatform, currentSearch, currentPage,
 *     pageLimit (const), totalMessages, cachedMessages, activeSocketCleanup
 *   - Platform/limit state: charLimits, platformCatalog, platformLabels,
 *     defaultPlatform, pipelineConfig
 *   - Settings state: selectedTone, selectedProduct
 *   - Modal state: modalLeadId, modalVariantA, modalVariantB
 *   - Cached DOM-element references (stat/tab/progress/filter/table/modal/
 *     settings refs)
 */

var { fetchJSON, showToast, getSocket } = window.gtss;

// ---- State ----
var currentFilter = "all";
var currentPlatform = "";
var currentSearch = "";
var currentPage = 1;
var pageLimit = 20;
var totalMessages = 0;
var cachedMessages = [];
var activeSocketCleanup = null;
// True only while a bulk generate / retry job is actively running.
// Retry button is disabled solely because of this — never because the
// server count of fallbacks was 0 (that caused the "I still see Template
// rows but the button is grey" bug).
var isBulkGenRunning = false;
var charLimits = {};
var platformCatalog = [];
var platformLabels = {};
var defaultPlatform = "";
var pipelineConfig = {};

// Settings state
var selectedTone = "friendly";
var selectedProduct = "Restaurant Manager";

// Modal state
var modalLeadId = null;
var modalVariantA = null; // { id, body }
var modalVariantB = null;

// ---- DOM refs ----
var statPending = document.getElementById("stat-pending");
var statApproved = document.getElementById("stat-approved");
var statSent = document.getElementById("stat-sent");
var statSkipped = document.getElementById("stat-skipped");
var statFollowups = document.getElementById("stat-followups");
var statUnscoredQualified = document.getElementById(
  "stat-unscored-qualified",
);
var unscoredQualifiedNote = document.getElementById(
  "unscored-qualified-note",
);
var tabPending = document.getElementById("tab-pending");
var tabApprovedCount = document.getElementById("tab-approved");
var tabSent = document.getElementById("tab-sent");
var tabFollowups = document.getElementById("tab-followups");

var generateAllBtn = document.getElementById("generate-all-btn");
var retryFallbacksBtn = document.getElementById("retry-fallbacks-btn");
var retryFallbacksCount = document.getElementById("retry-fallbacks-count");
var progressPanel = document.getElementById("progress-panel");
var progressFill = document.getElementById("progress-fill");
var progressText = document.getElementById("progress-text");
var progressLabelText = document.getElementById("progress-label-text");

var filterTabs = document.getElementById("filter-tabs");
var platformFilter = document.getElementById("platform-filter");
var searchInput = document.getElementById("search-input");
var totalBadge = document.getElementById("total-badge");
var msgBody = document.getElementById("msg-body");
var emptyState = document.getElementById("empty-state");
var prevPage = document.getElementById("prev-page");
var nextPage = document.getElementById("next-page");
var pageLabel = document.getElementById("page-label");

// Modal refs
var modalOverlay = document.getElementById("modal-overlay");
var modalTitle = document.getElementById("modal-title");
var modalSub = document.getElementById("modal-sub");
var modalClose = document.getElementById("modal-close");
var modalCloseBtn = document.getElementById("modal-close-btn");
var ctxName = document.getElementById("ctx-name");
var ctxRole = document.getElementById("ctx-role");
var ctxCompany = document.getElementById("ctx-company");
var ctxPlatform = document.getElementById("ctx-platform");
var ctxScore = document.getElementById("ctx-score");
var ctxReasoning = document.getElementById("ctx-reasoning");
var ctxNotes = document.getElementById("ctx-notes");
var variantATextarea = document.getElementById("variant-a-textarea");
var variantBTextarea = document.getElementById("variant-b-textarea");
var charCounterA = document.getElementById("char-counter-a");
var charCounterB = document.getElementById("char-counter-b");
var modalApproveA = document.getElementById("modal-approve-a");
var modalApproveB = document.getElementById("modal-approve-b");
var modalRegenerate = document.getElementById("modal-regenerate");
var modalSkip = document.getElementById("modal-skip");
var regenLoading = document.getElementById("regen-loading");

// Settings refs
var settingsToggle = document.getElementById("settings-toggle");
var settingsPanel = document.getElementById("settings-panel");
var toneGroup = document.getElementById("tone-group");
var productGroup = document.getElementById("product-group");
var customPitchGroup = document.getElementById("custom-pitch-group");
var customPitchInput = document.getElementById("custom-pitch-input");
