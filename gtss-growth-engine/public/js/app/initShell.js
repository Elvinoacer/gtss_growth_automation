function initShell() {
  const sidebar = document.getElementById("gtss-sidebar");
  const toggle = document.getElementById("gtss-sidebar-toggle");
  const pageTitle = document.getElementById("gtss-page-title");
  const notificationButton = document.getElementById(
    "gtss-notification-button",
  );
  const notificationDropdown = document.getElementById(
    "gtss-notification-dropdown",
  );
  const storedCollapsed =
    localStorage.getItem("gtss.sidebar.collapsed") === "true";

  if (sidebar && storedCollapsed) {
    sidebar.classList.add("collapsed");
    document.body.classList.add("gtss-sidebar-collapsed");
  }

  if (pageTitle && document.body.dataset.pageTitle) {
    pageTitle.textContent = document.body.dataset.pageTitle;
  }

  const pageSubtitle = document.getElementById("gtss-page-subtitle");
  if (pageSubtitle) {
    const subtitles = {
      Dashboard: "Live command center for growth operations",
      "Lead Discovery": "Find, filter, and route new prospects",
      Qualification: "Score leads and prioritize outreach",
      "Lead Qualification": "Score leads and prioritize outreach",
      "Message Generator": "Generate and review campaign-ready messaging",
      Automation: "Control sessions, queues, and safety limits",
      Campaigns: "Manage active outreach sequences",
      "CRM Pipeline": "Track opportunities from reply to close",
      "Content Scheduler": "Plan posts and campaign assets",
      Pipelines: "Schedule repeatable growth workflows",
      Monitoring: "Observe throughput, health, and failures",
      Settings: "Configure channels, AI, limits, and security",
      "Asset Library": "Organize reusable creative and copy",
      "Audit Log": "Review operator and automation activity",
      "Instagram Warmup": "Safely warm Instagram leads before outreach",
    };
    pageSubtitle.textContent = subtitles[document.body.dataset.pageTitle] || "Operator console ready";
  }

  document.querySelectorAll(".gtss-nav__link").forEach((link) => {
    const route = link.dataset.route;
    const active =
      route === "/"
        ? window.location.pathname === "/"
        : window.location.pathname.startsWith(route);
    link.classList.toggle("active", active);
    if (active) {
      link.setAttribute("aria-current", "page");
    } else {
      link.removeAttribute("aria-current");
    }
  });

  if (toggle && sidebar) {
    const syncToggleAria = (collapsed) => {
      toggle.setAttribute("aria-expanded", String(!collapsed));
      toggle.setAttribute(
        "aria-label",
        collapsed ? "Expand sidebar" : "Collapse sidebar",
      );
      toggle.setAttribute("title", collapsed ? "Expand sidebar (Ctrl+B)" : "Collapse sidebar (Ctrl+B)");
    };
    syncToggleAria(sidebar.classList.contains("collapsed"));
    toggle.addEventListener("click", () => {
      const collapsed = !sidebar.classList.contains("collapsed");
      sidebar.classList.toggle("collapsed", collapsed);
      document.body.classList.toggle("gtss-sidebar-collapsed", collapsed);
      localStorage.setItem("gtss.sidebar.collapsed", String(collapsed));
      syncToggleAria(collapsed);
    });
    // Keyboard shortcut: Ctrl/Cmd + B toggles the sidebar.
    document.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") {
        event.preventDefault();
        toggle.click();
      }
    });
  }

  // Sidebar version display (best-effort, non-blocking).
  const sidebarVersion = document.getElementById("gtss-sidebar-version");
  if (sidebarVersion) {
    window
      .gtss?.fetchJSON?.("/api/settings")
      .then((data) => {
        if (data && data.appVersion) {
          sidebarVersion.textContent = `v${data.appVersion}`;
        }
      })
      .catch(() => {
        /* silent — version is a nicety, not critical */
      });
  }

  if (notificationButton && notificationDropdown) {
    notificationButton.addEventListener("click", () => {
      const isOpen = notificationDropdown.classList.toggle("open");
      notificationButton.setAttribute("aria-expanded", String(isOpen));
    });
    document.addEventListener("click", (event) => {
      if (
        !notificationDropdown.contains(event.target) &&
        !notificationButton.contains(event.target)
      ) {
        notificationDropdown.classList.remove("open");
        notificationButton.setAttribute("aria-expanded", "false");
      }
    });
  }

  updateSessionDots();
  updateActionBadge();

  // Initialize socket connection on DOMContentLoaded
  getSocket();

  // Fallback polling only if socket isn't available (reduced frequency)
  window.setInterval(updateSessionDots, 120000);
  window.setInterval(updateActionBadge, 120000);
}
