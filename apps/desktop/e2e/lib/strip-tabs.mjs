/**
 * Reaching a top-strip tab the way a person can (VC-614, VC-1052).
 *
 * A tab group draws ONE chip on a strip: main's direct tab — labeled from the
 * group (its title, else its front's label) and carrying the group's actions
 * — with no segments and no +N: the member tabs are not in the strip's DOM at
 * all. A person reaches them through the chip's popover (hover, right-click,
 * a press on its stacked glyph), whose rows list every tab of every pane in
 * pane order; choosing one brings it to the front of ITS pane and shows the
 * group. These helpers do the same. A tab drawn on a strip is activated
 * without landing on the hover-revealed "Actions for" control a tab can
 * carry: Enter on an ordinary tab, a click on a chip's front (a chip's Enter
 * is the keyboard path into its popover, not a selection). Any other member
 * is chosen from a chip's popover row.
 */

const CHIP = '[data-slot="grouped-tab-chip"]';
const POPOVER = '[data-slot="grouped-tab-popover"]';
const ROW = '[data-slot="grouped-tab-row"]';

/**
 * The popover row a tab belongs to, by the row titles — each row's primary
 * label (the first `.truncate.text-ui` inside it), the tab's bare label. A
 * tab's accessible name can carry a hint after its label (`"Chat\nWaiting for
 * you"`, `"page · 127.0.0.1:5173/x"`), so a name matches a title it starts
 * with — the LONGEST such title, so "Session 10" is never taken for
 * "Session 1".
 */
export function menuRowIndexFor(name, rowTitles) {
  let best = -1;
  let bestLength = -1;
  rowTitles.forEach((rowTitle, index) => {
    const title = (rowTitle ?? "").trim();
    if (title.length > 0 && title.length > bestLength && name.startsWith(title)) {
      best = index;
      bestLength = title.length;
    }
  });
  return best;
}

/** Every row of the open popover, in pane order. */
function readRows(popover) {
  return popover.locator(ROW).evaluateAll((rows) =>
    rows.map((row) => ({
      id: row.getAttribute("data-tab-id"),
      pane: Number(row.getAttribute("data-pane")),
      front: row.getAttribute("data-front") === "true",
      title: (row.querySelector(".truncate.text-ui")?.textContent ?? "").trim(),
      name: row.getAttribute("aria-label") ?? "",
    })),
  );
}

/**
 * Move the pointer somewhere inert: off every tab, chip, popover, button and
 * the Activity Island. A hover popover closes 160ms after the pointer leaves
 * its chip and itself, so this is how a probe closes one WITHOUT a key (an
 * Escape also reaches whatever has focus — it leaves a Ticket view) and
 * without a click (which moves focus and selection).
 */
export async function parkPointer(page) {
  const point = await page.evaluate(() => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const busy =
      '[role="tab"],[role="tablist"],[data-slot="grouped-tab-chip"],[data-slot="grouped-tab-popover"],' +
      "[data-activity-island],[data-island-card],button,a,input,textarea,[contenteditable]";
    const candidates = [
      [1, 1],
      [w - 2, 1],
      [1, h - 2],
      [w - 2, h - 2],
      [Math.round(w / 2), h - 2],
    ];
    const free = candidates.find(([x, y]) => {
      const hit = document.elementFromPoint(x, y);
      return hit === null || hit.closest(busy) === null;
    });
    return free ?? candidates[0];
  });
  await page.mouse.move(point[0], point[1]);
}

/**
 * The rows of `chip`'s popover, read by HOVER — the one opener that takes
 * neither focus nor selection (a right-click's mousedown focuses the chip's
 * tab) — then closed by parking the pointer. Each row: `{ id, pane, front,
 * title, name }`, with `pane` 1-based and `front` marking that pane's front.
 */
export async function readChipRows(page, chip, { timeout = 4000 } = {}) {
  const popover = page.locator(POPOVER);
  // From outside the chip, so the move below is a fresh `pointerenter`.
  await parkPointer(page);
  await popover.waitFor({ state: "detached", timeout });
  await chip.scrollIntoViewIfNeeded({ timeout });
  const box = await chip.boundingBox();
  if (box === null) throw new Error("group chip has no bounds to hover");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await popover.waitFor({ state: "visible", timeout });
  const rows = await readRows(popover);
  await parkPointer(page);
  await popover.waitFor({ state: "detached", timeout });
  return rows;
}

/**
 * Right-click a group chip and choose its Ungroup item.
 */
export async function ungroupChip(page, chip, { timeout = 8000 } = {}) {
  await chip.click({ button: "right", timeout });
  const popover = page.locator(POPOVER);
  await popover.locator('[data-slot="grouped-tab-ungroup"]').click({ timeout });
  await popover.waitFor({ state: "detached", timeout });
  await parkPointer(page);
}

