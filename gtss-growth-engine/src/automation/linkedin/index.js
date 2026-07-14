/**
 * LinkedIn Automation Module — Index
 * Re-exports the public API of the LinkedIn automation module so callers that
 * `require('./linkedin')` continue to receive the exact same shape.
 *
 * The original linkedin.js (~4,652 lines) was split into thematic files
 * inside this directory for maintainability. See individual file headers
 * for detail on each concern.
 */

const { sendConnectionRequest } = require("./connectionActions");
const { sendDirectMessage } = require("./directMessage");
const { likeRecentPost } = require("./postActions");

const { findProfileMessageAction } = require("./profileActions");
const { findBestDmEditor, findBestDmOverlay, waitForDmEditor } = require("./dmEditorDetection");
const { activateDmEditor } = require("./typing");
const { typeFast, typeInChunks, typeLikeHuman } = require("./typeStrategies");
const { pasteTextViaClipboard, setEditorTextWithDomEvents } = require("./editorPaste");
const { forceClearDmDraft } = require("./editorVerification");
const { waitForEditorText } = require("./editorText");
const { findSendButtonForEditor, clickSendButtonRobust } = require("./sendActions");
const { waitForEditorInteractive } = require("./dmEditorInteraction");
const { detectMessagingBlocked, detectPremiumRequired } = require("./detection");
const { detectMessagingContext, dismissPremiumDialog } = require("./messagingFrame");
const { verifyModalRecipient } = require("./editorLocator");

module.exports = {
  sendConnectionRequest,
  sendDirectMessage,
  likeRecentPost,
  __private: {
    findProfileMessageAction,
    findBestDmEditor,
    findBestDmOverlay,
    activateDmEditor,
    typeFast,
    typeLikeHuman,
    typeInChunks,
    pasteTextViaClipboard,
    setEditorTextWithDomEvents,
    forceClearDmDraft,
    waitForEditorText,
    findSendButtonForEditor,
    clickSendButtonRobust,
    waitForEditorInteractive,
    waitForDmEditor,
    detectMessagingBlocked,
    detectPremiumRequired,
    detectMessagingContext,
    dismissPremiumDialog,
    verifyModalRecipient,
  },
};
