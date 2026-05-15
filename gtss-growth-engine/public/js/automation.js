/* ================================================================
   Automation Control – Frontend Logic
   ================================================================ */

(function () {
  'use strict';

  const { fetchJSON, showToast, initSSE } = window.gtss;

  // State
  let activeSSE = null;
  let activeJobId = null;
  let isAutomationRunning = false;

  // DOM Refs
  const runAllBtn = document.getElementById('run-all-btn');
  const stopBtn = document.getElementById('stop-btn');
  const queueBody = document.getElementById('queue-body');
  const logContainer = document.getElementById('log-container');
  const logAutoScroll = document.getElementById('log-autoscroll');
  const logClearBtn = document.getElementById('log-clear-btn');
  const emptyState = document.getElementById('empty-state');
  const limitCards = document.getElementById('limit-cards');
  
  const captchaBanner = document.getElementById('captcha-banner');
  const captchaPlatformText = document.getElementById('captcha-platform-text');
  const manualOpenBtn = document.getElementById('manual-open-btn');
  const manualResumeBtn = document.getElementById('manual-resume-btn');
  let currentCaptchaPlatform = null;

  // ----------------------------------------------------------------
  // Init
  // ----------------------------------------------------------------

  async function init() {
    await loadLimits();
    await loadQueue();

    // Re-check sessions
    const sessions = await fetchJSON('/api/sessions/status');
    for (const [platform, isValid] of Object.entries(sessions)) {
      if (!isValid) {
        showToast(`No valid session for ${platform}. Please authenticate.`, 'warn');
      }
    }
  }

  // ----------------------------------------------------------------
  // Load Limits
  // ----------------------------------------------------------------

  async function loadLimits() {
    try {
      const data = await fetchJSON('/api/automation/limits');
      renderLimitCards(data);
    } catch (err) {
      console.error('Failed to load limits', err);
    }
  }

  function renderLimitCards(limitsObj) {
    if (!limitCards) return;
    
    limitCards.innerHTML = '';
    const icons = {
      linkedin: 'work',
      x: 'tag',
      facebook: 'groups',
      instagram: 'photo_camera'
    };
    
    const colors = {
      linkedin: 'primary-container',
      x: 'on-surface',
      facebook: 'secondary',
      instagram: 'tertiary'
    };

    for (const [platform, counts] of Object.entries(limitsObj)) {
      const icon = icons[platform] || 'web';
      const bgClass = colors[platform] || 'primary';
      const pct = counts.limit > 0 ? Math.min(100, Math.round((counts.used / counts.limit) * 100)) : 0;
      
      const card = `
        <div class="bg-surface-container-lowest border border-outline-variant shadow-sm rounded-lg p-5 flex flex-col justify-between h-32 relative overflow-hidden">
          <div class="flex justify-between items-start">
            <span class="font-label-caps text-label-caps text-on-surface-variant capitalize">${platform}</span>
            <span class="material-symbols-outlined text-${bgClass} text-lg">${icon}</span>
          </div>
          <div class="mt-2">
            <div class="font-display-lg text-display-lg text-on-surface flex items-baseline gap-1">
                ${counts.used} <span class="font-body-sm text-body-sm text-on-surface-variant font-normal">/ ${counts.limit}</span>
            </div>
            <div class="w-full h-1.5 bg-surface-container-high rounded-full mt-3 overflow-hidden">
                <div class="h-full bg-${bgClass} rounded-full transition-all" style="width: ${pct}%"></div>
            </div>
          </div>
          <button class="absolute top-4 right-10 text-outline hover:text-primary transition-colors auth-btn" data-platform="${platform}" title="Authenticate">
            <span class="material-symbols-outlined text-sm">login</span>
          </button>
        </div>
      `;
      limitCards.insertAdjacentHTML('beforeend', card);
    }
  }

  // ----------------------------------------------------------------
  // Load Queue
  // ----------------------------------------------------------------

  async function loadQueue() {
    try {
      const queue = await fetchJSON('/api/automation/queue');
      renderQueue(queue);
    } catch (err) {
      console.error('Failed to load queue', err);
    }
  }

  function renderQueue(queue) {
    if (!queue || queue.length === 0) {
      queueBody.innerHTML = '';
      if (emptyState) emptyState.classList.add('visible');
      return;
    }

    if (emptyState) emptyState.classList.remove('visible');

    queueBody.innerHTML = queue.map((action) => {
      const leadName = escapeHtml(action.lead_name || 'Unknown');
      const platform = escapeHtml(action.platform || '');
      const actionType = action.action_type === 'connect' ? 'Connect' : 'DM';
      const isBlocked = action.status === 'blocked';
      const isPremiumBlocked = action.blocked_reason === 'premium_required';
      const statusLabel = isPremiumBlocked
        ? 'Premium required'
        : isBlocked
          ? 'Blocked'
          : 'Queued';
      const statusDetail = action.last_error ? `<div class="text-xs text-on-surface-variant mt-1 max-w-[260px]">${escapeHtml(action.last_error)}</div>` : '';
      const dotClass = isBlocked ? 'bg-error border-error' : 'bg-outline border-outline-variant';
      
      return `
        <tr class="h-table-row-height border-b border-outline-variant/50 hover:bg-surface-variant/10 transition-colors group" data-id="${action.message_id}" data-status="${action.status || 'approved'}">
          <td class="px-4 py-3 align-top font-medium">${leadName}</td>
          <td class="px-4 py-3 align-top text-on-surface-variant capitalize">${platform}</td>
          <td class="px-4 py-3 align-top">${actionType}</td>
          <td class="px-4 py-3 align-top status-cell">
              <div class="flex items-center gap-2">
                  <span class="w-2 h-2 rounded-full ${dotClass} inline-block border"></span>
                  <span class="${isBlocked ? 'text-error' : 'text-on-surface-variant'}">${statusLabel}</span>
              </div>
              ${statusDetail}
          </td>
          <td class="px-4 py-3 align-top text-right">
              <div class="opacity-0 group-hover:opacity-100 transition-opacity flex justify-end gap-1">
                  ${isBlocked ? `
                  <button class="p-1 text-secondary hover:text-surface-tint rounded transition-colors retry-btn" data-id="${action.message_id}" title="Retry">
                      <span class="material-symbols-outlined text-[18px]">replay</span>
                  </button>
                  ` : ''}
                  <button class="p-1 text-secondary hover:text-surface-tint rounded transition-colors skip-btn" data-id="${action.message_id}" title="Skip">
                      <span class="material-symbols-outlined text-[18px]">skip_next</span>
                  </button>
              </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ----------------------------------------------------------------
  // Logging
  // ----------------------------------------------------------------

  function appendLog(type, msg, data = {}) {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    let typeClass = 'text-primary-fixed-dim';
    if (type === 'error' || type === 'captcha') typeClass = 'text-error';
    else if (type === 'warn') typeClass = 'text-secondary-fixed-dim';
    else if (type === 'done') typeClass = 'text-primary';

    const div = document.createElement('div');
    div.className = 'flex gap-3 mb-1.5';
    div.innerHTML = `
      <span class="text-outline shrink-0">[${time}]</span>
      <span class="${typeClass} shrink-0 w-12 font-bold">${type.toUpperCase()}</span>
      <span class="text-inverse-on-surface">${msg}</span>
    `;

    logContainer.appendChild(div);

    if (logAutoScroll.checked) {
      logContainer.scrollTop = logContainer.scrollHeight;
    }
  }

  logClearBtn.addEventListener('click', () => {
    logContainer.innerHTML = '';
  });

  // ----------------------------------------------------------------
  // Automation Execution
  // ----------------------------------------------------------------

  async function startAutomation() {
    if (isAutomationRunning) return;
    
    // Clear captcha warning if visible
    captchaBanner.style.display = 'none';

    try {
      const res = await fetchJSON('/api/automation/run', { method: 'POST' });
      activeJobId = res.jobId;
      isAutomationRunning = true;
      runAllBtn.disabled = true;
      stopBtn.style.display = 'flex';
      
      appendLog('info', 'Connecting to execution stream...');

      activeSSE = initSSE(`/api/automation/stream/${activeJobId}`, (event) => {
        if (!event) return;

        appendLog(event.type, event.message, event);

        // Update UI states based on event
        if (event.type === 'info' && event.message.includes('Processing action:')) {
           // We could parse the message to find the active row and update status, 
           // but reloading the queue is simpler for now
           loadLimits();
        }

        if (event.type === 'captcha') {
           showCaptchaWarning(event.platform);
        }

        if (event.type === 'done' || event.type === 'error' || event.type === 'captcha') {
           if (event.type === 'done' || event.type === 'error') {
              if (activeSSE) { activeSSE.close(); activeSSE = null; }
              isAutomationRunning = false;
              activeJobId = null;
              runAllBtn.disabled = false;
              stopBtn.style.display = 'none';
              loadQueue();
              loadLimits();
           }
        }
      });
    } catch (err) {
      showToast(err.message, 'error');
      appendLog('error', err.message);
    }
  }

  async function stopAutomation() {
    if (!activeJobId) return;
    
    try {
      await fetchJSON(`/api/automation/stop/${activeJobId}`, { method: 'POST' });
      appendLog('warn', 'Stop signal sent.');
      stopBtn.disabled = true;
      stopBtn.innerHTML = `<span class="material-symbols-outlined animate-spin">refresh</span> Stopping...`;
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  runAllBtn.addEventListener('click', startAutomation);
  stopBtn.addEventListener('click', stopAutomation);

  // ----------------------------------------------------------------
  // Skip Action
  // ----------------------------------------------------------------

  queueBody.addEventListener('click', async (e) => {
    const retryBtn = e.target.closest('.retry-btn');
    if (retryBtn) {
      const id = retryBtn.dataset.id;
      try {
        await fetchJSON(`/api/automation/queue/${id}/retry`, { method: 'PATCH' });
        showToast('Action returned to queue', 'success');
        await loadQueue();
      } catch (err) {
        showToast(err.message, 'error');
      }
      return;
    }

    const skipBtn = e.target.closest('.skip-btn');
    if (!skipBtn) return;

    const id = skipBtn.dataset.id;
    try {
      await fetchJSON(`/api/automation/queue/${id}/skip`, { method: 'PATCH' });
      showToast('Action skipped', 'info');
      
      const row = document.querySelector(`tr[data-id="${id}"]`);
      if (row) row.remove();
      
      if (queueBody.children.length === 0 && emptyState) {
        emptyState.classList.add('visible');
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // ----------------------------------------------------------------
  // Authentication & Captcha
  // ----------------------------------------------------------------

  limitCards.addEventListener('click', async (e) => {
    const authBtn = e.target.closest('.auth-btn');
    if (!authBtn) return;

    const platform = authBtn.dataset.platform;
    showToast(`Opening browser to authenticate ${platform}...`, 'info');
    appendLog('info', `Manual authentication requested for ${platform}`);
    
    try {
      await fetchJSON(`/api/sessions/authenticate/${platform}`, { method: 'POST' });
      showToast(`${platform} authenticated successfully!`, 'success');
      appendLog('done', `${platform} authenticated`);
    } catch (err) {
      showToast(`Auth failed: ${err.message}`, 'error');
      appendLog('error', `Auth failed: ${err.message}`);
    }
  });

  function showCaptchaWarning(platform) {
    currentCaptchaPlatform = platform;
    captchaPlatformText.textContent = platform;
    captchaBanner.style.display = 'flex';
  }

  manualOpenBtn.addEventListener('click', async () => {
    if (!currentCaptchaPlatform) return;
    try {
      showToast(`Opening visible browser for ${currentCaptchaPlatform}`, 'info');
      await fetchJSON(`/api/automation/open-browser/${currentCaptchaPlatform}`, { method: 'POST' });
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  manualResumeBtn.addEventListener('click', () => {
    captchaBanner.style.display = 'none';
    currentCaptchaPlatform = null;
    startAutomation(); // Resumes run
  });

  // Hide stop btn and captcha banner initially
  stopBtn.style.display = 'none';
  captchaBanner.style.display = 'none';

  // Run init
  init();

})();
