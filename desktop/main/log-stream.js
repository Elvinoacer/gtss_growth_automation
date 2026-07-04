/**
 * LogStream — in-memory ring buffer of log lines.
 *
 * The renderer reads the last N lines via IPC and subscribes to new lines via
 * an event channel. We keep both stdout and stderr from the server and Chrome
 * plus our own lifecycle messages, all tagged with a source for filtering.
 */

const { EventEmitter } = require("events");

class LogStream extends EventEmitter {
  constructor({ maxLines = 5000 } = {}) {
    super();
    this.maxLines = maxLines;
    this.lines = [];
  }

  append(source, message) {
    if (Array.isArray(message)) {
      message = message.join(" ");
    }
    if (typeof message !== "string") {
      try {
        message = JSON.stringify(message);
      } catch (_) {
        message = String(message);
      }
    }
    // Split on newlines so multi-line messages stay readable.
    for (const line of message.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const entry = {
        ts: new Date().toISOString(),
        source,
        line,
      };
      this.lines.push(entry);
      if (this.lines.length > this.maxLines) {
        this.lines.shift();
      }
      this.emit("line", entry);
    }
  }

  /** Return the last N lines (default: all). */
  snapshot(n) {
    if (!n || n >= this.lines.length) return [...this.lines];
    return this.lines.slice(-n);
  }

  clear() {
    this.lines = [];
    this.emit("cleared");
  }
}

module.exports = { LogStream };
