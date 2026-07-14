/* global gtss, io */
/**
 * settings/state.js — Constants + shared mutable state for the Settings page.
 *
 * Originally the top of public/js/settings.js. Holds:
 *   - variables            — array of template-variable badges (e.g.
 *                            {{lead_name}}) inserted by insertAtCursor.
 *   - settingsState        — the in-memory mirror of the /api/settings +
 *                            /api/settings/templates responses, plus the
 *                            currently-active template key and the
 *                            snapshot of the limits as last loaded from
 *                            the server (used by the "Reset Limits"
 *                            button).
 *   - pipelineState        — mirror of /api/settings/pipeline +
 *                            /api/discovery/keywords + /api/pipeline/runs
 *                            (consumed by the Pipeline section).
 *   - activePipelineRunId  — the runId of the in-flight pipeline run, or
 *                            null when no run is active (used by the
 *                            Abort/Pause/Resume buttons and by the
 *                            socket subscriber to filter events).
 *   - pipelineSocketSubscribed — guard so the pipeline:event socket
 *                            listener is only attached once per page
 *                            load (even if the user clicks Run Pipeline
 *                            multiple times).
 *   - previewData          — cached preview data for the Brand Context
 *                            preview modal (currently unused; reserved).
 *
 * This file MUST load first (before any other split file) because every
 * other file references these `let`/`const` bindings via the shared
 * global lexical environment of classic <script> tags.
 */

const variables = [
  "{{lead_name}}",
  "{{company}}",
  "{{role}}",
  "{{location}}",
  "{{product}}",
  "{{product_tagline}}",
  "{{pain_point}}",
  "{{value_prop}}",
  "{{sender_name}}",
  "{{sign_off}}",
  "{{cta}}",
  "{{biz_name}}",
];
let settingsState = {
  settings: {},
  templates: {},
  activeTemplate: "",
  loadedLimits: {},
};

// ---------------------------------------------------------------------------
// Pipeline Settings — state vars (declared here so they exist before
// pipelineSettings.js runs).
// ---------------------------------------------------------------------------

let pipelineState = {
  config: {},
  keywords: { keywords: [], platforms: [], maxLeadsPerKeyword: 10 },
  runs: [],
};
let activePipelineRunId = null;
let pipelineSocketSubscribed = false;

// ---------------------------------------------------------------------------
// Brand Context — preview modal state (declared here so it exists before
// context.js runs).
// ---------------------------------------------------------------------------

let previewData = null;
