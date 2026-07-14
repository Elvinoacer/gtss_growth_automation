/**
 * bridge-server/index.js — Public entry point for
 * `require("../main/bridge-server")`.
 *
 * Preserves the EXACT module.exports surface of the original
 * bridge-server.js monolith:
 *   module.exports = { BridgeServer, DEFAULT_BRIDGE_PORT: DEFAULT_PORT }
 *
 * The split files live one directory deeper than the original, so every
 * require() in the original file — `require("http")`, `require("fs")`,
 * `require("path")` — is unchanged (all Node built-ins, unaffected by
 * directory moves).
 *
 * File manifest:
 *   constants.js          — DEFAULT_PORT (9224) + PLATFORMS list
 *   routeHandlers.js      — every route handler + dispatchRoute()
 *   bridgeServerClass.js  — BridgeServer class (constructor + start/stop +
 *                           _handle/_readJson/_route + sentinel helpers)
 *   index.js              — this file; re-exports BridgeServer +
 *                           DEFAULT_BRIDGE_PORT
 */

const { BridgeServer } = require("./bridgeServerClass");
const { DEFAULT_PORT } = require("./constants");

module.exports = {
  BridgeServer,
  DEFAULT_BRIDGE_PORT: DEFAULT_PORT,
};
