/**
 * crm/loadLeads.js — Fetch the leads list from /api/crm/leads and trigger a
 * re-render.
 *
 * Original crm.js was 578 lines; this is one of its thematic splits.
 */

"use strict";

async function loadLeads() {
  try {
    leads = await fetchJSON("/api/crm/leads");
    render();
  } catch (e) {
    showToast("Failed to load CRM data.", "error");
  }
}
