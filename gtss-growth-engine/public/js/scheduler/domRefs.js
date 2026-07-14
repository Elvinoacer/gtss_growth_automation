/* global gtss */
/**
 * scheduler/domRefs.js — Cached DOM element references for the Content
 * Scheduler page.
 *
 * The original scheduler.js queried every DOM element at the top of its
 * DOMContentLoaded callback (lines 24-70 of the original). Because the
 * <script src="/js/scheduler.js"> tag lives at the END of
 * public/pages/content-scheduler.html, every element is already parsed by
 * the time this file runs, so the queries are safe at top-level.
 *
 * Each binding is a `const` so it lives in the shared global lexical
 * environment and is accessible by bare name from every other split file.
 */

// Composer
const postBody = $("post-body");
const charCounters = $("char-counters");
const scheduleDate = $("schedule-date");
const scheduleTime = $("schedule-time");
const postNowBtn = $("post-now-btn");
const scheduleBtn = $("schedule-btn");
const generateCaptionBtn = $("generate-caption-btn");
const aiTopic = $("ai-topic");
const mediaFileInput = $("media-file-input");
const mediaDropzone = $("media-dropzone");
const mediaPlaceholder = $("media-placeholder");
const mediaPreview = $("media-preview");
const mediaThumb = $("media-thumb");
const mediaFilename = $("media-filename");
const mediaRemoveBtn = $("media-remove-btn");

// Calendar / queue / pause
const calendarGrid = $("calendar-grid");
const weekRangeLabel = $("week-range-label");
const queueList = $("queue-list");
const queueCountBadge = $("queue-count-badge");
const pauseToggle = $("pause-toggle");
const pauseToggleDot = $("pause-toggle-dot");
const pauseBanner = $("pause-banner");
const schedulerStatusLabel = $("scheduler-status-label");

// Live log / published log
const liveLogPanel = $("live-log-panel");
const liveLogBody = $("live-log-body");
const publishedBody = $("published-body");

// AI image generation panel
const imageGenTopic = $("image-gen-topic");
const imageGenStyle = $("image-gen-style");
const imageGenPlatform = $("image-gen-platform");
const imageGenStartBtn = $("image-gen-start-btn");
const imageGenStatus = $("image-gen-status");
const imageGenOutput = $("image-gen-output");
const imageGenPrompt = $("image-gen-prompt");
const imageGenFile = $("image-gen-file");
const imageGenLog = $("image-gen-log");
const imageGenContext = $("image-gen-context");

// Instagram Custom DOM refs
const igPostOptions = $("ig-post-options");
const igCaptionHelper = $("ig-caption-helper");
const igPreviewBox = $("ig-preview-box");
const igHashtagRecommendation = $("ig-hashtag-recommendation");
const igStoryWarning = $("ig-story-warning");
const igCarouselPanel = $("ig-carousel-panel");
const carouselFileInput = $("carousel-file-input");
const carouselThumbnails = $("carousel-thumbnails");
