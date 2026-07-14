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
 *     sessionStatus, cachedLimits, currentCaptchaPlatform, selectedRetryIds
 *   - Cached `const` DOM element references for every getElementById call
 *     in the original (run/stop buttons, queue body, log container, limit
 *     cards, queue summary, post-run banner, retry buttons, DOM-capture
 *     controls, captcha banner / manual open / manual resume)
 */

var { fetchJSON, showToast, initSocket, getSocket } = window.gtss;

// State
var activeJobId = null;
var isAutomationRunning = false;
var socketSub = null;
var sessionStatus = {}; // { platform: bool } — true = session active
var cachedLimits = null; // last loaded limits object, used for re-render

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
