/**
 * crm/state.js — Shared state, DOM refs, and constants for the CRM Kanban
 * & List page.
 *
 * Loaded first by crm.js (the document.write loader). All shared top-level
 * `const`/`let` bindings and the DOM-refs object live here so every
 * subsequently-loaded split file can reference them by bare name (they
 * resolve via the global lexical environment shared by classic <script>
 * tags).
 *
 * Original crm.js was 578 lines wrapped in a DOMContentLoaded callback; this
 * is one of its thematic splits. The DOMContentLoaded wrapper was removed
 * because the script tag is at the end of <body>, so all DOM elements are
 * already parsed by the time state.js runs (the document.write loader
 * executes synchronously during parse, and state.js is the first split file
 * it loads).
 */

"use strict";

/* global gtss, io */

// Shared API from app.js (loaded before this file via the HTML)
const { fetchJSON, showToast, getSocket } = window.gtss;

// ── State ───────────────────────────────────────────────────────────────────
let leads = [];
let currentView = "kanban";
let currentDrawerLeadId = null;
let platformLabels = {};

// DOM Elements
const els = {
  viewKanbanBtn: document.getElementById("view-kanban-btn"),
  viewListBtn: document.getElementById("view-list-btn"),
  viewKanban: document.getElementById("view-kanban"),
  viewList: document.getElementById("view-list"),
  searchInput: document.getElementById("search-input"),
  platformFilter: document.getElementById("platform-filter"),
  detectRepliesBtn: document.getElementById("detect-replies-btn"),

  // Drawer
  drawer: document.getElementById("lead-drawer"),
  backdrop: document.getElementById("drawer-backdrop"),
  closeDrawerBtn: document.getElementById("close-drawer-btn"),
  drawerName: document.getElementById("drawer-name"),
  drawerRoleCompany: document.getElementById("drawer-role-company"),
  drawerPlatform: document.getElementById("drawer-platform"),
  drawerProfileUrl: document.getElementById("drawer-profile-url"),
  drawerNotes: document.getElementById("drawer-notes"),
  notesSavedIndicator: document.getElementById("notes-saved-indicator"),
  drawerTimeline: document.getElementById("drawer-timeline"),
  drawerActionSelect: document.getElementById("drawer-action-select"),
  actionMeetingFields: document.getElementById("action-meeting-fields"),
  meetingDate: document.getElementById("meeting-date"),
  meetingNotes: document.getElementById("meeting-notes"),
  saveActionBtn: document.getElementById("save-action-btn"),

  // Stats
  statTotal: document.getElementById("stat-total"),
  statReplyDays: document.getElementById("stat-reply-days"),
  statConvertDays: document.getElementById("stat-convert-days"),
  statConvRate: document.getElementById("stat-conv-rate"),

  listBody: document.getElementById("list-body"),
};

// Columns configuration
const STATUSES = [
  "messaged",
  "replied",
  "meeting_booked",
  "converted",
  "lost",
];
