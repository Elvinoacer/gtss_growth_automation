document.addEventListener("DOMContentLoaded", initShell);

const sharedApi = {
  fetchJSON,
  showToast,
  showConfirmDialog,
  initSSE,
  initSocket,
  getSocket,
  joinRoom,
  leaveRoom,
  loadPlatformCatalog,
  formatPlatformLabel,
  updateSessionDots,
  updateActionBadge,
  renderStatCard,
  renderPlatformBadge,
  renderStatusBadge,
  renderScoreBadge,
  renderConfirmModal,
  renderEmptyState,
  renderDataTable,
  escapeHtml,
};

window.gtss = sharedApi;
window.GTSS = sharedApi;
