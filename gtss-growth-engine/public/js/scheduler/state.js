/* global gtss, io */
/**
 * scheduler/state.js — Shared state for the Content Scheduler page.
 *
 * Declares every shared `const`/`let` binding FIRST so all other split files
 * in the scheduler/ subdirectory can reference them by bare name at parse
 * time. The original scheduler.js was a single DOMContentLoaded callback
 * ~1,313 lines long; this file hoists its top-of-callback declarations into
 * the global lexical environment shared by classic <script> tags.
 *
 * Exposes (via global scope):
 *   - gtss API destructured from window.gtss: fetchJSON, showToast, getSocket
 *   - LIMITS, PLATFORM_COLORS — platform char limits and brand colors
 *   - Mutable state: currentWeekStart, uploadedMediaPath,
 *     uploadedMediaFilePath, editingPostId, editingPostMedia, isPaused,
 *     carouselFiles, schedulerContext
 *   - `$` — document.getElementById shorthand
 *   - dragSrcEl — module-private holder for carousel drag-and-drop source
 */

const { fetchJSON, showToast, getSocket } = window.gtss;

// Platform char limits for posts
const LIMITS = { x: 280, linkedin: 3000, facebook: 63206, instagram: 2200 };
const PLATFORM_COLORS = {
  linkedin: "#0A66C2",
  x: "#000000",
  facebook: "#1877F2",
  instagram: "#E4405F",
};

// `getMonday` is defined here (rather than in helpers.js) because the
// `currentWeekStart` initializer below calls it at top-level parse time —
// helpers.js loads AFTER state.js, so a function declared there would not
// yet exist when state.js runs its top-level statements.
function getMonday(d) {
  const date = new Date(d);
  const day = date.getDay();
  const diff = date.getDate() - day + (day === 0 ? -6 : 1);
  date.setDate(diff);
  date.setHours(0, 0, 0, 0);
  return date;
}

// State
let currentWeekStart = getMonday(new Date());
let uploadedMediaPath = null;
let uploadedMediaFilePath = null;
let editingPostId = null;
let editingPostMedia = null;
let isPaused = false;
let carouselFiles = []; // array of { id, file, path, filePath }
let schedulerContext = null;

// DOM lookup helper (kept here so all split files can use it without
// re-declaring).
const $ = (id) => document.getElementById(id);

// Carousel drag-and-drop source element holder — mutated by handleDragStart /
// handleDrop in instagram.js. Kept here so both functions share the same
// binding (the original `let dragSrcEl` lived inside the DOMContentLoaded
// closure; here it lives in the global lexical environment).
let dragSrcEl = null;
