/* global gtss, io */
/**
 * discovery/state.js — Shared mutable state + top-level consts for the
 * Discovery page.
 *
 * The original discovery.js was a single classic <script> ~863 lines long
 * (NOT an IIFE — every `let`/`const`/`function` was a top-level global).
 * This file hoists the top-of-file declarations (discovery state object,
 * platform-labels map, keyword-groups cache, discovery-platform-key set)
 * into the global lexical environment shared by the discovery/ split
 * files. The other split files add more functions and consts of their
 * own; the load order is fixed by discovery.js (the loader).
 *
 * Exposes (via global scope):
 *   - discoveryState            — central mutable state object:
 *       { page, limit (const), total, selectedIds, currentJobId,
 *         currentPlatforms, eventSource }
 *   - platformLabels            — map of platform key → display label,
 *       populated by loadPlatformControls (in platformControls.js)
 *   - keywordGroups             — cache of saved keyword groups, populated
 *       by loadKeywordSelector (in keywordSelector.js)
 *   - DISCOVERY_PLATFORM_KEYS   — Set of platform keys the discovery page
 *       is allowed to scan (linkedin, x, facebook, instagram); used to
 *       filter the global platform catalog
 */

const discoveryState = {
  page: 1,
  limit: 20,
  total: 0,
  selectedIds: new Set(),
  currentJobId: null,
  currentPlatforms: [],
  eventSource: null,
};

let platformLabels = {};
let keywordGroups = [];
const DISCOVERY_PLATFORM_KEYS = new Set(["linkedin", "x", "facebook", "instagram"]);
