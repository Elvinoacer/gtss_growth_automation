/**
 * Socket.IO Service — Central real-time event hub
 * 
 * Usage from any backend module:
 *   const { getIO, emitTo } = require('../services/socketService');
 *   emitTo('automation', 'queue:updated', data);
 */

const { Server } = require("socket.io");
const logger = require("../utils/logger");

let io = null;

/**
 * Initialize Socket.IO on the HTTP server.
 * Call once from server.js after app.listen().
 */
function initSocketIO(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: "*" },
    // Avoid conflicts with Express routes
    path: "/socket.io",
    // Ping every 25s, timeout after 60s
    pingInterval: 25000,
    pingTimeout: 60000,
  });

  io.on("connection", (socket) => {
    logger.info("SOCKET", `Client connected: ${socket.id}`);

    // Clients can join specific rooms for targeted updates
    socket.on("subscribe", (rooms) => {
      const roomList = Array.isArray(rooms) ? rooms : [rooms];
      roomList.forEach((room) => {
        socket.join(room);
        logger.info("SOCKET", `${socket.id} joined room: ${room}`);
      });
    });

    socket.on("unsubscribe", (rooms) => {
      const roomList = Array.isArray(rooms) ? rooms : [rooms];
      roomList.forEach((room) => socket.leave(room));
    });

    socket.on("disconnect", (reason) => {
      logger.info("SOCKET", `Client disconnected: ${socket.id} (${reason})`);
    });
  });

  logger.info("SOCKET", "Socket.IO initialized");
  return io;
}

/**
 * Get the Socket.IO server instance.
 */
function getIO() {
  return io;
}

/**
 * Emit an event to a specific room (or broadcast if room is null).
 * This is the primary API for backend modules to push real-time updates.
 * 
 * @param {string|null} room - Room name (e.g. 'automation', 'discovery') or null for broadcast
 * @param {string} event - Event name (e.g. 'queue:updated', 'leads:new')
 * @param {*} data - Payload
 */
function emitTo(room, event, data) {
  if (!io) return;
  if (room) {
    io.to(room).emit(event, data);
  } else {
    io.emit(event, data);
  }
}

/**
 * Broadcast to ALL connected clients. 
 * Use for global events like stats updates, session changes.
 */
function broadcast(event, data) {
  if (!io) return;
  io.emit(event, data);
}

module.exports = {
  initSocketIO,
  getIO,
  emitTo,
  broadcast,
};
