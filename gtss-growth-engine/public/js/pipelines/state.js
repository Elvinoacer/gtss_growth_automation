/**
 * pipelines/state.js — Shared constants & mutable state for the Pipelines page.
 *
 * Loaded first by pipelines.js (the document.write loader). All constants and
 * top-level state variables live here so every other split file can reference
 * them by bare name (they resolve via the global lexical environment for
 * let/const, or via window for explicit assignments).
 *
 * Original pipelines.js was ~2,955 lines; this is one of its thematic splits.
 */

/* global gtss, io */

// ── Constants ─────────────────────────────────────────────────────────────────

const CRON_PRESETS = [
  { label: 'Every 30 min',     cron: '*/30 * * * *', desc: 'Runs at the top and bottom of every hour' },
  { label: 'Every Hour',       cron: '0 * * * *',    desc: 'Runs at the top of every hour' },
  { label: 'Every 2 Hours',    cron: '0 */2 * * *',  desc: 'Runs every 2 hours' },
  { label: 'Every 4 Hours',    cron: '0 */4 * * *',  desc: 'Runs every 4 hours' },
  { label: 'Every 6 Hours',    cron: '0 */6 * * *',  desc: 'Runs every 6 hours' },
  { label: 'Daily at 8 AM',    cron: '0 8 * * *',    desc: 'Once a day at 8:00 AM' },
  { label: 'Daily at 9 AM',    cron: '0 9 * * *',    desc: 'Once a day at 9:00 AM' },
  { label: 'Weekdays at 8 AM', cron: '0 8 * * 1-5',  desc: 'Mon-Fri at 8:00 AM' },
  { label: 'Custom',           cron: null,            desc: 'Type your own cron expression' },
];

const PIPELINE_META = {
  outreach: {
    icon: '🔵',
    color: '#3b82f6',
    stages: ['discovery', 'qualification', 'messages', 'send'],
    stageLabels: { discovery: 'Discovery', qualification: 'Qualification', messages: 'Messages', send: 'Send' },
    limitFields: [
      { key: 'max_leads_per_keyword', label: 'Max leads per keyword', type: 'number', default: 10 },
      { key: 'max_dms_per_run', label: 'Max DMs per run', type: 'number', default: 20 },
      { key: 'max_connections_per_run', label: 'Max connections per run', type: 'number', default: 15 },
    ],
    platformField: true,
  },
  content: {
    icon: '🟠',
    color: '#f59e0b',
    stages: ['image_gen', 'caption_gen', 'post_record', 'publish'],
    stageLabels: { image_gen: 'Image Gen', caption_gen: 'Caption', post_record: 'Post Draft', publish: 'Publish' },
    limitFields: [
      { key: 'topic', label: 'Content Topic', type: 'text', default: '' },
      { key: 'style', label: 'Image Style', type: 'select', options: ['photorealistic', 'illustration', 'minimalist', 'abstract', 'cinematic'], default: 'photorealistic' },
      { key: 'max_posts_per_run', label: 'Posts per run', type: 'number', default: 1 },
    ],
    platformField: true,
  },
  dm_check: {
    icon: '🟢',
    color: '#22c55e',
    stages: ['scan'],
    stageLabels: { scan: 'Inbox Scan' },
    limitFields: [
      { key: 'active_hours_start', label: 'Active start hour', type: 'number', default: 8 },
      { key: 'active_hours_end', label: 'Active end hour', type: 'number', default: 22 },
      { key: 'timezone', label: 'Timezone', type: 'text', default: 'Africa/Nairobi' },
      { key: 'prompt', label: 'Response prompt', type: 'text', default: '' },
    ],
    platformField: true,
  },
  mass_follow: {
    icon: '🟣',
    color: '#a855f7',
    stages: ['select_targets', 'follow', 'report'],
    stageLabels: { select_targets: 'Select Targets', follow: 'Follow', report: 'Report' },
    limitFields: [
      { key: 'max_follows_per_run', label: 'Max follows per run (global ceiling)', type: 'number', default: 20 },
      { key: 'max_follows_per_platform', label: 'Per-platform max follows', type: 'per_platform', default: {} },
      { key: 'follow_interval_min_seconds', label: 'Follow interval — min (sec)', type: 'number', default: 40 },
      { key: 'follow_interval_max_seconds', label: 'Follow interval — max (sec)', type: 'number', default: 110 },
      { key: 'max_retries_per_target', label: 'Max retries per target', type: 'number', default: 3 },
      { key: 'respect_active_window', label: 'Respect platform active window', type: 'select', options: ['true', 'false'], default: 'true' },
      { key: 'skip_already_following', label: 'Skip already-following', type: 'select', options: ['true', 'false'], default: 'true' },
      { key: 'auto_import_leads', label: 'Auto-import leads from Discovery', type: 'select', options: ['true', 'false'], default: 'true' },
      { key: 'show_browser', label: 'Show browser window (visible)', type: 'select', options: ['false', 'true'], default: 'false' },
    ],
    platformField: true,
    isMassFollow: true,
  },
};

