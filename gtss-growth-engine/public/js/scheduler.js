document.addEventListener("DOMContentLoaded", () => {
  const { fetchJSON, showToast, getSocket } = window.gtss;

  // Platform char limits for posts
  const LIMITS = { x: 280, linkedin: 3000, facebook: 63206, instagram: 2200 };
  const PLATFORM_COLORS = {
    linkedin: "#0A66C2",
    x: "#000000",
    facebook: "#1877F2",
    instagram: "#E4405F",
  };

  // State
  let currentWeekStart = getMonday(new Date());
  let uploadedMediaPath = null;
  let uploadedMediaFilePath = null;
  let editingPostId = null;
  let editingPostMedia = null;
  let isPaused = false;
  let carouselFiles = []; // array of { id, file, path, filePath }

  // DOM refs
  const $ = (id) => document.getElementById(id);
  const postBody = $("post-body");
  const charCounters = $("char-counters");
  const scheduleDate = $("schedule-date");
  const scheduleTime = $("schedule-time");
  const postNowBtn = $("post-now-btn");
  const scheduleBtn = $("schedule-btn");
  const generateCaptionBtn = $("generate-caption-btn");
  const aiTopic = $("ai-topic");
  const mediaFileInput = $("media-file-input");
  const mediaDropzone = $("media-dropzone");
  const mediaPlaceholder = $("media-placeholder");
  const mediaPreview = $("media-preview");
  const mediaThumb = $("media-thumb");
  const mediaFilename = $("media-filename");
  const mediaRemoveBtn = $("media-remove-btn");
  const calendarGrid = $("calendar-grid");
  const weekRangeLabel = $("week-range-label");
  const queueList = $("queue-list");
  const queueCountBadge = $("queue-count-badge");
  const pauseToggle = $("pause-toggle");
  const pauseToggleDot = $("pause-toggle-dot");
  const pauseBanner = $("pause-banner");
  const schedulerStatusLabel = $("scheduler-status-label");
  const liveLogPanel = $("live-log-panel");
  const liveLogBody = $("live-log-body");
  const publishedBody = $("published-body");
  const imageGenTopic = $("image-gen-topic");
  const imageGenStyle = $("image-gen-style");
  const imageGenPlatform = $("image-gen-platform");
  const imageGenStartBtn = $("image-gen-start-btn");
  const imageGenStatus = $("image-gen-status");
  const imageGenOutput = $("image-gen-output");
  const imageGenPrompt = $("image-gen-prompt");
  const imageGenFile = $("image-gen-file");
  const imageGenLog = $("image-gen-log");

  // Instagram Custom DOM refs
  const igPostOptions = $("ig-post-options");
  const igCaptionHelper = $("ig-caption-helper");
  const igPreviewBox = $("ig-preview-box");
  const igHashtagRecommendation = $("ig-hashtag-recommendation");
  const igStoryWarning = $("ig-story-warning");
  const igCarouselPanel = $("ig-carousel-panel");
  const carouselFileInput = $("carousel-file-input");
  const carouselThumbnails = $("carousel-thumbnails");

  // Set default schedule to next rounded hour
  const now = new Date();
  now.setHours(now.getHours() + 1, 0, 0, 0);
  scheduleDate.value = formatLocalDateInput(now);
  scheduleTime.value = now.toTimeString().slice(0, 5);

  init();

  async function init() {
    bindEvents();
    await loadPauseState();
    await refreshSchedulerViews();

    setInterval(() => {
      refreshSchedulerViews();
    }, 60_000);
  }

  // ── Helpers ──

  function getMonday(d) {
    const date = new Date(d);
    const day = date.getDay();
    const diff = date.getDate() - day + (day === 0 ? -6 : 1);
    date.setDate(diff);
    date.setHours(0, 0, 0, 0);
    return date;
  }

  function getSelectedPlatforms() {
    return [...document.querySelectorAll(".platform-checkbox:checked")].map(
      (cb) => cb.value,
    );
  }

  function formatDate(d) {
    const months = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    return `${months[d.getMonth()]} ${d.getDate()}`;
  }

  function formatLocalDateInput(date) {
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0"),
    ].join("-");
  }

  function formatWeekRange(monday) {
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    return `${formatDate(monday)} – ${formatDate(sunday)}, ${monday.getFullYear()}`;
  }

  async function refreshSchedulerViews() {
    await Promise.allSettled([loadCalendar(), loadQueue()]);
  }

  // ── Character Counter ──

  function updateCharCounters() {
    const platforms = getSelectedPlatforms();
    const len = postBody.value.length;
    charCounters.innerHTML = "";
    if (platforms.length === 0) return;
    platforms.forEach((p) => {
      const limit = LIMITS[p] || 3000;
      const label = window.gtss.formatPlatformLabel(p) || p;
      const over = len > limit;
      const span = document.createElement("span");
      span.className = `flex items-center gap-1 ${over ? "text-error font-semibold" : ""}`;
      span.innerHTML = `<span class="material-symbols-outlined text-[14px]">${over ? "error" : "info"}</span> ${label}: ${len}/${limit}`;
      charCounters.appendChild(span);
    });
  }

  // ── Instagram Features ──

  function toggleInstagramOptions() {
    const platforms = getSelectedPlatforms();
    const hasIg = platforms.includes("instagram");
    if (hasIg) {
      igPostOptions.classList.remove("hidden");
      igCaptionHelper.classList.remove("hidden");
      updateInstagramCaptionHelper();
      const val =
        document.querySelector('input[name="ig-post-type"]:checked')?.value ||
        "feed";
      if (val === "story") {
        igStoryWarning.classList.remove("hidden");
        igCarouselPanel.classList.add("hidden");
        checkStoryAspectRatio();
      } else if (val === "carousel") {
        igStoryWarning.classList.add("hidden");
        igCarouselPanel.classList.remove("hidden");
      } else {
        igStoryWarning.classList.add("hidden");
        igCarouselPanel.classList.add("hidden");
      }
    } else {
      igPostOptions.classList.add("hidden");
      igCaptionHelper.classList.add("hidden");
    }
  }

  function updateInstagramCaptionHelper() {
    const text = postBody.value;
    if (!text.trim()) {
      igPreviewBox.innerHTML = `<span class="text-on-surface-variant italic">No caption drafted yet.</span>`;
    } else if (text.length <= 125) {
      igPreviewBox.innerHTML = `<span class="bg-primary/10 text-on-surface font-medium px-1 rounded">${text}</span>`;
    } else {
      const firstPart = text.slice(0, 125);
      const restPart = text.slice(125);
      igPreviewBox.innerHTML = `<span class="bg-primary/10 text-on-surface font-medium px-1 rounded">${firstPart}</span>${restPart}`;
    }

    const hashtagCount = (text.match(/#[a-zA-Z0-9_]+/g) || []).length;
    if (hashtagCount >= 5 && hashtagCount <= 8) {
      igHashtagRecommendation.innerHTML = `<span class="text-green-600 font-semibold flex items-center gap-1"><span class="material-symbols-outlined text-[14px]">check_circle</span> ${hashtagCount} hashtags included (recommended 5-8 for Instagram)</span>`;
    } else {
      igHashtagRecommendation.innerHTML = `<span class="text-amber-600 flex items-center gap-1"><span class="material-symbols-outlined text-[14px]">info</span> ${hashtagCount} hashtags included (recommended 5-8 for Instagram)</span>`;
    }
  }

  function checkStoryAspectRatio() {
    const file = mediaFileInput.files[0];
    if (!file || !file.type.startsWith("image/")) {
      igStoryWarning.innerHTML = "";
      igStoryWarning.classList.add("hidden");
      return;
    }

    const img = new Image();
    img.onload = function () {
      const ratio = img.naturalWidth / img.naturalHeight;
      const is916 = Math.abs(ratio - 9 / 16) < 0.02;

      if (is916) {
        igStoryWarning.innerHTML = `<span class="bg-green-100 text-green-800 text-xs font-semibold px-2.5 py-1 rounded flex items-center gap-1"><span class="material-symbols-outlined text-[14px]">check_circle</span> Story Aspect Ratio: Perfect 9:16 (${img.naturalWidth}x${img.naturalHeight}) detected!</span>`;
      } else {
        igStoryWarning.innerHTML = `<span class="bg-red-100 text-red-800 text-xs font-semibold px-2.5 py-1 rounded flex items-center gap-1"><span class="material-symbols-outlined text-[14px]">warning</span> Story images should be 9:16 (1080×1920) · Detected: ${img.naturalWidth}x${img.naturalHeight}</span>`;
      }
      igStoryWarning.classList.remove("hidden");
    };
    img.src = URL.createObjectURL(file);
  }

  let dragSrcEl = null;

  function handleDragStart(e) {
    this.style.opacity = "0.4";
    dragSrcEl = this;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("card-id", this.dataset.id);
  }

  function handleDragOver(e) {
    if (e.preventDefault) {
      e.preventDefault();
    }
    e.dataTransfer.dropEffect = "move";
    return false;
  }

  function handleDragLeave(e) {
    this.classList.remove("border-primary");
  }

  function handleDragEnter(e) {
    this.classList.add("border-primary");
  }

  function handleDrop(e) {
    if (e.stopPropagation) {
      e.stopPropagation();
    }
    this.classList.remove("border-primary");

    if (dragSrcEl !== this) {
      const srcId = e.dataTransfer.getData("card-id");
      const targetId = this.dataset.id;

      const srcIdx = carouselFiles.findIndex((item) => item.id == srcId);
      const targetIdx = carouselFiles.findIndex((item) => item.id == targetId);

      if (srcIdx !== -1 && targetIdx !== -1) {
        const temp = carouselFiles[srcIdx];
        carouselFiles.splice(srcIdx, 1);
        carouselFiles.splice(targetIdx, 0, temp);
        renderCarouselThumbnails();
      }
    }
    return false;
  }

  function handleDragEnd(e) {
    this.style.opacity = "1";
    document.querySelectorAll(".carousel-card").forEach((item) => {
      item.classList.remove("border-primary");
    });
  }

  function renderCarouselThumbnails() {
    carouselThumbnails.innerHTML = "";

    carouselFiles.forEach((item, index) => {
      const div = document.createElement("div");
      div.className =
        "carousel-card border border-outline-variant bg-surface-container-low rounded p-2 flex flex-col items-center relative cursor-move";
      div.setAttribute("draggable", "true");
      div.dataset.id = item.id;
      div.dataset.index = index;

      div.innerHTML = `
        <img src="${item.path}" class="w-full h-12 object-cover rounded mb-1 pointer-events-none" />
        <span class="text-[10px] font-semibold text-on-surface-variant pointer-events-none">#${index + 1}</span>
        <button type="button" class="carousel-remove-btn absolute top-1 right-1 bg-red-500 text-white rounded-full w-4 h-4 flex items-center justify-center hover:bg-red-600 transition-colors" data-id="${item.id}" style="font-size: 8px; font-weight: bold;">✕</button>
      `;

      div.addEventListener("dragstart", handleDragStart, false);
      div.addEventListener("dragenter", handleDragEnter, false);
      div.addEventListener("dragover", handleDragOver, false);
      div.addEventListener("dragleave", handleDragLeave, false);
      div.addEventListener("drop", handleDrop, false);
      div.addEventListener("dragend", handleDragEnd, false);

      div
        .querySelector(".carousel-remove-btn")
        .addEventListener("click", (e) => {
          e.stopPropagation();
          carouselFiles = carouselFiles.filter((f) => f.id !== item.id);
          renderCarouselThumbnails();
        });

      carouselThumbnails.appendChild(div);
    });
  }

  // ── Calendar Rendering ──

  async function loadCalendar() {
    weekRangeLabel.textContent =
      formatWeekRange(currentWeekStart).toUpperCase();
    const weekStr = formatLocalDateInput(currentWeekStart);

    let posts = [];
    try {
      posts = await fetchJSON(`/api/scheduler/posts?week=${weekStr}`);
    } catch (e) {
      /* empty */
    }

    const days = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let html = "";

    // Day headers
    for (let i = 0; i < 7; i++) {
      const d = new Date(currentWeekStart);
      d.setDate(currentWeekStart.getDate() + i);
      const isToday = d.getTime() === today.getTime();
      html += `<div class="p-2 text-center border-r border-b border-outline-variant bg-surface-container-lowest">
        <div class="font-label-caps text-label-caps text-on-surface-variant">${days[i]}</div>
        <div class="text-body-sm font-semibold ${isToday ? "text-primary" : ""}">${d.getDate()}</div>
      </div>`;
    }

    // Time slots: morning (6-12) and afternoon (12-22) simplified to 2 rows
    const slotRanges = [
      { label: "AM", startH: 0, endH: 12 },
      { label: "PM", startH: 12, endH: 24 },
    ];

    for (const slot of slotRanges) {
      for (let i = 0; i < 7; i++) {
        const d = new Date(currentWeekStart);
        d.setDate(currentWeekStart.getDate() + i);
        const dayStr = formatLocalDateInput(d);
        const isWeekend = i >= 5;
        const isToday = d.getTime() === today.getTime();

        const dayPosts = posts.filter((p) => {
          const pDate = new Date(p.scheduled_at || p.published_at);
          const pDayStr = formatLocalDateInput(pDate);
          const hour = pDate.getHours();
          return pDayStr === dayStr && hour >= slot.startH && hour < slot.endH;
        });

        html += `<div class="border-r border-b border-outline-variant p-1.5 min-h-[100px] ${isWeekend ? "bg-surface-container-low" : ""} ${isToday ? "bg-primary-fixed/5" : ""}">`;
        for (const post of dayPosts) {
          const pDate = new Date(post.scheduled_at || post.published_at);
          const timeStr = pDate.toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          });
          const platforms = Array.isArray(post.platforms)
            ? post.platforms
            : JSON.parse(post.platforms || "[]");
          const dots = platforms
            .map(
              (p) =>
                `<div class="w-2 h-2 rounded-full" style="background:${PLATFORM_COLORS[p] || "#999"}"></div>`,
            )
            .join("");
          const preview = (post.body || "").slice(0, 55);
          const statusBorder =
            post.status === "published"
              ? "border-green-400"
              : "border-outline-variant";

          html += `<div class="bg-surface rounded border ${statusBorder} p-1.5 mb-1 shadow-sm text-body-xs cursor-pointer hover:border-primary transition-colors" data-post-id="${post.id}">
            <div class="flex justify-between items-center mb-0.5 text-on-surface-variant">
              <span class="text-[10px]">${timeStr}</span>
              <div class="flex gap-0.5">${dots}</div>
            </div>
            <div class="text-on-surface line-clamp-2 text-[11px]">${preview}</div>
          </div>`;
        }
        html += "</div>";
      }
    }

    calendarGrid.innerHTML = html;

    // Bind click on calendar cards
    calendarGrid.querySelectorAll("[data-post-id]").forEach((card) => {
      card.addEventListener("click", () => openEditModal(card.dataset.postId));
    });
  }

  // ── Queue ──

  async function loadQueue() {
    let posts = [];
    try {
      posts = await fetchJSON("/api/scheduler/posts?status=scheduled");
    } catch {
      /* empty */
    }

    // Sort by soonest and take 5
    posts.sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at));
    const upcoming = posts.slice(0, 5);

    queueCountBadge.textContent = `${posts.length} Total`;
    queueList.innerHTML = "";

    if (upcoming.length === 0) {
      queueList.innerHTML =
        '<p class="text-body-xs text-on-surface-variant text-center py-4">No upcoming posts</p>';
      return;
    }

    upcoming.forEach((post) => {
      const pDate = new Date(post.scheduled_at);
      const timeStr =
        pDate.toLocaleDateString([], { month: "short", day: "numeric" }) +
        ", " +
        pDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const platforms = Array.isArray(post.platforms)
        ? post.platforms
        : JSON.parse(post.platforms || "[]");
      const dots = platforms
        .map(
          (p) =>
            `<div class="w-3 h-3 rounded-full" style="background:${PLATFORM_COLORS[p] || "#999"}"></div>`,
        )
        .join("");
      const preview = (post.body || "").slice(0, 50);

      const div = document.createElement("div");
      div.className =
        "bg-surface border border-outline-variant rounded p-2.5 text-body-xs flex gap-2.5 items-start cursor-pointer hover:border-outline transition-colors";
      div.innerHTML = `
        <div class="w-8 h-8 rounded bg-surface-variant flex-shrink-0 flex flex-wrap gap-0.5 p-1 items-center justify-center">${dots}</div>
        <div class="flex-1 min-w-0">
          <div class="font-semibold text-on-surface text-[11px] mb-0.5">${timeStr}</div>
          <p class="text-on-surface-variant line-clamp-2 text-[11px]">${preview}</p>
        </div>`;
      div.addEventListener("click", () => openEditModal(post.id));
      queueList.appendChild(div);
    });
  }

  // ── Published Log ──

  async function loadPublishedLog() {
    let posts = [];
    try {
      posts = await fetchJSON("/api/scheduler/posts?status=published");
    } catch {
      /* empty */
    }

    publishedBody.innerHTML = "";
    if (posts.length === 0) {
      publishedBody.innerHTML =
        '<tr><td colspan="7" class="px-4 py-8 text-center text-on-surface-variant">No published posts yet.</td></tr>';
      return;
    }

    posts.forEach((post) => {
      const platforms = Array.isArray(post.platforms)
        ? post.platforms
        : JSON.parse(post.platforms || "[]");
      const platformLabels = platforms
        .map((p) => `<span class="capitalize">${p}</span>`)
        .join(", ");
      const preview = (post.body || "").slice(0, 60);
      const pubDate = post.published_at
        ? new Date(post.published_at).toLocaleString()
        : "-";

      const tr = document.createElement("tr");
      tr.className = "hover:bg-surface-container-low transition-colors";
      tr.innerHTML = `
        <td class="px-4 py-3 text-body-sm">${platformLabels}</td>
        <td class="px-4 py-3 text-body-sm text-on-surface-variant max-w-[200px] truncate">${preview}</td>
        <td class="px-4 py-3 text-body-xs text-on-surface-variant">${pubDate}</td>
        <td class="px-4 py-3"><input type="number" class="w-16 border border-outline-variant rounded px-2 py-1 text-body-xs text-center" value="${post.likes || 0}" data-post-id="${post.id}" data-field="likes"/></td>
        <td class="px-4 py-3"><input type="number" class="w-16 border border-outline-variant rounded px-2 py-1 text-body-xs text-center" value="${post.comments || 0}" data-post-id="${post.id}" data-field="comments"/></td>
        <td class="px-4 py-3"><input type="number" class="w-16 border border-outline-variant rounded px-2 py-1 text-body-xs text-center" value="${post.reach || 0}" data-post-id="${post.id}" data-field="reach"/></td>
        <td class="px-4 py-3"><button class="text-primary text-body-xs hover:underline save-stats-btn" data-post-id="${post.id}">Save</button></td>`;
      publishedBody.appendChild(tr);
    });

    // Bind save stats buttons
    publishedBody.querySelectorAll(".save-stats-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const pid = btn.dataset.postId;
        const row = btn.closest("tr");
        const likes =
          parseInt(row.querySelector('[data-field="likes"]').value) || 0;
        const comments =
          parseInt(row.querySelector('[data-field="comments"]').value) || 0;
        const reach =
          parseInt(row.querySelector('[data-field="reach"]').value) || 0;
        try {
          await fetchJSON(`/api/scheduler/posts/${pid}/stats`, {
            method: "PATCH",
            body: JSON.stringify({ likes, comments, reach }),
          });
          showToast("Stats saved", "success");
        } catch (e) {
          showToast(e.message, "error");
        }
      });
    });
  }

  // ── Pause State ──

  async function loadPauseState() {
    try {
      const data = await fetchJSON("/api/scheduler/pause");
      isPaused = data.paused;
      updatePauseUI();
    } catch {
      /* ignore */
    }
  }

  function updatePauseUI() {
    if (isPaused) {
      pauseToggle.classList.replace("bg-primary", "bg-gray-300");
      pauseToggleDot.style.right = "auto";
      pauseToggleDot.style.left = "4px";
      pauseBanner.classList.remove("hidden");
      pauseBanner.classList.add("flex");
      schedulerStatusLabel.textContent = "Paused";
    } else {
      pauseToggle.classList.replace("bg-gray-300", "bg-primary");
      pauseToggleDot.style.left = "auto";
      pauseToggleDot.style.right = "4px";
      pauseBanner.classList.add("hidden");
      pauseBanner.classList.remove("flex");
      schedulerStatusLabel.textContent = "Currently active";
    }
  }

  // ── Edit Modal ──

  async function openEditModal(postId) {
    editingPostId = postId;
    let post;
    try {
      const posts = await fetchJSON(`/api/scheduler/posts`);
      post = posts.find((p) => p.id == postId);
    } catch {
      return showToast("Failed to load post", "error");
    }
    if (!post) return;
    editingPostMedia = post.media_path;

    const platforms = Array.isArray(post.platforms)
      ? post.platforms
      : JSON.parse(post.platforms || "[]");
    document.querySelectorAll(".edit-platform-cb").forEach((cb) => {
      cb.checked = platforms.includes(cb.value);
    });
    $("edit-body").value = post.body || "";
    if (post.scheduled_at) {
      const d = new Date(post.scheduled_at);
      $("edit-date").value = formatLocalDateInput(d);
      $("edit-time").value = d.toTimeString().slice(0, 5);
    }
    $("edit-modal-backdrop").classList.remove("hidden");
  }

  function closeEditModal() {
    $("edit-modal-backdrop").classList.add("hidden");
    editingPostId = null;
  }

  // ── SSE Live Publish Log ──

  function startPublishStream(jobId) {
    liveLogPanel.classList.remove("hidden");
    liveLogBody.innerHTML = "";

    // Legacy SSE to trigger backend stream
    const legacySSE = window.gtss.initSSE(
      `/api/scheduler/stream/${jobId}`,
      () => {},
    );

    const socket = getSocket();
    if (!socket) return;

    function onSchedulerEvent(data) {
      if (!data) return;
      if (data.jobId && String(data.jobId) !== String(jobId)) return;

      const line = document.createElement("div");
      const icon =
        data.type === "published" ? "✓" : data.type === "error" ? "✗" : "›";
      line.textContent = `${icon} ${data.message || data.type}`;
      if (data.type === "error") line.classList.add("text-error");
      if (data.type === "published") line.classList.add("text-green-600");
      liveLogBody.appendChild(line);
      liveLogBody.scrollTop = liveLogBody.scrollHeight;

      if (data.type === "done" || data.type === "error") {
        showToast(data.message, data.type === "done" ? "success" : "error");
        cleanup();
        setTimeout(() => {
          liveLogPanel.classList.add("hidden");
          loadCalendar();
          loadQueue();
        }, 3000);
      }
    }

    function cleanup() {
      socket.off("scheduler:event", onSchedulerEvent);
      if (legacySSE) legacySSE.close();
    }

    socket.on("scheduler:event", onSchedulerEvent);
  }

  function appendImageGenLog(message, tone = "") {
    if (!imageGenLog) return;
    imageGenLog.classList.remove("hidden");
    const line = document.createElement("div");
    line.textContent = message;
    if (tone === "error") line.classList.add("text-error");
    if (tone === "success") line.classList.add("text-green-600");
    imageGenLog.appendChild(line);
    imageGenLog.scrollTop = imageGenLog.scrollHeight;
  }

  async function refreshImageGenResult(jobId) {
    try {
      const row = await fetchJSON(`/api/scheduler/generate-image/${jobId}`);
      if (row.gen_prompt) {
        imageGenOutput.classList.remove("hidden");
        imageGenPrompt.textContent = row.gen_prompt;
      }
      if (row.file_path) {
        imageGenOutput.classList.remove("hidden");
        imageGenFile.textContent = row.file_path;
      }
      if (row.error) {
        appendImageGenLog(row.error, "error");
      }
    } catch (err) {
      appendImageGenLog(`Could not load job result: ${err.message}`, "error");
    }
  }

  function startImageGenStream(jobId) {
    imageGenStatus.textContent = "Running";
    imageGenLog.innerHTML = "";
    imageGenLog.classList.remove("hidden");
    imageGenOutput.classList.add("hidden");
    imageGenPrompt.textContent = "";
    imageGenFile.textContent = "";

    const stream = window.gtss.initSSE(
      `/api/scheduler/stream/${jobId}`,
      async (data) => {
        if (!data) return;
        if (data.type === "connected") {
          appendImageGenLog("Connected to job stream.");
          return;
        }
        if (data.jobId && String(data.jobId) !== String(jobId)) return;

        appendImageGenLog(data.message || data.type);
        if (data.genPrompt) {
          imageGenOutput.classList.remove("hidden");
          imageGenPrompt.textContent = data.genPrompt;
        }
        if (data.filePath) {
          imageGenOutput.classList.remove("hidden");
          imageGenFile.textContent = data.filePath;
        }

        if (data.type === "download_complete") {
          imageGenStatus.textContent = "Complete";
          appendImageGenLog("Download complete.", "success");
          await refreshImageGenResult(jobId);
          stream.close();
          imageGenStartBtn.disabled = false;
          imageGenStartBtn.innerHTML =
            '<span class="material-symbols-outlined text-[16px]">auto_awesome</span> Generate Image';
        }

        if (data.type === "error") {
          imageGenStatus.textContent = "Failed";
          appendImageGenLog(data.message || "Image generation failed.", "error");
          await refreshImageGenResult(jobId);
          stream.close();
          imageGenStartBtn.disabled = false;
          imageGenStartBtn.innerHTML =
            '<span class="material-symbols-outlined text-[16px]">auto_awesome</span> Generate Image';
        }
      },
    );
  }

  // ── Event Binding ──

  function bindEvents() {
    // Char counter & Instagram Panel
    postBody.addEventListener("input", () => {
      updateCharCounters();
      updateInstagramCaptionHelper();
    });
    document.querySelectorAll(".platform-checkbox").forEach((cb) =>
      cb.addEventListener("change", () => {
        updateCharCounters();
        toggleInstagramOptions();
      }),
    );

    async function uploadMediaFile(file) {
      if (!file) return;

      const formData = new FormData();
      formData.append("media", file);

      try {
        const res = await fetch("/api/scheduler/upload-media", {
          method: "POST",
          body: formData,
        });
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || `HTTP ${res.status}`);
        }
        const result = await res.json();

        if (!result.filePath) {
          throw new Error("Server did not return a file path");
        }

        uploadedMediaFilePath = result.filePath; // absolute FS path — used when posting
        uploadedMediaPath = result.path; // web URL — used for preview thumbnail only

        mediaThumb.src = uploadedMediaPath;
        mediaFilename.textContent = file.name;
        mediaPlaceholder.classList.add("hidden");
        mediaPreview.classList.remove("hidden");
        showToast("Media uploaded", "success");
        checkStoryAspectRatio();
      } catch (err) {
        showToast(`Upload failed: ${err.message}`, "error");
        mediaFileInput.value = "";
      }
    }

    // Media upload
    mediaFileInput.addEventListener("click", (e) => {
      e.stopPropagation();
    });

    mediaFileInput.addEventListener("change", async (e) => {
      const file = e.target.files[0];
      await uploadMediaFile(file);
    });

    if (mediaDropzone) {
      mediaDropzone.addEventListener("click", (e) => {
        if (e.target === mediaFileInput) return;
        mediaFileInput.click();
      });
      mediaDropzone.addEventListener("dragenter", (e) => {
        e.preventDefault();
        mediaDropzone.classList.add("border-primary");
      });
      mediaDropzone.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        mediaDropzone.classList.add("border-primary");
      });
      mediaDropzone.addEventListener("dragleave", () => {
        mediaDropzone.classList.remove("border-primary");
      });
      mediaDropzone.addEventListener("drop", async (e) => {
        e.preventDefault();
        mediaDropzone.classList.remove("border-primary");
        const file = e.dataTransfer.files && e.dataTransfer.files[0];
        if (!file) return;
        await uploadMediaFile(file);
      });
    }

    mediaRemoveBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      uploadedMediaPath = null;
      uploadedMediaFilePath = null;
      mediaFileInput.value = "";
      mediaPlaceholder.classList.remove("hidden");
      mediaPreview.classList.add("hidden");
      igStoryWarning.innerHTML = "";
      igStoryWarning.classList.add("hidden");
    });

    // Instagram post type options change
    document.querySelectorAll('input[name="ig-post-type"]').forEach((radio) => {
      radio.addEventListener("change", (e) => {
        const val = e.target.value;
        if (val === "story") {
          igStoryWarning.classList.remove("hidden");
          igCarouselPanel.classList.add("hidden");
          checkStoryAspectRatio();
        } else if (val === "carousel") {
          igStoryWarning.classList.add("hidden");
          igCarouselPanel.classList.remove("hidden");
        } else {
          igStoryWarning.classList.add("hidden");
          igCarouselPanel.classList.add("hidden");
        }
      });
    });

    // Carousel additions
    carouselFileInput.addEventListener("change", async (e) => {
      const files = [...e.target.files];
      if (carouselFiles.length + files.length > 10) {
        showToast("Carousel posts support a maximum of 10 images.", "error");
        return;
      }

      for (const file of files) {
        const formData = new FormData();
        formData.append("media", file);
        try {
          const res = await fetch("/api/scheduler/upload-media", {
            method: "POST",
            body: formData,
          });
          if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(errData.error || `HTTP ${res.status}`);
          }
          const result = await res.json();
          carouselFiles.push({
            id: Date.now() + Math.random().toString(36).substr(2, 9),
            file,
            path: result.path,
            filePath: result.filePath,
          });
        } catch (err) {
          showToast(`Failed uploading carousel image: ${err.message}`, "error");
        }
      }
      renderCarouselThumbnails();
      carouselFileInput.value = "";
    });

    const carouselZone = $("carousel-upload-zone");
    if (carouselZone) {
      carouselZone.addEventListener("click", () => {
        carouselFileInput.click();
      });
    }

    // AI Caption Generation
    generateCaptionBtn.addEventListener("click", async () => {
      const topic = aiTopic.value.trim();
      if (!topic) return showToast("Enter a topic first", "error");
      const tone =
        document.querySelector('input[name="ai-tone"]:checked')?.value ||
        "engaging";
      const platforms = getSelectedPlatforms();
      const platform = platforms[0] || "";

      generateCaptionBtn.disabled = true;
      generateCaptionBtn.innerHTML =
        '<span class="material-symbols-outlined text-[16px] animate-spin">sync</span> Generating...';
      try {
        const data = await fetchJSON("/api/scheduler/generate-caption", {
          method: "POST",
          body: JSON.stringify({ topic, platform, tone }),
        });
        postBody.value = data.caption;
        updateCharCounters();
        showToast("Caption generated!", "success");
      } catch (err) {
        showToast(err.message, "error");
      } finally {
        generateCaptionBtn.disabled = false;
        generateCaptionBtn.innerHTML =
          '<span class="material-symbols-outlined text-[16px]">auto_awesome</span> Generate';
      }
    });

    if (imageGenStartBtn) {
      imageGenStartBtn.addEventListener("click", async () => {
        const topic = imageGenTopic.value.trim();
        if (!topic) return showToast("Enter an image topic first", "error");

        imageGenStartBtn.disabled = true;
        imageGenStartBtn.innerHTML =
          '<span class="material-symbols-outlined text-[16px] animate-spin">sync</span> Running...';
        imageGenStatus.textContent = "Starting";

        try {
          const data = await fetchJSON("/api/scheduler/generate-image", {
            method: "POST",
            body: JSON.stringify({
              topic,
              style: imageGenStyle.value,
              platform: imageGenPlatform.value,
            }),
          });
          startImageGenStream(data.jobId);
        } catch (err) {
          imageGenStatus.textContent = "Failed";
          imageGenStartBtn.disabled = false;
          imageGenStartBtn.innerHTML =
            '<span class="material-symbols-outlined text-[16px]">auto_awesome</span> Generate Image';
          showToast(err.message, "error");
        }
      });
    }

    // Post Now
    postNowBtn.addEventListener("click", async () => {
      const platforms = getSelectedPlatforms();
      if (platforms.length === 0)
        return showToast("Select at least one platform", "error");
      if (!postBody.value.trim())
        return showToast("Write something first", "error");

      const hasInstagram = platforms.includes("instagram");
      const igPostType = hasInstagram
        ? document.querySelector('input[name="ig-post-type"]:checked')?.value ||
          "feed"
        : "feed";

      if (hasInstagram && postBody.value.length > 2200) {
        return showToast(
          "Instagram posts have a maximum limit of 2200 characters.",
          "error",
        );
      }

      let mediaPath = uploadedMediaFilePath || null;
      if (hasInstagram && igPostType === "carousel") {
        if (carouselFiles.length === 0) {
          return showToast(
            "Carousel posts require at least one media file.",
            "error",
          );
        }
        mediaPath = JSON.stringify(carouselFiles.map((f) => f.filePath));
      }

      const hasMedia = mediaPath && String(mediaPath).trim() !== "";

      if (hasInstagram && !hasMedia) {
        return showToast(
          "Instagram posts require a media attachment (image or video).",
          "error",
        );
      }

      try {
        const data = await fetchJSON("/api/scheduler/posts", {
          method: "POST",
          body: JSON.stringify({
            platforms,
            body: postBody.value,
            mediaPath,
            publishNow: true,
            ig_post_type: igPostType,
          }),
        });
        startPublishStream(data.jobId);
        postBody.value = "";
        uploadedMediaPath = null;
        uploadedMediaFilePath = null;
        carouselFiles = [];
        renderCarouselThumbnails();
        mediaPlaceholder.classList.remove("hidden");
        mediaPreview.classList.add("hidden");
        updateCharCounters();
      } catch (err) {
        showToast(err.message, "error");
      }
    });

    // Schedule
    scheduleBtn.addEventListener("click", async () => {
      const platforms = getSelectedPlatforms();
      if (platforms.length === 0)
        return showToast("Select at least one platform", "error");
      if (!postBody.value.trim())
        return showToast("Write something first", "error");
      if (!scheduleDate.value || !scheduleTime.value)
        return showToast("Pick a date and time", "error");

      const hasInstagram = platforms.includes("instagram");
      const igPostType = hasInstagram
        ? document.querySelector('input[name="ig-post-type"]:checked')?.value ||
          "feed"
        : "feed";

      if (hasInstagram && postBody.value.length > 2200) {
        return showToast(
          "Instagram posts have a maximum limit of 2200 characters.",
          "error",
        );
      }

      let mediaPath = uploadedMediaFilePath || null;
      if (hasInstagram && igPostType === "carousel") {
        if (carouselFiles.length === 0) {
          return showToast(
            "Carousel posts require at least one media file.",
            "error",
          );
        }
        mediaPath = JSON.stringify(carouselFiles.map((f) => f.filePath));
      }

      const hasMedia = mediaPath && String(mediaPath).trim() !== "";

      if (hasInstagram && !hasMedia) {
        return showToast(
          "Instagram posts require a media attachment (image or video).",
          "error",
        );
      }

      const scheduledAt = new Date(
        `${scheduleDate.value}T${scheduleTime.value}`,
      ).toISOString();
      try {
        await fetchJSON("/api/scheduler/posts", {
          method: "POST",
          body: JSON.stringify({
            platforms,
            body: postBody.value,
            mediaPath,
            scheduledAt,
            ig_post_type: igPostType,
          }),
        });
        showToast("Post scheduled!", "success");
        postBody.value = "";
        uploadedMediaPath = null;
        uploadedMediaFilePath = null;
        carouselFiles = [];
        renderCarouselThumbnails();
        mediaPlaceholder.classList.remove("hidden");
        mediaPreview.classList.add("hidden");
        updateCharCounters();
        loadCalendar();
        loadQueue();
      } catch (err) {
        showToast(err.message, "error");
      }
    });

    // Calendar navigation
    $("prev-week-btn").addEventListener("click", () => {
      currentWeekStart.setDate(currentWeekStart.getDate() - 7);
      loadCalendar();
    });
    $("next-week-btn").addEventListener("click", () => {
      currentWeekStart.setDate(currentWeekStart.getDate() + 7);
      loadCalendar();
    });
    $("today-btn").addEventListener("click", () => {
      currentWeekStart = getMonday(new Date());
      loadCalendar();
    });

    // Tabs
    $("tab-calendar").addEventListener("click", () => {
      $("calendar-section").classList.remove("hidden");
      $("published-section").classList.add("hidden");
      $("tab-calendar").classList.add("text-primary", "border-primary");
      $("tab-calendar").classList.remove(
        "text-on-surface-variant",
        "border-transparent",
      );
      $("tab-published").classList.remove("text-primary", "border-primary");
      $("tab-published").classList.add(
        "text-on-surface-variant",
        "border-transparent",
      );
    });
    $("tab-published").addEventListener("click", () => {
      $("published-section").classList.remove("hidden");
      $("calendar-section").classList.add("hidden");
      $("tab-published").classList.add("text-primary", "border-primary");
      $("tab-published").classList.remove(
        "text-on-surface-variant",
        "border-transparent",
      );
      $("tab-calendar").classList.remove("text-primary", "border-primary");
      $("tab-calendar").classList.add(
        "text-on-surface-variant",
        "border-transparent",
      );
      loadPublishedLog();
    });

    // Pause toggle
    pauseToggle.addEventListener("click", async () => {
      isPaused = !isPaused;
      updatePauseUI();
      try {
        await fetchJSON("/api/scheduler/pause", {
          method: "PATCH",
          body: JSON.stringify({ paused: isPaused }),
        });
        showToast(
          isPaused ? "Scheduler paused" : "Scheduler resumed",
          "success",
        );
      } catch (err) {
        showToast(err.message, "error");
        isPaused = !isPaused;
        updatePauseUI();
      }
    });

    // Edit Modal
    $("edit-modal-close").addEventListener("click", closeEditModal);
    $("edit-modal-backdrop").addEventListener("click", (e) => {
      if (e.target === $("edit-modal-backdrop")) closeEditModal();
    });

    $("edit-save-btn").addEventListener("click", async () => {
      if (!editingPostId) return;
      const platforms = [
        ...document.querySelectorAll(".edit-platform-cb:checked"),
      ].map((cb) => cb.value);
      const body = $("edit-body").value;
      const scheduledAt = new Date(
        `${$("edit-date").value}T${$("edit-time").value}`,
      ).toISOString();

      const hasInstagram = platforms.includes("instagram");
      const hasMedia =
        editingPostMedia && String(editingPostMedia).trim() !== "";

      if (hasMedia && !hasInstagram) {
        return showToast(
          "Media attachments are only allowed when Instagram is selected as a target platform.",
          "error",
        );
      }
      if (hasInstagram && !hasMedia) {
        return showToast(
          "Instagram posts require a media attachment (image or video).",
          "error",
        );
      }

      try {
        await fetchJSON(`/api/scheduler/posts/${editingPostId}`, {
          method: "PATCH",
          body: JSON.stringify({ platforms, body, scheduledAt }),
        });
        showToast("Post updated", "success");
        closeEditModal();
        loadCalendar();
        loadQueue();
      } catch (err) {
        showToast(err.message, "error");
      }
    });

    $("edit-delete-btn").addEventListener("click", async () => {
      if (!editingPostId || !confirm("Delete this post?")) return;
      try {
        await fetchJSON(`/api/scheduler/posts/${editingPostId}`, {
          method: "DELETE",
        });
        showToast("Post deleted", "success");
        closeEditModal();
        loadCalendar();
        loadQueue();
      } catch (err) {
        showToast(err.message, "error");
      }
    });

    $("edit-publish-btn").addEventListener("click", async () => {
      if (!editingPostId) return;

      const platforms = [
        ...document.querySelectorAll(".edit-platform-cb:checked"),
      ].map((cb) => cb.value);
      const hasInstagram = platforms.includes("instagram");
      const hasMedia =
        editingPostMedia && String(editingPostMedia).trim() !== "";

      if (hasMedia && !hasInstagram) {
        return showToast(
          "Media attachments are only allowed when Instagram is selected as a target platform.",
          "error",
        );
      }
      if (hasInstagram && !hasMedia) {
        return showToast(
          "Instagram posts require a media attachment (image or video).",
          "error",
        );
      }

      try {
        const data = await fetchJSON(
          `/api/scheduler/posts/${editingPostId}/publish-now`,
          { method: "POST" },
        );
        closeEditModal();
        startPublishStream(data.jobId);
      } catch (err) {
        showToast(err.message, "error");
      }
    });
  }
});
