/**
 * dashboard/renderStatCards.js — Top KPI row (totals + week-over-week delta).
 *
 * renderStatCards(l) — populates the stat-card grid from the `leads`
 * payload returned by /api/dashboard/stats: total leads, delta this
 * week (with emerald/slate color cue), qualified count + pct of
 * discovered, messaged count + this-week delta, replied count + reply
 * rate, meetings booked, converted count. Also writes the inline
 * variants of the delta / qualified-pct / replied / reply-rate cards
 * when present (the dashboard hero uses inline spans instead of the
 * larger stat cards for some metrics).
 *
 * Cross-file dependencies: $ (state.js).
 */

// ── Stat Cards ──
function renderStatCards(l) {
  const deltaPositive = l.deltaLastWeek > 0;
  const deltaClass = deltaPositive ? "text-emerald-300" : "text-slate-300";
  $("stat-total").textContent = l.total;
  $("stat-delta").textContent = deltaPositive
    ? `+${l.deltaLastWeek} this week`
    : `${l.deltaLastWeek} this week`;
  $("stat-delta").className = `mt-1 text-xs ${deltaClass}`;
  $("stat-qualified").textContent = l.qualified;
  $("stat-qualified-pct").textContent = `${l.qualifiedPct}% of discovered`;
  if ($("stat-qualified-inline")) {
    $("stat-qualified-inline").textContent = `${l.qualifiedPct}%`;
  }
  $("stat-messaged").textContent = l.messaged;
  $("stat-messaged-week").textContent = `${l.messagedThisWeek} this week`;
  $("stat-replied").textContent = l.replied;
  $("stat-reply-rate").textContent = `${l.replyRate}% reply rate`;
  if ($("stat-replied-inline")) {
    $("stat-replied-inline").textContent = l.replied;
  }
  if ($("stat-reply-rate-inline")) {
    $("stat-reply-rate-inline").textContent = `${l.replyRate}%`;
  }
  $("stat-meetings").textContent = l.meetingsBooked;
  $("stat-converted").textContent = l.converted;
  if ($("stat-delta-inline")) {
    $("stat-delta-inline").className = `text-3xl font-bold ${deltaClass}`;
    $("stat-delta-inline").textContent = deltaPositive
      ? `+${l.deltaLastWeek}`
      : `${l.deltaLastWeek}`;
  }
}
