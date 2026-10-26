/**
 * Selecting a top-strip tab the way a person can (VC-614).
 *
 * A tab group that is not on screen draws SUMMARIZED: its first pane's front,
 * then a `+n` that folds the other panes (`grouped-tab-chip.css`). A folded
 * segment is still in the DOM, but hidden, so a probe that clicks it waits out
 * its timeout. A person picks it from the chip's right-click menu instead,
 * which brings that tab to the front of ITS pane and focuses that pane, so
 * this helper does the same: a visible tab is clicked, a folded one is chosen
 * from its chip's menu row.
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
  const target = tab.first();
  await target.waitFor({ state: "attached", timeout });
  if (await target.isVisible()) {
    await target.click({ timeout });
    return;
  }
  const name = (await target.getAttribute("aria-label")) ?? "";
  const chip = target.locator('xpath=ancestor::*[@data-slot="grouped-tab-chip"][1]');
  if ((await chip.count()) === 0)
    throw new Error(`top-strip tab "${name}" is hidden and in no group chip`);
  await chip.click({ button: "right", timeout });
  const rows = page.locator('[data-slot="grouped-tab-menu"] [data-pane]');
  await rows.first().waitFor({ timeout });
  const labels = await rows.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("aria-label")),
  );
  const index = menuRowIndexFor(name, labels);
  if (index < 0) throw new Error(`no group-menu row for "${name}" in ${JSON.stringify(labels)}`);
  await rows.nth(index).click({ timeout });
  // Settle before handing back. Closing the menu returns focus to the chip as
  // its content unmounts (Radix's close auto-focus); a caller that opens a
  // focus-dismissed surface next — the Island's pinned card — would otherwise
  // see that focus move as "focus left" and close under its own click.
  await page.locator('[data-slot="grouped-tab-menu"]').waitFor({ state: "detached", timeout });
  await chip.and(page.locator('[data-active="true"]')).waitFor({ timeout });
}
