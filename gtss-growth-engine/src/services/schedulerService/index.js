/**
 * Scheduler Service — Index
 * Re-exports the public API of the schedulerService module so callers
 * that `require('../services/schedulerService')` continue to receive
 * the exact same shape as the original schedulerService.js (~2,486
 * lines) which was split into thematic files inside this directory for
 * maintainability.
 *
 * See individual file headers for detail on each concern.
 */

const {
  registerJobStream,
  emitJobEvent,
  closeJobStream,
} = require("./jobStreams");
const { POST_CHAR_LIMITS } = require("./constants");
const { preparePlatformPostBody } = require("./textNormalization");
const {
  getPostMediaPaths,
  getPrimaryPostMediaPath,
  getPostLocationTag,
  isLibraryMediaPath,
  deleteMediaFiles,
  deleteMediaFile,
  resolveMediaFilePath,
} = require("./mediaPaths");
const { publishPost } = require("./publishPost");
const { generateCaption } = require("./generateCaption");

module.exports = {
  publishPost,
  generateCaption,
  registerJobStream,
  emitJobEvent,
  closeJobStream,
  POST_CHAR_LIMITS,
  preparePlatformPostBody,
  getPostMediaPaths,
  getPrimaryPostMediaPath,
  getPostLocationTag,
  isLibraryMediaPath,
  deleteMediaFiles,
  deleteMediaFile,
  resolveMediaFilePath,
};
