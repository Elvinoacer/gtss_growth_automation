/**
 * cronRegistry.js
 * Central manager for all node-cron tasks in the system.
 * Supports runtime registration, unregistration, and reload.
 */
const cron = require('node-cron');
const logger = require('../utils/logger');

const registry = new Map(); // id → { task, expression, name }

function register(id, expression, fn, name = id) {
  if (registry.has(id)) unregister(id);
  if (!cron.validate(expression)) {
    logger.warn('CRON', `Invalid cron expression for "${id}": ${expression}`);
    return false;
  }
  const task = cron.schedule(expression, fn, { name: id });
  registry.set(id, { task, expression, name });
  logger.info('CRON', `Registered cron "${id}" (${name}): ${expression}`);
  return true;
}

function unregister(id) {
  const entry = registry.get(id);
  if (!entry) return false;
  entry.task.stop();
  registry.delete(id);
  logger.info('CRON', `Unregistered cron "${id}"`);
  return true;
}

function reload(id, newExpression, fn, name) {
  return register(id, newExpression, fn, name);
}

function listAll() {
  return [...registry.entries()].map(([id, { expression, name }]) => ({
    id, expression, name,
  }));
}

function isRegistered(id) {
  return registry.has(id);
}

module.exports = { register, unregister, reload, listAll, isRegistered };
