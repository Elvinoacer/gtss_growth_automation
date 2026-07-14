/**
 * settings/scrollspy.js — Settings nav scrollspy.
 *
 * Originally part of public/js/settings.js. Holds
 * initSettingsNavScrollspy() — highlights the active section in the
 * settings nav as the user scrolls. Uses IntersectionObserver to track
 * which section is in view and toggles the .active class on the matching
 * nav link. Falls back to click-only highlighting when IntersectionObserver
 * is unavailable. Also wires up smooth-scroll on nav-link click (avoids
 * the sticky topbar obscuring the section heading) and updates the URL
 * hash without jumping.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Scrollspy — highlights the active section in the settings nav as the user
// scrolls. Uses IntersectionObserver to track which section is in view and
// toggles the .active class on the matching nav link.
// ─────────────────────────────────────────────────────────────────────────────

function initSettingsNavScrollspy() {
  const navLinks = document.querySelectorAll(".settings-nav a[data-section]");
  if (!navLinks.length) return;
  const sections = Array.from(navLinks)
    .map((link) => document.getElementById(link.dataset.section))
    .filter(Boolean);

  if (!("IntersectionObserver" in window) || !sections.length) {
    // Fallback: just highlight on click
    navLinks.forEach((link) => {
      link.addEventListener("click", () => {
        navLinks.forEach((l) => l.classList.remove("active"));
        link.classList.add("active");
      });
    });
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          const id = entry.target.id;
          navLinks.forEach((link) => {
            const isActive = link.dataset.section === id;
            link.classList.toggle("active", isActive);
            if (isActive) {
              link.setAttribute("aria-current", "true");
            } else {
              link.removeAttribute("aria-current");
            }
          });
        }
      });
    },
    {
      // Trigger when section's top crosses ~30% from the top of the viewport
      rootMargin: "-30% 0px -60% 0px",
      threshold: 0,
    },
  );

  sections.forEach((section) => observer.observe(section));

  // Smooth scroll on click (don't rely on browser default hash behavior,
  // because the sticky topbar would obscure the section heading)
  navLinks.forEach((link) => {
    link.addEventListener("click", (event) => {
      const id = link.dataset.section;
      const target = document.getElementById(id);
      if (!target) return;
      event.preventDefault();
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      // Update URL hash without jumping
      history.replaceState(null, "", `#${id}`);
      // Focus the section heading for screen readers
      const heading = target.querySelector("h2");
      if (heading) {
        heading.setAttribute("tabindex", "-1");
        heading.focus({ preventScroll: true });
      }
    });
  });
}
