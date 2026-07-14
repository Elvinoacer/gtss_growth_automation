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

const { fetchJSON, showToast, getSocket } = window.gtss;

// ---- State ----
let currentFilter = "all";
let currentPlatform = "";
let currentSearch = "";
let currentPage = 1;
const pageLimit = 20;
let totalMessages = 0;
let cachedMessages = [];
let activeSocketCleanup = null;
let charLimits = {};
let platformCatalog = [];
let platformLabels = {};
let defaultPlatform = "";
let pipelineConfig = {};

// Settings state
let selectedTone = "friendly";
let selectedProduct = "Restaurant Manager";

// Modal state
let modalLeadId = null;
let modalVariantA = null; // { id, body }
let modalVariantB = null;

// ---- DOM refs ----
const statPending = document.getElementById("stat-pending");
const statApproved = document.getElementById("stat-approved");
const statSent = document.getElementById("stat-sent");
const statSkipped = document.getElementById("stat-skipped");
const statFollowups = document.getElementById("stat-followups");
const statUnscoredQualified = document.getElementById(
  "stat-unscored-qualified",
);
const unscoredQualifiedNote = document.getElementById(
  "unscored-qualified-note",
);
const tabPending = document.getElementById("tab-pending");
const tabApprovedCount = document.getElementById("tab-approved");
const tabSent = document.getElementById("tab-sent");
const tabFollowups = document.getElementById("tab-followups");

const generateAllBtn = document.getElementById("generate-all-btn");
const progressPanel = document.getElementById("progress-panel");
const progressFill = document.getElementById("progress-fill");
const progressText = document.getElementById("progress-text");
const progressLabelText = document.getElementById("progress-label-text");

const filterTabs = document.getElementById("filter-tabs");
const platformFilter = document.getElementById("platform-filter");
const searchInput = document.getElementById("search-input");
const totalBadge = document.getElementById("total-badge");
const msgBody = document.getElementById("msg-body");
const emptyState = document.getElementById("empty-state");
const prevPage = document.getElementById("prev-page");
const nextPage = document.getElementById("next-page");
const pageLabel = document.getElementById("page-label");

// Modal refs
const modalOverlay = document.getElementById("modal-overlay");
const modalTitle = document.getElementById("modal-title");
const modalSub = document.getElementById("modal-sub");
const modalClose = document.getElementById("modal-close");
const modalCloseBtn = document.getElementById("modal-close-btn");
const ctxName = document.getElementById("ctx-name");
const ctxRole = document.getElementById("ctx-role");
const ctxCompany = document.getElementById("ctx-company");
const ctxPlatform = document.getElementById("ctx-platform");
const ctxScore = document.getElementById("ctx-score");
const ctxReasoning = document.getElementById("ctx-reasoning");
const ctxNotes = document.getElementById("ctx-notes");
const variantATextarea = document.getElementById("variant-a-textarea");
const variantBTextarea = document.getElementById("variant-b-textarea");
const charCounterA = document.getElementById("char-counter-a");
const charCounterB = document.getElementById("char-counter-b");
const modalApproveA = document.getElementById("modal-approve-a");
const modalApproveB = document.getElementById("modal-approve-b");
const modalRegenerate = document.getElementById("modal-regenerate");
const modalSkip = document.getElementById("modal-skip");
const regenLoading = document.getElementById("regen-loading");

// Settings refs
const settingsToggle = document.getElementById("settings-toggle");
const settingsPanel = document.getElementById("settings-panel");
const toneGroup = document.getElementById("tone-group");
const productGroup = document.getElementById("product-group");
const customPitchGroup = document.getElementById("custom-pitch-group");
const customPitchInput = document.getElementById("custom-pitch-input");