const ALL_PLATFORMS = ['instagram', 'linkedin', 'x', 'facebook'];

// Whether X / Instagram are allowed for lead discovery + outreach DMs.
// Loaded from GET /api/pipelines. Default false until the API responds.
let xDmOutreachEnabled = false;
let igDmOutreachEnabled = false;

const STATE_META = {
  idle:       { color: '#94a3b8', bg: 'rgba(148,163,184,0.12)', icon: '○', label: 'Idle' },
  scheduled:  { color: '#38bdf8', bg: 'rgba(56,189,248,0.12)',  icon: '◷', label: 'Scheduled' },
  running:    { color: '#38bdf8', bg: 'rgba(56,189,248,0.18)',  icon: '▶', label: 'Running' },
  paused:     { color: '#f59e0b', bg: 'rgba(245,158,11,0.15)',  icon: 'Ⅱ', label: 'Paused' },
  resuming:   { color: '#fbbf24', bg: 'rgba(251,191,36,0.15)',  icon: '↻', label: 'Resuming' },
  stopping:   { color: '#f87171', bg: 'rgba(248,113,113,0.15)', icon: '■', label: 'Stopping' },
  stopped:    { color: '#cbd5e1', bg: 'rgba(148,163,184,0.14)', icon: '■', label: 'Stopped' },
  completed:  { color: '#22c55e', bg: 'rgba(34,197,94,0.15)',   icon: '✓', label: 'Completed' },
  failed:     { color: '#f87171', bg: 'rgba(248,113,113,0.18)', icon: '✗', label: 'Failed' },
  retrying:   { color: '#a78bfa', bg: 'rgba(167,139,250,0.15)', icon: '↻', label: 'Retrying' },
  disabled:   { color: '#64748b', bg: 'rgba(100,116,139,0.14)', icon: '○', label: 'Disabled' },
};

// ── Shared mutable state ─────────────────────────────────────────────────────
//
// These are the page-wide mutable variables that many functions read and write.
// They are declared with `let` at the top level so every split file can both
// read and reassign them by bare name (the bindings live in the global lexical
// environment, which is shared across all classic <script> tags).

let pipelinesData = [];
let healthData = {};
let activeLogsSub = null;
let expandedPipelines = new Set();

// ── Anti-flicker interaction guard state ─────────────────────────────────────
//
// Tracked here (rather than in interactionGuard.js) so they're guaranteed to
// exist before any other split file's top-level code runs.
let userInteracting = false;
let interactionGraceUntil = 0;

// ── Socket reload debounce state ─────────────────────────────────────────────
//
// `progressReloadTimer` is read and reset by scheduleProgressReload() in
// socket.js; declared here so the binding is shared.
let progressReloadTimer = null;

// ── Mass-Follow constants ────────────────────────────────────────────────────

const MASS_FOLLOW_PLATFORMS = ['instagram', 'x', 'linkedin', 'facebook'];
