/**
 * dashboard/quickStart.js — Onboarding Quick Start card dismissal.
 *
 * initQuickStartDismissal() — persists the user's choice to hide the
 * onboarding Quick Start card via localStorage so they don't see it
 * again on subsequent visits. The real-time session validity panel
 * (renderSessions) is untouched.
 *
 * Behavior:
 *   - If previously dismissed (localStorage gtss_quick_start_dismissed
 *     === "true"), hide the section immediately with no animation.
 *   - Otherwise, inject a "✕ Dismiss" button into the quick-start
 *     header actions row. Clicking it sets the localStorage flag,
 *     runs a fade-out + collapse animation (opacity + translateY +
 *     maxHeight → 0 + margin/padding/border → 0), and finally sets
 *     display:none after 320ms. Toasts a confirmation.
 *
 * Called from init() on DOMContentLoaded.
 *
 * Cross-file dependencies (call-time only): showToast (state.js).
 */

// ── Quick Start Dismissal ──
function initQuickStartDismissal() {
  const section = document.getElementById("quick-start-section");
  if (!section) return;

  // Hide immediately if previously dismissed — no animation, just gone.
  if (localStorage.getItem("gtss_quick_start_dismissed") === "true") {
    section.style.display = "none";
    return;
  }

  // Inject a "✕ Dismiss" button into the quick-start header actions row.
  const actionsHost = section.querySelector("#quick-start-header-actions");
  if (!actionsHost) return;

  const dismissBtn = document.createElement("button");
  dismissBtn.type = "button";
  dismissBtn.id = "quick-start-dismiss";
  dismissBtn.className =
    "focus-ring inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-slate-300 transition-colors hover:bg-white/10 hover:text-white";
  dismissBtn.setAttribute("aria-label", "Dismiss Quick Start guide");
  dismissBtn.innerHTML =
    '<span class="material-symbols-outlined text-[16px]" aria-hidden="true">close</span> Dismiss';

  dismissBtn.addEventListener("click", () => {
    localStorage.setItem("gtss_quick_start_dismissed", "true");
    // Fade-out then collapse.
    section.style.transition =
      "opacity 220ms ease, transform 220ms ease, max-height 240ms ease 40ms, margin 240ms ease 40ms, padding 240ms ease 40ms, border 240ms ease 40ms";
    section.style.opacity = "0";
    section.style.transform = "translateY(-8px)";
    // Collapse height to avoid leaving a tall empty box during the fade.
    const prevHeight = section.offsetHeight;
    section.style.maxHeight = `${prevHeight}px`;
    // Force reflow so the transition from maxHeight -> 0 picks up.
    void section.offsetHeight;
    section.style.maxHeight = "0px";
    section.style.marginTop = "0px";
    section.style.marginBottom = "0px";
    section.style.paddingTop = "0px";
    section.style.paddingBottom = "0px";
    section.style.borderTopWidth = "0px";
    section.style.borderBottomWidth = "0px";
    section.style.overflow = "hidden";

    window.setTimeout(() => {
      section.style.display = "none";
    }, 320);

    if (typeof showToast === "function") {
      showToast("Quick Start hidden — revisit anytime from the dashboard", "success");
    }
  });

  actionsHost.appendChild(dismissBtn);
}
