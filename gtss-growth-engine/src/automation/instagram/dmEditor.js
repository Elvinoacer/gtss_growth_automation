/**
 * Instagram DM Editor Helpers
 * verifyDelivery, normalizeEditableText, getEditableText, and
 * setComposerTextWithDomEvents — primitives used by the sendDM flow.
 * Extracted from the original instagram.js for maintainability.
 */

function normalizeEditableText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function getEditableText(locator) {
  const fromEvaluate = await locator
    .evaluate((el) => {
      const tagName = String(el.tagName || "").toLowerCase();
      if (tagName === "textarea" || tagName === "input") {
        return String(el.value || "");
      }
      return String(el.innerText || el.textContent || "");
    })
    .catch(() => "");
  const evaluatedText = String(fromEvaluate || "");
  if (evaluatedText && !/^(flex-start|flex-end|start|end|center)$/i.test(evaluatedText.trim())) {
    return evaluatedText;
  }

  return locator.innerText?.().catch(() => "") || "";
}

async function setComposerTextWithDomEvents(locator, message) {
  const value = String(message || "");
  if (!value) return false;

  await locator
    .evaluate((el, text) => {
      const tagName = String(el.tagName || "").toLowerCase();
      el.focus({ preventScroll: false });

      if (tagName === "textarea" || tagName === "input") {
        const prototype =
          tagName === "textarea"
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
        if (descriptor?.set) descriptor.set.call(el, text);
        else el.value = text;
      } else {
        el.textContent = text;
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }

      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: text,
        }),
      );
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, value)
    .catch(() => {});

  const actual = normalizeEditableText(await getEditableText(locator));
  if (actual.includes(normalizeEditableText(value))) return true;

  let fillSucceeded = false;
  await locator
    .fill(value)
    .then(() => {
      fillSucceeded = true;
    })
    .catch(() => {});

  const afterFill = normalizeEditableText(await getEditableText(locator));
  return afterFill.includes(normalizeEditableText(value)) || fillSucceeded;
}

async function verifyDelivery(page, message) {
  const messages = page.locator(
    'div[role="row"], div[class*="message"], div[class*="bubble"], div[class*="message-text"]',
  );
  const msgCount = await messages.count().catch(() => 0);
  if (msgCount === 0) return false;

  const startIndex = Math.max(0, msgCount - 3);
  for (let i = msgCount - 1; i >= startIndex; i--) {
    const msg = messages.nth(i);
    const text = await msg.innerText().catch(() => "");
    if (text.includes(message)) {
      const alignStr = (await msg.getAttribute("style").catch(() => "")) || "";
      const classStr = (await msg.getAttribute("class").catch(() => "")) || "";
      const alignSelf = await msg
        .evaluate((el) => {
          const style = window.getComputedStyle(el);
          return (
            style.justifyContent || style.alignItems || style.alignSelf || ""
          );
        })
        .catch(() => "");

      const isSentByUs =
        alignStr.includes("flex-end") ||
        classStr.includes("sent") ||
        classStr.includes("owner") ||
        alignSelf.includes("end") ||
        alignSelf.includes("flex-end");

      if (isSentByUs) {
        return true;
      }
    }
  }
  return false;
}

module.exports = {
  verifyDelivery,
  normalizeEditableText,
  getEditableText,
  setComposerTextWithDomEvents,
};
