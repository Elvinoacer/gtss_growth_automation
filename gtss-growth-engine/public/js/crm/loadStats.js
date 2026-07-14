/**
 * crm/loadStats.js — Fetch and render the CRM header stats (total leads,
 * avg days to reply / convert, conversion rate).
 *
 * Original crm.js was 578 lines; this is one of its thematic splits.
 */

"use strict";

async function loadStats() {
  try {
    const stats = await fetchJSON("/api/crm/stats");
    els.statTotal.textContent = stats.total;
    els.statReplyDays.textContent = stats.avgDaysToReply;
    els.statConvertDays.textContent = stats.avgDaysToConvert;
    els.statConvRate.textContent = `${stats.conversionRate}%`;
  } catch (e) {
    console.error("Error loading stats:", e);
  }
}
