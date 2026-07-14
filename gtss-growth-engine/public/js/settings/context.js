/**
 * settings/context.js — Brand Context section (Phase 1).
 *
 * Originally part of public/js/settings.js. Holds:
 *   - CTX_ARRAY_FIELDS / CTX_TEXT_FIELDS — the two whitelists of context
 *                                          field keys (arrays stored as
 *                                          multiline text; plain strings
 *                                          stored as-is).
 *   - loadContext()              — GET /api/context and populate the form.
 *   - populateContextForm(ctx)   — write every CTX_TEXT_FIELDS + CTX_ARRAY_FIELDS
 *                                  input + render the scoring-weights row.
 *   - renderScoringWeights(w)    — render the 5 scoring-weight inputs
 *                                  (business_type, location, business_size,
 *                                  completeness, recency) inside the
 *                                  #scoring-weights-row container.
 *   - collectContextPayload()    — read the form back into a payload object
 *                                  (with array fields split by newline).
 *   - saveContext()              — client-side weight-sum validation
 *                                  (must equal 100), then PATCH /api/context.
 *   - resetContextToDefaults()   — confirm-gated; POST /api/context/reset
 *                                  and re-populate the form.
 *   - openContextPreview()       — open the preview backdrop, fetch
 *                                  /api/context/preview, render the tab
 *                                  buttons + the first preview's text.
 *   - buildQualificationPreview(ctx)
 *   - buildMessagePreview(ctx)
 *   - buildCaptionPreview(ctx)
 *   - buildImagePreview(ctx)     — the 4 client-side preview builders. NOTE
 *                                  these are currently unused by
 *                                  openContextPreview (which fetches the
 *                                  server-rendered previews); they're
 *                                  retained for parity with the original
 *                                  file in case a future caller wants
 *                                  client-side previews.
 *
 * Depends on globals declared in state.js (previewData) + helpers.js (setInline).
 */

// ─────────────────────────────────────────────────────────────────────────────
// BRAND CONTEXT - Phase 1
// ─────────────────────────────────────────────────────────────────────────────

// Fields that are stored as arrays in the DB but edited as multiline text in the UI
const CTX_ARRAY_FIELDS = [
  "ctx_product_key_features",
  "ctx_product_pain_points",
  "ctx_audience_industries",
  "ctx_audience_geographies",
  "ctx_audience_exclude_industries",
  "ctx_content_post_themes",
];

// Fields that stay as plain strings
const CTX_TEXT_FIELDS = [
  "ctx_biz_name",
  "ctx_biz_description",
  "ctx_biz_industry",
  "ctx_biz_location",
  "ctx_biz_website",
  "ctx_product_name",
  "ctx_product_tagline",
  "ctx_product_description",
  "ctx_product_value_prop",
  "ctx_audience_ideal_profile",
  "ctx_audience_exclude_industries",
  "ctx_sender_name",
  "ctx_sender_full_name",
  "ctx_sender_role",
  "ctx_sender_sign_off",
  "ctx_content_tone",
  "ctx_content_language",
  "ctx_content_cta",
  "ctx_content_image_style",
];

async function loadContext() {
  try {
    const ctx = await window.gtss.fetchJSON("/api/context");
    populateContextForm(ctx);
  } catch (err) {
    console.error("Failed to load context:", err);
  }
}

function populateContextForm(ctx) {
  // Plain text fields
  CTX_TEXT_FIELDS.forEach((key) => {
    const el = document.getElementById(key);
    if (el && ctx[key] !== undefined) el.value = ctx[key];
  });

  // Array fields - join as one-per-line
  CTX_ARRAY_FIELDS.forEach((key) => {
    const el = document.getElementById(key);
    if (!el) return;
    const val = ctx[key];
    el.value = Array.isArray(val) ? val.join("\n") : val || "";
  });

  // Scoring weights - render mini input fields
  renderScoringWeights(ctx.ctx_audience_scoring_weights || {});
}

function renderScoringWeights(weights) {
  const container = document.getElementById("scoring-weights-row");
  if (!container) return;
  container.innerHTML = "";
  const labels = {
    business_type: "Business Type",
    location: "Location",
    business_size: "Business Size",
    completeness: "Profile Completeness",
    recency: "Activity Recency",
  };
  Object.entries(weights).forEach(([key, value]) => {
    const label = labels[key] || key;
    container.insertAdjacentHTML(
      "beforeend",
      `
      <label class="field" style="flex:0 0 auto;min-width:140px;">
        ${label} <span class="muted">/ 100</span>
        <input type="number" min="0" max="100" id="weight_${key}" value="${value}" style="width:80px;">
      </label>
    `,
    );
  });
}

