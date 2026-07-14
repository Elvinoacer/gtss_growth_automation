/**
 * warmup-page.js — Page-specific logic for the Instagram Warmup page
 * (public/pages/instagram-warmup.html).
 *
 * Extracted verbatim from the original inline <script> block at the bottom
 * of instagram-warmup.html (lines 615–965). Loaded via <script src> after
 * the global /js/app.js so it can use the `gtss` shared API.
 */

      // ======================================================================
      // Geistactive Kanban Pipeline & Stats Logic
      // ======================================================================

      let currentPipelineData = [];
      let currentSettings = {};

      document.addEventListener("DOMContentLoaded", () => {
        // Toggle delay settings
        const btnToggleSettings = document.getElementById("btn-toggle-settings");
        const settingsPanel = document.getElementById("settings-panel");
        btnToggleSettings.addEventListener("click", () => {
          settingsPanel.classList.toggle("open");
        });

        // Save delay settings
        const btnSaveSettings = document.getElementById("btn-save-settings");
        btnSaveSettings.addEventListener("click", async () => {
          btnSaveSettings.disabled = true;
          btnSaveSettings.innerText = "Saving...";
          try {
            const formData = {};
            const inputs = document.getElementById("settings-form").querySelectorAll("input, select");
            inputs.forEach(input => {
              formData[input.name] = Number(input.value);
            });

            const res = await fetchJSON("/api/settings/instagram", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(formData)
            });

            if (res.success) {
              showToast("Instagram warmup delay settings saved!", "success");
              currentSettings = { ...currentSettings, ...formData };
            } else {
              showToast(res.error || "Failed to save settings.", "error");
            }
          } catch (err) {
            showToast("Failed to save settings: " + err.message, "error");
          } finally {
            btnSaveSettings.disabled = false;
            btnSaveSettings.innerText = "Save Delay Configurations";
          }
        });

        // Advance All Due Job Runner Trigger
        const btnAdvanceAll = document.getElementById("btn-advance-all");
        btnAdvanceAll.addEventListener("click", async () => {
          btnAdvanceAll.disabled = true;
          btnAdvanceAll.innerText = "⚡ Running Warmup Job...";
          showToast("Starting manual Instagram warmup runner...", "info");
          try {
            const res = await fetchJSON("/api/jobs/instagram-warmup/run", { method: "POST" });
            if (res.success) {
              showToast("Instagram warmup runner completed successfully!", "success");
              // Wait slightly before refreshing counts
              setTimeout(loadPipelineData, 1500);
            } else {
              showToast(res.error || "Runner failed to execute.", "error");
            }
          } catch (err) {
            showToast("Failed executing runner: " + err.message, "error");
          } finally {
            btnAdvanceAll.disabled = false;
            btnAdvanceAll.innerText = "⚡ Advance All Due";
          }
        });

        // Initialize Kanban Drop Listeners for modern dragging
        initializeKanbanDragAndDrop();

        // Initial Data Load
        loadPipelineData();
      });

      // Load all stats and cards from API
      async function loadPipelineData() {
        try {
          const data = await fetchJSON("/api/instagram/warmup-pipeline");
          if (data.success) {
            currentPipelineData = data.pipeline || [];
            currentSettings = data.settings || {};
            
            // Populate stats
            populateStats(data.stats);
            // Populate settings inputs
            populateSettings(data.settings);
            // Render columns
            renderKanbanBoard(currentPipelineData);
          } else {
            showToast(data.error || "Failed to load warmup data.", "error");
          }
        } catch (err) {
          showToast("Network error loading warmup data: " + err.message, "error");
        }
      }

      function populateStats(stats) {
        if (!stats) return;
        document.getElementById("stat-total").innerText = stats.total !== undefined ? stats.total : 0;
        document.getElementById("stat-dm-queue").innerText = stats.dm_ready !== undefined ? stats.dm_ready : 0;
        document.getElementById("stat-avg-days").innerText = stats.avg_warmup_days !== undefined ? stats.avg_warmup_days + "d" : "0d";
        document.getElementById("stat-completion-rate").innerText = stats.completionRate !== undefined ? stats.completionRate + "%" : "0%";
      }

      function populateSettings(settings) {
        if (!settings) return;
        Object.keys(settings).forEach(key => {
          const input = document.getElementById(key);
          if (input) {
            input.value = settings[key];
          }
        });
      }

      function getLeadInitials(name) {
        if (!name) return "IG";
        const parts = name.trim().split(/\s+/);
        if (parts.length >= 2) {
          return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
        }
        return name.slice(0, 2).toUpperCase();
      }

      function renderKanbanBoard(pipeline) {
        const columns = ["following", "story_viewed", "liked", "warmup_complete"];
        
        columns.forEach(colStatus => {
          const cardsContainer = document.getElementById(`cards-${colStatus}`);
          const countBadge = document.getElementById(`count-${colStatus}`);
          cardsContainer.innerHTML = "";

          // Filter leads matching this column status
          // 'pending' and 'following' are grouped under 'following' column
          const leads = pipeline.filter(lead => {
            if (colStatus === "following") {
              return lead.currentStatus === "pending" || lead.currentStatus === "following";
            }
            return lead.currentStatus === colStatus;
          });

          countBadge.innerText = leads.length;

          if (leads.length === 0) {
            cardsContainer.innerHTML = `
              <div class="column-empty">
                <span>📭</span>
                <span>No active leads here</span>
              </div>
            `;
            return;
          }

          leads.forEach(lead => {
            const card = document.createElement("div");
            card.className = "kanban-card";
            card.draggable = true;
            card.id = `card-${lead.sequenceId}`;
            card.dataset.sequenceId = lead.sequenceId;
            card.dataset.leadId = lead.leadId;
            card.dataset.status = lead.currentStatus;

            // HTML5 Drag and Drop events
            card.addEventListener("dragstart", handleDragStart);
            card.addEventListener("dragend", handleDragEnd);

            const initials = getLeadInitials(lead.displayName || lead.username);
            const formattedFollowers = Number(lead.followersCount).toLocaleString();

            card.innerHTML = `
              <div class="card-header">
                <div class="card-avatar">${initials}</div>
                <div class="card-meta">
                  <a class="card-handle" href="https://instagram.com/${lead.username}" target="_blank" rel="noopener noreferrer">@${lead.username}</a>
                  <span class="card-name" title="${lead.displayName || lead.username}">${lead.displayName || lead.username}</span>
                </div>
              </div>
              <div class="card-details">
                ${lead.company ? `<div class="card-detail-row"><span>Company</span><span style="font-weight:700">${lead.company}</span></div>` : ""}
                <div class="card-detail-row">
                  <span>Followers</span>
                  <span class="card-followers">${formattedFollowers}</span>
                </div>
                <div class="card-detail-row">
                  <span>Warmup Stage</span>
                  <span class="card-days">${lead.daysInStep} ${lead.daysInStep === 1 ? "day" : "days"} in step</span>
                </div>
              </div>
              <div class="card-actions">
                ${lead.canSkipToDm ? `<button class="card-btn skip" onclick="skipToDm(${lead.sequenceId}, event)">⚡ Skip to DM</button>` : ""}
                <button class="card-btn abandon" onclick="abandonWarmup(${lead.sequenceId}, event)">🚫 Abandon</button>
              </div>
            `;

            cardsContainer.appendChild(card);
          });
        });
      }

      // ======================================================================
      // Geistactive Optimistic Actions
      // ======================================================================

      async function skipToDm(sequenceId, event) {
        if (event) event.stopPropagation();

        const card = document.getElementById(`card-${sequenceId}`);
        if (!card) return;

        // Optimistic UI updates - move card immediately to DM Ready
        showToast("Moving prospect to DM Ready...", "info");
        moveCardToStatus(sequenceId, "warmup_complete");

        try {
          const res = await fetchJSON(`/api/instagram/warmup/${sequenceId}/skip`, { method: "POST" });
          if (res.success) {
            showToast("Prospect successfully skipped to DM Ready!", "success");
            // Reload full state in the background to ensure absolute consistency
            loadPipelineData();
          } else {
            showToast(res.error || "Failed to skip step.", "error");
            loadPipelineData(); // revert
          }
        } catch (err) {
          showToast("Failed skipping step: " + err.message, "error");
          loadPipelineData(); // revert
        }
      }

      async function abandonWarmup(sequenceId, event) {
        if (event) event.stopPropagation();

        const card = document.getElementById(`card-${sequenceId}`);
        if (!card) return;

        if (!confirm("Are you sure you want to abandon the warmup sequence for this prospect?")) {
          return;
        }

        // Animate fading card out
        card.style.opacity = "0";
        card.style.transform = "scale(0.9)";
        
        try {
          const res = await fetchJSON(`/api/instagram/warmup/${sequenceId}/abandon`, { method: "POST" });
          if (res.success) {
            showToast("Warmup sequence abandoned.", "success");
            // Remove from array and redraw
            currentPipelineData = currentPipelineData.filter(l => l.sequenceId !== sequenceId);
            recalculateStatsLocally();
            renderKanbanBoard(currentPipelineData);
          } else {
            showToast(res.error || "Failed to abandon warmup.", "error");
            loadPipelineData(); // revert
          }
        } catch (err) {
          showToast("Failed to abandon warmup: " + err.message, "error");
          loadPipelineData(); // revert
        }
      }

      // Moves a card status in memory and redraws columns dynamically
      function moveCardToStatus(sequenceId, nextStatus) {
        const leadIndex = currentPipelineData.findIndex(l => l.sequenceId === sequenceId);
        if (leadIndex === -1) return;

        currentPipelineData[leadIndex].currentStatus = nextStatus;
        if (nextStatus === "warmup_complete") {
          currentPipelineData[leadIndex].canSkipToDm = false;
        }

        recalculateStatsLocally();
        renderKanbanBoard(currentPipelineData);
      }

      // Recalculates stats values in memory to avoid lag
      function recalculateStatsLocally() {
        const activeLeads = currentPipelineData.filter(l => l.currentStatus !== "skipped");
        const dmQueueLeads = currentPipelineData.filter(l => l.currentStatus === "warmup_complete");
        
        document.getElementById("stat-total").innerText = activeLeads.length;
        document.getElementById("stat-dm-queue").innerText = dmQueueLeads.length;
      }

      // ======================================================================
      // HTML5 Drag and Drop Handlers
      // ======================================================================

      let draggedCardId = null;

      function handleDragStart(e) {
        draggedCardId = this.dataset.sequenceId;
        this.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", draggedCardId);
      }

      function handleDragEnd(e) {
        this.classList.remove("dragging");
        draggedCardId = null;
        
        // Remove drag-over highlights
        document.querySelectorAll(".kanban-column").forEach(col => {
          col.classList.remove("drag-over");
        });
      }

      function initializeKanbanDragAndDrop() {
        const columns = document.querySelectorAll(".kanban-column");
        
        columns.forEach(column => {
          column.addEventListener("dragover", (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            column.classList.add("drag-over");
          });

          column.addEventListener("dragleave", () => {
            column.classList.remove("drag-over");
          });

          column.addEventListener("drop", async (e) => {
            e.preventDefault();
            column.classList.remove("drag-over");
            
            const sequenceIdStr = e.dataTransfer.getData("text/plain");
            const sequenceId = Number(sequenceIdStr);
            const targetStatus = column.dataset.status;

            if (!sequenceId || !targetStatus) return;

            const lead = currentPipelineData.find(l => l.sequenceId === sequenceId);
            if (!lead) return;

            // Prevent redundant drop
            if (lead.currentStatus === targetStatus) return;

            // If drag drop into 'warmup_complete', trigger the skip to DM route
            if (targetStatus === "warmup_complete") {
              skipToDm(sequenceId);
            } else {
              // Standard Drag drop: only allow forward sequence or trigger skipped/info
              showToast("Use action buttons or drag directly into 'DM Ready' to complete warmup.", "info");
            }
          });
        });
      }
