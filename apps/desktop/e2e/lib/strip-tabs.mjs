/**
 * Selecting a top-strip tab the way a person can (VC-614).
 *
 * A group is one summary, not hidden copies of its member tabs. Visible pane
 * tabs can be clicked; an off-screen member is reached through its group's
 * actual menu. Descriptors name that target without fabricating a locator for
 * an element the new presentation deliberately does not mount.
 */

/** The menu row a tab's accessible name belongs to: `"<label>, pane <n>…"`. */
export function menuRowIndexFor(name, rowLabels) {
  let best = -1;
  let bestLength = -1;
  rowLabels.forEach((rowLabel, index) => {
    const label = (rowLabel ?? "").replace(/, pane \d+.*$/, "");
    // A tab's name can carry a hint after its label ("…\nWaiting for you").
    if (label.length > 0 && label.length > bestLength && name.startsWith(label)) {
      best = index;
      bestLength = label.length;
    }
  });
  return best;
}

/**
 * Select `tab` (a Playwright locator for one `role="tab"` element on the top
 * strip). Visible: click it. Folded into a summarized chip: open the chip's
 * menu and choose its row.
 */
export async function selectStripTab(page, tab, { timeout = 8000 } = {}) {
  const descriptor = typeof tab.first === "function" ? null : tab;
  const target = descriptor
    ? descriptor.id
      ? page
          .locator(`[data-strip-tab-id=${JSON.stringify(descriptor.id)}]`)
          .getByRole("tab")
          .filter({ visible: true })
          .first()
      : page
          .locator('[data-slot="tab-strip"] [data-strip-tab-id]')
          .getByRole("tab", { name: descriptor.label, exact: true })
          .filter({ visible: true })
          .first()
    : tab.first();
  if (await target.isVisible().catch(() => false)) {
    // Activate the tab itself, never the hover-revealed action button
    // that can occupy the centre of a compact icon-only tab.
    await target.focus({ timeout });
    await target.press("Enter", { timeout });
    await page.mouse.move(0, 0);
    return;
  }
  const name = descriptor?.label ?? (descriptor?.id || (await target.getAttribute("aria-label")));
  const chips = page.locator('[data-slot="grouped-tab-chip"]').filter({ visible: true });
  for (let i = 0; i < (await chips.count()); i++) {
    const chip = chips.nth(i);
    await chip.hover();
    await chip.getByRole("button", { name: /^Actions for / }).click({ timeout });
    const menu = page.getByRole("menu").filter({ has: page.locator("[data-tab-id]") });
    await menu.waitFor({ state: "visible", timeout });
    const rows = menu.locator("[data-tab-id]");
    const labels = await rows.evaluateAll((elements) =>
      elements.map((element) => element.querySelector(".truncate.text-ui")?.textContent ?? ""),
    );
    const row = descriptor?.id
      ? rows.and(page.locator(`[data-tab-id=${JSON.stringify(descriptor.id)}]`))
      : rows.nth(menuRowIndexFor(name, labels));
    if (descriptor?.id ? (await row.count()) > 0 : menuRowIndexFor(name, labels) >= 0) {
      await row.click({ timeout });
      await menu.waitFor({ state: "detached", timeout });
      await chip.and(page.locator('[data-active="true"]')).waitFor({ timeout });
      await page.mouse.move(0, 0);
      return;
    }
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached", timeout });
  }
  throw new Error(`no visible tab or group-menu member for ${name}`);
}
