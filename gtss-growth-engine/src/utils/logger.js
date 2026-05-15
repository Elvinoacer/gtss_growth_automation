const fs = require('fs');
const path = require('path');

const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3
};

const CURRENT_LEVEL = process.env.NODE_ENV === 'production' ? LOG_LEVELS.INFO : LOG_LEVELS.DEBUG;

function formatMessage(level, moduleName, message, data) {
  const timestamp = new Date().toISOString();
  let logLine = `[${timestamp}] [${level}] [${moduleName}] ${message}`;
  if (data) {
    if (data instanceof Error) {
      logLine += ` ${data.stack}`;
    } else {
      logLine += ` ${JSON.stringify(data)}`;
    }
  }
  return logLine;
}

function normalizeArgs(moduleName, message, data) {
  if (typeof message === 'undefined') {
    return {
      moduleName: 'APP',
      message: moduleName,
      data: undefined
    };
  }

  if (typeof message !== 'string') {
    return {
      moduleName: 'APP',
      message: moduleName,
      data: message
    };
  }

  return { moduleName, message, data };
}

function log(level, moduleName, message, data) {
  if (LOG_LEVELS[level] < CURRENT_LEVEL) return;

  const normalized = normalizeArgs(moduleName, message, data);
  const logLine = formatMessage(level, normalized.moduleName, normalized.message, normalized.data);
  
  switch (level) {
    case 'DEBUG':
    case 'INFO':
      console.log(logLine);
      break;
    case 'WARN':
      console.warn(logLine);
      break;
    case 'ERROR':
      console.error(logLine);
      break;
  }
}

module.exports = {
  debug: (moduleName, message, data) => log('DEBUG', moduleName, message, data),
  info: (moduleName, message, data) => log('INFO', moduleName, message, data),
  warn: (moduleName, message, data) => log('WARN', moduleName, message, data),
  error: (moduleName, message, data) => log('ERROR', moduleName, message, data),
  log // For generic use
};
