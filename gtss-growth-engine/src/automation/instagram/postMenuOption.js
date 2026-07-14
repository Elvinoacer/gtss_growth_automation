/**
 * Instagram Post Menu Option
 * clickInstagramPostMenuOption — click the "Post" item inside Instagram's
 * create-post sidebar menu. Tries DOM-level evaluation first (to bypass
 * Playwright's coordinate-based interception) and falls back to
 * getByRole/getByText locators.
 * Extracted from the original instagram.js for maintainability.
 */

async function clickInstagramPostMenuOption(page) {
  const clickedViaDom = await page
    .evaluate(() => {
      const isVisible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return (
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          rect.width > 0 &&
          rect.height > 0
        );
      };

      const clickableAncestor = (el) => {
        let node = el;
        while (node && node !== document.body) {
          if (
            node.matches?.(
              'a, button, [role="button"], [role="menuitem"], [tabindex="0"]',
            )
          ) {
            return node;
          }
          node = node.parentElement;
        }
        return el;
      };

      const candidates = [...document.querySelectorAll("span, div, a, button")]
        .filter((el) => (el.textContent || "").trim() === "Post")
        .map((el) => {
          const target = clickableAncestor(el);
          const rect = target.getBoundingClientRect();
          return { el, target, rect };
        })
        .filter(({ target, rect }) => {
          if (!isVisible(target)) return false;
          const nearSidebarMenu = rect.left < 420 && rect.top > 40;
          const reasonableMenuRow = rect.width <= 360 && rect.height <= 90;
          return nearSidebarMenu && reasonableMenuRow;
        })
        .sort((a, b) => a.rect.left - b.rect.left || a.rect.top - b.rect.top);

      const match = candidates[0];
      if (!match) return false;
      match.target.click();
      return true;
    })
    .catch(() => false);

  if (clickedViaDom) return true;

  const postOption = page
    .getByRole("link", { name: "Post", exact: true })
    .or(page.getByRole("button", { name: "Post", exact: true }))
    .or(page.getByText("Post", { exact: true }))
    .first();

  await postOption.waitFor({ state: "visible", timeout: 6000 });
  await postOption.click().catch(async () => {
    await postOption.click({ force: true });
  });
  return true;
}

module.exports = { clickInstagramPostMenuOption };