function collectContextPayload() {
  const payload = {};

  // Plain text fields
  CTX_TEXT_FIELDS.forEach((key) => {
    const el = document.getElementById(key);
    if (el) payload[key] = el.value.trim();
  });

  // Array fields - split by newline, trim, filter empties
  CTX_ARRAY_FIELDS.forEach((key) => {
    const el = document.getElementById(key);
    if (el) {
      payload[key] = el.value
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  });

  // Scoring weights
  const weightKeys = [
    "business_type",
    "location",
    "business_size",
    "completeness",
    "recency",
  ];
  const weights = {};
  weightKeys.forEach((k) => {
    const el = document.getElementById(`weight_${k}`);
    if (el) weights[k] = Number(el.value) || 0;
  });
  payload.ctx_audience_scoring_weights = weights;

  return payload;
}

async function saveContext() {
  const resultEl = document.getElementById("context-result");
  const btn = document.getElementById("save-context-btn");
  try {
    btn.disabled = true;
    const payload = collectContextPayload();

    // Client-side weight validation
    const weightSum = Object.values(
      payload.ctx_audience_scoring_weights,
    ).reduce((s, v) => s + v, 0);
    if (weightSum !== 100) {
      resultEl.textContent = `Scoring weights must sum to 100 (currently ${weightSum})`;
      resultEl.className = "inline-result error";
      return;
    }

    const res = await window.gtss.fetchJSON("/api/context", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    resultEl.textContent = `Saved ${res.updated.length} fields ✓`;
    resultEl.className = "inline-result success";
    setTimeout(() => {
      resultEl.textContent = "";
      resultEl.className = "inline-result";
    }, 3000);
  } catch (err) {
    resultEl.textContent = err.message;
    resultEl.className = "inline-result error";
  } finally {
    btn.disabled = false;
  }
}

async function resetContextToDefaults() {
  if (
    !confirm(
      "Reset all context fields to built-in defaults? This cannot be undone.",
    )
  )
    return;
  const resultEl = document.getElementById("context-result");
  try {
    const res = await window.gtss.fetchJSON("/api/context/reset", {
      method: "POST",
    });
    populateContextForm(res.context);
    resultEl.textContent = "Reset to defaults ✓";
    resultEl.className = "inline-result success";
    setTimeout(() => {
      resultEl.textContent = "";
      resultEl.className = "inline-result";
    }, 3000);
  } catch (err) {
    resultEl.textContent = err.message;
    resultEl.className = "inline-result error";
  }
}

// Preview modal
async function openContextPreview() {
  const backdrop = document.getElementById("context-preview-backdrop");
  const tabsEl = document.getElementById("preview-tabs");
  const contentEl = document.getElementById("preview-content");
  backdrop.classList.add("visible");
  contentEl.textContent = "Loading preview...";
  tabsEl.innerHTML = "";

  try {
    const previews = await window.gtss.fetchJSON("/api/context/preview");
    const labelMap = {
      qualification: "Lead Qualification",
      messages: "Message Variables",
      caption: "Post Caption",
      image: "Image Generation",
    };

    Object.entries(previews).forEach(([key, text], i) => {
      const label = labelMap[key] || key;
      const btn = document.createElement("button");
      btn.className = "tab-button" + (i === 0 ? " active" : "");
      btn.textContent = label;
      btn.addEventListener("click", () => {
        tabsEl
          .querySelectorAll(".tab-button")
          .forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        contentEl.textContent = text;
      });
      tabsEl.appendChild(btn);
      if (i === 0) contentEl.textContent = text;
    });
  } catch (err) {
    contentEl.textContent = "Preview error: " + err.message;
  }
}

function buildQualificationPreview(ctx) {
  const industries = (ctx.ctx_audience_industries || []).join(", ");
  const geos = (ctx.ctx_audience_geographies || []).join(", ");
  const w = ctx.ctx_audience_scoring_weights || {};
  return `You are a lead qualification specialist for ${ctx.ctx_biz_name}, ${ctx.ctx_biz_description}

Ideal customer: ${ctx.ctx_audience_ideal_profile}

Score this lead from 0 to 100.

Scoring factors:
- Business type match (${industries}): ${w.business_type || 30} points
- Location (${geos}): ${w.location || 20} points
- Business size signals: ${w.business_size || 20} points
- Profile completeness: ${w.completeness || 15} points
- Activity recency: ${w.recency || 15} points`;
}

function buildMessagePreview(ctx) {
  return `Template variables resolved from context:
{{product}}       → ${ctx.ctx_product_name}
{{product_tagline}} → ${ctx.ctx_product_tagline}
{{pain_point}}    → ${(ctx.ctx_product_pain_points || [])[0] || ""}
{{value_prop}}    → ${ctx.ctx_product_value_prop}
{{sender_name}}   → ${ctx.ctx_sender_name}
{{sign_off}}      → ${ctx.ctx_sender_sign_off}
{{cta}}           → ${ctx.ctx_content_cta}
{{biz_name}}      → ${ctx.ctx_biz_name}`;
}

function buildCaptionPreview(ctx) {
  return `Write a social media caption for [platform] about: [topic]
Company: ${ctx.ctx_biz_name} — ${ctx.ctx_biz_description}
Product: ${ctx.ctx_product_name}
Tone: ${ctx.ctx_content_tone}
Target audience: ${ctx.ctx_audience_ideal_profile}
End with this call to action: ${ctx.ctx_content_cta}`;
}

function buildImagePreview(ctx) {
  return `You are a creative director for ${ctx.ctx_biz_name}, ${ctx.ctx_biz_description}
Write a detailed image-generation prompt for a [platform] post.

Topic: [topic]
Brand themes: ${(ctx.ctx_content_post_themes || []).join(", ")}
Visual style: ${ctx.ctx_content_image_style}
Target audience: ${ctx.ctx_audience_ideal_profile}
Location context: ${(ctx.ctx_audience_geographies || [])[0] || ""}`;
}
