/* global gtss, io */
/**
 * automation/state.js — Shared state for the Automation Control page.
 *
 * Declares every shared `const`/`let` binding FIRST so all other split
 * files in the automation/ subdirectory can reference them by bare name at
 * parse time. The original automation.js was a single IIFE ~963 lines
 * long; this file hoists its top-of-IIFE declarations into the global
 * lexical environment shared by classic <script> tags.
 *
 * Exposes (via global scope):
 *   - gtss API destructured from window.gtss: fetchJSON, showToast,
 *     initSocket, getSocket
 *   - Mutable state: activeJobId, isAutomationRunning, socketSub,
 *     sessionStatus, cachedLimits, currentCaptchaPlatform, selectedRetryIds,
 *     selectedTargetPlatforms (Set of platform keys for Run Queue filter)
 *   - Constants: TARGET_DM_PLATFORMS, PLATFORM_TARGET_STORAGE_KEY
 *   - Cached DOM element references (run/stop buttons, queue body, log
 *     container, limit cards, queue summary, post-run banner, retry buttons,
 *     platform target checkboxes, DOM-capture controls, captcha banner)
 */

var { fetchJSON, showToast, initSocket, getSocket } = window.gtss;

// Outreach platforms that can receive automated DMs from this page.
// Order matches the pipelines page for consistency.
var TARGET_DM_PLATFORMS = ["linkedin", "x", "instagram", "facebook"];
var PLATFORM_TARGET_STORAGE_KEY = "gtss.automation.targetPlatforms";

// State
var activeJobId = null;
var isAutomationRunning = false;
var socketSub = null;
var sessionStatus = {}; // { platform: bool } — true = session active
var cachedLimits = null; // last loaded limits object, used for re-render
// Selected platforms for Run Queue + queue table filter. Empty means none
// selected (run is blocked). Defaults to all TARGET_DM_PLATFORMS.
var selectedTargetPlatforms = new Set(TARGET_DM_PLATFORMS);
// Loaded on init from Settings — when false, platform is locked out of Run Queue.
var xDmOutreachEnabledForAutomation = false;
var igDmOutreachEnabledForAutomation = false;

// DOM Refs
var runAllBtn = document.getElementById("run-all-btn");
var stopBtn = document.getElementById("stop-btn");
var queueBody = document.getElementById("queue-body");
var logContainer = document.getElementById("log-container");
var logAutoScroll = document.getElementById("log-autoscroll");
var logClearBtn = document.getElementById("log-clear-btn");
var emptyState = document.getElementById("empty-state");
var limitCards = document.getElementById("limit-cards");
var queueSummary = document.getElementById("queue-summary");
var postRunBanner = document.getElementById("post-run-banner");
var postRunBannerText = document.getElementById("post-run-banner-text");
var postRunBannerMeta = document.getElementById("post-run-banner-meta");
var retryAllBtn = document.getElementById("retry-all-btn");
var retrySelectedBtn = document.getElementById("retry-selected-btn");
var queueSelectAll = document.getElementById("queue-select-all");
var retryWaitingBtn = document.getElementById("retry-waiting-btn");
var retryBlockedBtn = document.getElementById("retry-blocked-btn");
var platformTargetCheckboxes = document.getElementById(
  "platform-target-checkboxes",
);
var platformSelectAllBtn = document.getElementById("platform-select-all-btn");
var platformClearBtn = document.getElementById("platform-clear-btn");
var domCapturePlatform = document.getElementById("dom-capture-platform");
var domCapturePipeline = document.getElementById("dom-capture-pipeline");
var domCaptureTab = document.getElementById("dom-capture-tab");
var domCaptureLabel = document.getElementById("dom-capture-label");
var domCaptureRefreshTabs = document.getElementById("dom-capture-refresh-tabs");
var domCaptureSave = document.getElementById("dom-capture-save");
var domCaptureStatus = document.getElementById("dom-capture-status");
var domCaptureList = document.getElementById("dom-capture-list");
var domCaptureRefreshList = document.getElementById("dom-capture-refresh-list");

var captchaBanner = document.getElementById("captcha-banner");
var captchaPlatformText = document.getElementById("captcha-platform-text");
var manualOpenBtn = document.getElementById("manual-open-btn");
var manualResumeBtn = document.getElementById("manual-resume-btn");
var currentCaptchaPlatform = null;
var selectedRetryIds = new Set();
