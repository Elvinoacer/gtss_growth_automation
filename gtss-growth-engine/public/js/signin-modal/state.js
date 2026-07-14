/**
 * signin-modal/state.js — Shared constants and mutable state for the
 * platform sign-in modal that lives on the dashboard ("/").
 *
 * Loaded first by signin-modal.js (the document.write loader). All shared
 * top-level `const`/`let` bindings live here so every subsequently-loaded
 * split file can reference them by bare name (they resolve via the global
 * lexical environment shared by classic <script> tags).
 *
 * Original signin-modal.js was 656 lines wrapped in an IIFE; this is one of
 * its thematic splits. The IIFE was removed because classic scripts share
 * the global lexical environment, which is exactly what the original closure
 * provided.
 */

"use strict";

// The bridge port must match desktop/main/bridge-server.js
// (DEFAULT_PORT = 9224). We try a small list of ports in case 9224 was
// taken and the bridge auto-incremented.
const BRIDGE_PORTS = [9224, 9225, 9226, 9227];
let bridgeBase = null;
let bridgeChecked = false;

// ─── Platform definitions ──────────────────────────────────────────────
//
// Mirrors the list in desktop/main/bridge-server.js. We keep a local
// copy so the modal can render instantly without waiting for the
// bridge's /state response (we still cross-check against the bridge's
// `platforms` field when it arrives).
//
// `serverKeys` lists the keys the server-side /api/sessions/details
// endpoint might use for the same platform. The automation engine
// uses `gemini` for Gemini (see src/automation/geminiWeb.js) while the
// bridge uses `google`; we accept either so the modal reflects the
// right state regardless of which flow last touched the session.
const PLATFORMS = [
  {
    key: "google",
    label: "Google / Gemini",
    icon: "G",
    iconBg: "#4285f4",
    required: true,
    hint: "Open Gemini and sign in with your Google account. Needed for AI image generation.",
    serverKeys: ["google", "gemini"],
    geminiNote: true,
  },
  {
    key: "linkedin",
    label: "LinkedIn",
    icon: "in",
    iconBg: "#0077b5",
    required: true,
    hint: "Open LinkedIn and sign in. Needed for LinkedIn outreach.",
    serverKeys: ["linkedin"],
  },
  {
    key: "facebook",
    label: "Facebook",
    icon: "f",
    iconBg: "#1877f2",
    required: false,
    hint: "Open Facebook and sign in.",
    serverKeys: ["facebook"],
  },
  {
    key: "x",
    label: "X (Twitter)",
    icon: "𝕏",
    iconBg: "#000000",
    required: false,
    hint: "Open X and sign in.",
    serverKeys: ["x", "twitter"],
  },
  {
    key: "instagram",
    label: "Instagram",
    icon: "IG",
    iconBg: "#e1306c",
    required: false,
    hint: "Open Instagram and sign in. Needed for Instagram warmup & posting.",
    serverKeys: ["instagram"],
  },
];

// Runtime session/dismiss state
let sessionState = {};
let signinCompleted = false;
let modalDismissed = false;
let pollTimer = null;
let modalEl = null;
