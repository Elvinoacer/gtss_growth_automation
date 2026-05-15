const logger = require('./logger');
const path = require('path');

/**
 * 404 Not Found Handler
 */
function notFoundHandler(req, res) {
  res.status(404);
  
  if (req.accepts('html')) {
    // If it's a browser request, serve the 404 page
    res.sendFile(path.join(__dirname, '..', '..', 'public', 'pages', '404.html'));
  } else {
    // Otherwise return JSON
    res.json({ error: 'Not Found', code: 404 });
  }
}

/**
 * Global Error Handler Middleware
 */
function errorHandler(err, req, res, next) {
  const timestamp = new Date().toISOString();
  logger.error('EXPRESS', `Unhandled error at ${req.method} ${req.url}`, err);
  
  const status = err.status || 500;
  res.status(status).json({
    error: 'Internal error',
    message: process.env.NODE_ENV === 'production' ? 'An unexpected error occurred' : err.message,
    code: status,
    timestamp
  });
}

/**
 * Async wrapper for routes to catch errors
 */
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = {
  notFoundHandler,
  errorHandler,
  asyncHandler
};
