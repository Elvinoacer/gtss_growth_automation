// ----------------------------------------------------------------
// Socket.IO — Global real-time connection
// ----------------------------------------------------------------

let _socket = null;

function getSocket() {
  if (!_socket && typeof io !== "undefined") {
    _socket = io({
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: Infinity,
      transports: ["websocket", "polling"],
    });

    _socket.on("connect", () => {
      console.log("[GTSS] Socket.IO connected:", _socket.id);
    });

    _socket.on("disconnect", (reason) => {
      console.warn("[GTSS] Socket.IO disconnected:", reason);
    });

    _socket.on("connect_error", (err) => {
      console.warn("[GTSS] Socket.IO connection error:", err.message);
    });

    // Live updates for global UI elements
    _socket.on("stats:updated", () => {
      updateActionBadge();
    });

    _socket.on("sessions:updated", () => {
      updateSessionDots();
    });
  }
  return _socket;
}

/**
 * Subscribe to socket events. Returns an object with .off() to unsubscribe.
 * @param {Object.<string, Function>} eventMap - { 'event:name': handler }
 */
function initSocket(eventMap) {
  const socket = getSocket();
  if (!socket) {
    console.warn("[GTSS] Socket.IO not available, falling back to polling");
    return { off() {} };
  }

  const entries = Object.entries(eventMap);
  entries.forEach(([event, handler]) => {
    socket.on(event, handler);
  });

  return {
    off() {
      entries.forEach(([event, handler]) => {
        socket.off(event, handler);
      });
    },
    socket,
  };
}

/**
 * Subscribe to a room for targeted events.
 */
function joinRoom(room) {
  const socket = getSocket();
  if (socket) socket.emit("subscribe", room);
}

function leaveRoom(room) {
  const socket = getSocket();
  if (socket) socket.emit("unsubscribe", room);
}