/**
 * Select a top-strip tab. The target is either form the smokes have used:
 *
 * - a raw locator for the tab on a strip (main's shape), when it may be drawn
 *   there — an ordinary tab, or a chip's front;
 * - a descriptor: `{ tab, id, label }` (VC-1052's shape — `tab` as above) or
 *   bare `{ id }` / `{ label }` (main's shape), naming the tab wherever the
 *   strip draws it.
 *
 * A visible target is activated the way the strip wants: Enter for an
 * ordinary tab (never a click, which can land on the hover-revealed
 * "Actions for" control a compact icon-only tab carries where a person would
 * click), a click on a chip front's LABEL for a chip's front (a chip's Enter
 * is the keyboard path into its popover, not a selection). A bare descriptor
 * finds a tab drawn on a strip first — by its `data-strip-tab-id` (`id`) or
 * its accessible name (`label`, among tabs that carry one) — then falls back
 * to the chip search: every visible chip is right-clicked in turn until one
 * lists the tab — by `data-tab-id` when the id is known, else by
 * {@link menuRowIndexFor} over its popover rows' titles — whose row is
 * chosen; the helper returns once the popover is gone and that chip is
 * active. Polls until `timeout`, since the tab may still be arriving.
 */
export async function selectStripTab(
  page,
  target,
  { strip = page.locator("body"), timeout = 8000 } = {},
) {
  const { tab, id, label } = typeof target?.first === "function" ? { tab: target } : (target ?? {});
  const popover = page.locator(POPOVER);
  const deadline = Date.now() + timeout;
  const what = id ?? label ?? "a top-strip tab";
  for (;;) {
    const focus =
      tab !== undefined
        ? tab.first()
        : id !== undefined
          ? page
              .locator(`[data-strip-tab-id=${JSON.stringify(id)}]`)
              .getByRole("tab")
              .filter({ visible: true })
              .first()
          : label !== undefined
            ? page
                .locator('[data-slot="tab-strip"] [data-strip-tab-id]')
                .getByRole("tab", { name: label, exact: true })
                .filter({ visible: true })
                .first()
            : undefined;
    if (focus !== undefined && (await focus.isVisible().catch(() => false))) {
      const chip = focus.locator('xpath=ancestor::*[@data-slot="grouped-tab-chip"][1]');
      if ((await chip.count()) > 0) {
        // A chip's front: a person clicks its label — not the tab's centre
        // box, under which the hover-revealed "Actions for" control can sit,
        // and not Enter, which opens the popover (the keyboard path to the
        // rows) rather than selecting. A click on an ALREADY shown chip also
        // opens the popover; the pointer parked below closes it again.
        const labelSpan = focus.locator('[data-slot="tab-label"]');
        if (
          await labelSpan
            .first()
            .isVisible()
            .catch(() => false)
        ) {
          await labelSpan.first().click({ timeout });
        } else {
          await focus.click({ timeout });
        }
      } else {
        // Activate the tab itself, never the hover-revealed "Actions for"
        // control that can occupy the centre of a compact icon-only tab.
        await focus.focus({ timeout });
        await focus.press("Enter", { timeout });
      }
      // The pointer resting on any chip opens its popover on hover: close it
      // before handing back.
      await parkPointer(page);
      await popover.waitFor({ state: "detached", timeout });
      return;
    }
    if (id !== undefined || label !== undefined) {
      const groupIds = await strip
        .locator(`${CHIP}:visible`)
        .evaluateAll((chips) => chips.map((chip) => chip.getAttribute("data-group-id")));
      for (const groupId of groupIds) {
        const chip = strip.locator(`${CHIP}[data-group-id="${groupId}"]`).first();
        await chip.click({ button: "right", timeout });
        await popover.waitFor({ state: "visible", timeout });
        const rows = await readRows(popover);
        const index =
          id !== undefined
            ? rows.findIndex((row) => row.id === id)
            : menuRowIndexFor(
                label,
                rows.map((row) => row.title),
              );
        if (index < 0) {
          await parkPointer(page);
          await popover.waitFor({ state: "detached", timeout });
          continue;
        }
        await popover.locator(ROW).nth(index).click({ timeout });
        // Settle before handing back: a caller that opens a focus-dismissed
        // surface next — the Island's pinned card — must not see the popover's
        // unmount move focus under its own click.
        await popover.waitFor({ state: "detached", timeout });
        await chip.and(page.locator('[data-active="true"]')).waitFor({ timeout });
        await parkPointer(page);
        await popover.waitFor({ state: "detached", timeout });
        return;
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`"${what}" is neither on the strip nor in any group chip's popover`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
