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

const { fetchJSON, showToast, initSocket, getSocket } = window.gtss;

// State
let activeJobId = null;
let isAutomationRunning = false;
let socketSub = null;
let sessionStatus = {}; // { platform: bool } — true = session active
let cachedLimits = null; // last loaded limits object, used for re-render

// DOM Refs
const runAllBtn = document.getElementById("run-all-btn");
const stopBtn = document.getElementById("stop-btn");
const queueBody = document.getElementById("queue-body");
const logContainer = document.getElementById("log-container");
const logAutoScroll = document.getElementById("log-autoscroll");
const logClearBtn = document.getElementById("log-clear-btn");
const emptyState = document.getElementById("empty-state");
const limitCards = document.getElementById("limit-cards");
const queueSummary = document.getElementById("queue-summary");
const postRunBanner = document.getElementById("post-run-banner");
const postRunBannerText = document.getElementById("post-run-banner-text");
const postRunBannerMeta = document.getElementById("post-run-banner-meta");
const retryAllBtn = document.getElementById("retry-all-btn");
const retrySelectedBtn = document.getElementById("retry-selected-btn");
const queueSelectAll = document.getElementById("queue-select-all");
const retryWaitingBtn = document.getElementById("retry-waiting-btn");
const retryBlockedBtn = document.getElementById("retry-blocked-btn");
const domCapturePlatform = document.getElementById("dom-capture-platform");
const domCapturePipeline = document.getElementById("dom-capture-pipeline");
const domCaptureTab = document.getElementById("dom-capture-tab");
const domCaptureLabel = document.getElementById("dom-capture-label");
const domCaptureRefreshTabs = document.getElementById("dom-capture-refresh-tabs");
const domCaptureSave = document.getElementById("dom-capture-save");
const domCaptureStatus = document.getElementById("dom-capture-status");
const domCaptureList = document.getElementById("dom-capture-list");
const domCaptureRefreshList = document.getElementById("dom-capture-refresh-list");

const captchaBanner = document.getElementById("captcha-banner");
const captchaPlatformText = document.getElementById("captcha-platform-text");
const manualOpenBtn = document.getElementById("manual-open-btn");
const manualResumeBtn = document.getElementById("manual-resume-btn");
let currentCaptchaPlatform = null;
let selectedRetryIds = new Set();
