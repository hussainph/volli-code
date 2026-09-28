/**
 * VC-419 — keyboard ticket navigation keeps its focus and its list context.
 *
 * VC-322's release pass found the blocker this probe pins down: on the built
 * app, Enter on a focused board card or list row OPENS the ticket but drops
 * `document.activeElement` to BODY, and Escape from the ticket's primary tab
 * RETURNS to the board but leaves focus on BODY rather than the card or row the
 * journey started from. Both keys work; the focus handoff and the return are
 * what is missing — a keyboard-only reader loses their place on every round
 * trip.
 *
 * The unit tests own the pure decisions (`lib/ticket-focus-origin.test.ts` —
 * which neighbour inherits focus when the origin is gone) and the wiring in
 * jsdom (`hooks/use-ticket-focus-handoff.test.tsx`). What only a running,
 * BUILT app can answer is the part those cannot fake: real dnd-kit focus
 * attributes on the card, the real Escape guard, the board genuinely
 * re-mounting from scratch on return, and the column WINDOW (VC-316) having
 * unmounted the very card focus has to come home to.
 *
 * The numbered checks, each keyboard-only:
 *
 *   1. Board card Enter hands focus INTO the ticket (heading or primary tab),
 *      not BODY.
 *   2. Escape from the ticket's primary tab returns focus to the originating
 *      CARD.
 *   3. List row Enter hands focus into the ticket.
 *   4. Escape returns focus to the originating ROW.
 *   5. Back navigation (⌘[) out of a ticket restores the card too — Escape is
 *      not the only way out.
 *   6. FILTERED origin: with a priority facet on, the round trip returns to the
 *      card inside the filtered board.
 *   7. Origin FILTERED OUT while the ticket is open, by a change made to the
 *      ticket itself: focus lands on a sensible NEIGHBOUR card, never BODY.
 *   8. Origin MOVED to another column while the ticket is open: focus follows
 *      the ticket to its new card rather than to where it used to sit.
 *      (A DELETED origin takes the same path as 7 — the id simply stops being
 *      shown — and is asserted directly in `ticket-focus-origin.test.ts`; the
 *      built app has no in-ticket control that archives the ticket you are
 *      standing in, so this probe does not stage one.)
 *   9. VIRTUALIZED origin: a card far down a 60-card column — unmounted by the
 *      window after the board re-mounts — is brought back and refocused.
 *
 * Every check reports what actually holds focus, and the whole run is written
 * to `<evidence>/report.json` so a baseline and a candidate can be diffed.
 *
 * MANUALLY-RUN (needs a display + the built app); not wired into `vp test` and
 * not run in CI.
 *
 *   vp run --filter @volli/desktop build
 *   node apps/desktop/e2e/vc419-keyboard-ticket-focus.mjs [evidence-dir]
 *
 * macOS only: check 5 drives ⌘[, and smoke-kit's Electron path is an
 * `Electron.app` bundle either way.
 */
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import {
  assertBuiltRendererLoaded,
  assertProfileIsolated,
  createRunner,
  evidenceDir,
  launch,
  makeGitRepo,
  makeScratch,
  readSeededProjects,
  seedProjects,
  sleep,
  waitUntil,
} from "./lib/smoke-kit.mjs";

if (process.platform !== "darwin") {
  console.error(
    `vc419-keyboard-ticket-focus is macOS-only (got platform "${process.platform}"): the back-navigation ` +
      "check drives ⌘[, and the built app under test is an Electron.app bundle.",
  );
  process.exit(1);
}

const TODO_COUNT = 60;
/** Long enough for a close to settle and any focus move to land — VC-322 confirmed its BODY reading at +250ms. */
const SETTLE_MS = 400;

const evidence = await evidenceDir("vc419-keyboard-ticket-focus");
const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("volli-vc419-");
const { attempt, must, summarize } = createRunner();

const project = await makeGitRepo(scratch, "project-");
const app = await launch({
  dbPath,
  userDataDir,
  extraEnv: { HOME: join(scratch, "home"), VOLLI_AGENT_HOME: join(scratch, "home") },
});
const page = await app.firstWindow();
page.setDefaultTimeout(10_000);

const report = {
  sha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  dirty: execFileSync("git", ["status", "--short"], { encoding: "utf8" }),
  startedAt: new Date().toISOString(),
  checks: [],
};

/** What holds focus right now, in the terms VC-322's finding was written in. */
const active = () =>
  page.evaluate(() => {
    const element = document.activeElement;
    if (element === null) return { tag: null };
    return {
      tag: element.tagName,
      role: element.getAttribute("role"),
      ariaSelected: element.getAttribute("aria-selected"),
      label: element.getAttribute("aria-label"),
      text: element.textContent?.slice(0, 80) ?? null,
      boardSlot:
        element.closest("[data-board-ticket-slot]")?.getAttribute("data-board-ticket-slot") ?? null,
      ticketId: element.getAttribute("data-ticket-id"),
      focusVisible: element.matches(":focus-visible"),
    };
  });

/** Records the check's own verdict AND what focus was doing, pass or fail. */
async function record(name, detail) {
  report.checks.push({ name, ...detail });
  return detail;
}

const boardCard = (ticketId) =>
  page.locator(`[data-board-ticket-slot="${ticketId}"] > [role=button]`);
const listRow = (displayId) => page.locator(`[data-ticket-row][data-ticket-id="${displayId}"]`);

/** True when focus sits on exactly this element. */
const holdsFocus = (locator) =>
  locator.evaluate((element) => element === document.activeElement).catch(() => false);

/**
 * Focus lives INSIDE the open ticket, on something a reader can act on: the
 * ticket heading or a tab in its primary strip. BODY is the failure VC-322 saw.
 */
async function ticketEntryFocus() {
  const where = await active();
  const ok = where.tag === "H1" || where.role === "tab";
  return { pass: ok, focus: where };
}

async function openTicketByKeyboard(locator) {
  await locator.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("tablist", { name: "Ticket tabs" }).waitFor();
  await sleep(SETTLE_MS);
}

/** Put focus on the primary strip's selected tab — VC-322's exact Escape origin. */
async function focusPrimaryTab() {
  await page.getByRole("tablist", { name: "Ticket tabs" }).getByRole("tab").first().focus();
}

async function leaveTicket(how) {
  if (how === "escape") await page.keyboard.press("Escape");
  else await page.keyboard.press("Meta+BracketLeft");
  await page.getByRole("button", { name: "Board view", exact: true }).waitFor();
  await sleep(SETTLE_MS);
}

async function goToView(name) {
  await page.getByRole("button", { name, exact: true }).click();
  await sleep(200);
}

try {
  await page.waitForLoadState("domcontentloaded");
  assertBuiltRendererLoaded(page);
  await assertProfileIsolated(app, userDataDir);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900),
  );

  await seedProjects(page, [
    { id: "kb-project", name: "Keyboard navigation", path: project, prefix: "KB" },
  ]);
  const { byName } = await readSeededProjects(page);
  const projectId = byName["Keyboard navigation"].id;

  // 60 Todo cards: past COLUMN_WINDOW_MINIMUM (40), so the column really does
  // window and check 8 has an unmounted origin to come home to. Three High
  // cards give the priority facet something to filter down to.
  await page.evaluate(
    async ({ id, count }) => {
      for (let n = 1; n <= count; n++) {
        await window.api.tickets.create({
          projectId: id,
          title: `Todo ${n}`,
          status: "todo",
          priority: n === 8 || n === 9 || n === 10 ? "high" : "medium",
          description: "# Keyboard fixture\n\nOpened and left with the keyboard only.",
        });
      }
    },
    { id: projectId, count: TODO_COUNT },
  );
  await page.reload();
  await page.getByRole("button", { name: "New ticket", exact: true }).waitFor();

  // The authoritative list, not the DOM's: a windowed column mounts ~40 of the
  // 60 cards, and check 8's origin is deliberately one of the ones it does not.
  const idByTitle = await page.evaluate(async (id) => {
    const boot = await window.api.data.bootstrap();
    const rows = boot.ok ? (boot.data.ticketsByProject[id] ?? []) : [];
    const map = {};
    for (const ticket of rows) {
      map[ticket.title] = { id: ticket.id, display: `KB-${ticket.ticketNumber}` };
    }
    return map;
  }, projectId);

  const idOf = (title) => idByTitle[title]?.id ?? null;
  const displayOf = (title) => idByTitle[title]?.display ?? null;

  await must(0, "fixture: the windowed Todo column seeded and rendered", async () => {
    const mounted = await page.locator("[data-board-ticket-slot]").count();
    return {
      ok: idOf(`Todo ${TODO_COUNT}`) !== null && mounted > 0 && mounted < TODO_COUNT,
      detail: `${Object.keys(idByTitle).length} tickets seeded, ${mounted} cards mounted`,
    };
  });

  await page.screenshot({ path: join(evidence, "board.png") });

  // ── 1 & 2 · board card round trip ────────────────────────────────────────
  await attempt(1, "Board card Enter hands focus into the ticket", async () => {
    await openTicketByKeyboard(boardCard(idOf("Todo 1")));
    const { pass, focus } = await ticketEntryFocus();
    await record("1 board Enter entry focus", { pass, focus });
    await page.screenshot({ path: join(evidence, "ticket-entry.png") });
    return { ok: pass, detail: `focus: ${focus.tag}/${focus.role ?? "-"}` };
  });

  await attempt(2, "Escape from the primary tab returns focus to the board card", async () => {
    await focusPrimaryTab();
    await leaveTicket("escape");
    const card = boardCard(idOf("Todo 1"));
    const ok = await holdsFocus(card);
    const focus = await active();
    await record("2 board Escape return focus", { pass: ok, focus });
    return {
      ok,
      detail: `focus: ${focus.tag}/${focus.role ?? "-"} slot=${focus.boardSlot ?? "-"}`,
    };
  });

  // ── 3 & 4 · list row round trip ──────────────────────────────────────────
  await attempt(3, "List row Enter hands focus into the ticket", async () => {
    await goToView("List view");
    await openTicketByKeyboard(listRow(displayOf("Todo 2")));
    const { pass, focus } = await ticketEntryFocus();
    await record("3 list Enter entry focus", { pass, focus });
    return { ok: pass, detail: `focus: ${focus.tag}/${focus.role ?? "-"}` };
  });

  await attempt(4, "Escape returns focus to the originating list row", async () => {
    await focusPrimaryTab();
    await leaveTicket("escape");
    const row = listRow(displayOf("Todo 2"));
    const ok = await holdsFocus(row);
    const focus = await active();
    await record("4 list Escape return focus", { pass: ok, focus });
    return { ok, detail: `focus: ${focus.tag}/${focus.role ?? "-"} row=${focus.ticketId ?? "-"}` };
  });

  // ── 5 · back navigation, not just Escape ─────────────────────────────────
  await attempt(5, "Back navigation (⌘[) restores the originating card", async () => {
    await goToView("Board view");
    await openTicketByKeyboard(boardCard(idOf("Todo 4")));
    await focusPrimaryTab();
    await leaveTicket("back");
    const ok = await holdsFocus(boardCard(idOf("Todo 4")));
    const focus = await active();
    await record("5 back navigation return focus", { pass: ok, focus });
    return {
      ok,
      detail: `focus: ${focus.tag}/${focus.role ?? "-"} slot=${focus.boardSlot ?? "-"}`,
    };
  });

  // ── 6 · filtered board ───────────────────────────────────────────────────
  await attempt(6, "Filtered board: the round trip returns to the card", async () => {
    await page.getByRole("button", { name: "Priority", exact: false }).first().click();
    await page.getByRole("menuitemcheckbox", { name: "High" }).click();
    await page.keyboard.press("Escape");
    await sleep(300);
    await waitUntil(
      "only the High cards remain",
      async () => (await page.locator("[data-board-ticket-slot]").count()) === 3,
      { timeout: 6000 },
    );
    await openTicketByKeyboard(boardCard(idOf("Todo 9")));
    await focusPrimaryTab();
    await leaveTicket("escape");
    const ok = await holdsFocus(boardCard(idOf("Todo 9")));
    const focus = await active();
    await record("6 filtered board return focus", { pass: ok, focus });
    return {
      ok,
      detail: `focus: ${focus.tag}/${focus.role ?? "-"} slot=${focus.boardSlot ?? "-"}`,
    };
  });

  // ── 7 · the origin is gone by the time focus comes home ──────────────────
  await attempt(7, "Origin filtered out while open: a neighbour card takes focus", async () => {
    await openTicketByKeyboard(boardCard(idOf("Todo 9")));
    // Through the ticket's OWN control, which is how a person would do it — and
    // what makes the board hear about it before focus comes home.
    await page
      .getByRole("button", { name: /^Priority: / })
      .first()
      .click();
    await page.getByRole("menuitemradio", { name: "Low" }).click();
    await sleep(400);
    await focusPrimaryTab();
    await leaveTicket("escape");
    const focus = await active();
    const neighbours = [idOf("Todo 8"), idOf("Todo 10")];
    const ok = focus.boardSlot !== null && neighbours.includes(focus.boardSlot);
    await record("7 filtered-out origin neighbour focus", { pass: ok, focus, neighbours });
    return {
      ok,
      detail: `focus: ${focus.tag}/${focus.role ?? "-"} slot=${focus.boardSlot ?? "-"}`,
    };
  });

  // ── 8 · the origin left its column while the ticket was open ────────────
  await attempt(8, "Origin moved to another column: focus follows the ticket", async () => {
    await openTicketByKeyboard(boardCard(idOf("Todo 10")));
    await page
      .getByRole("button", { name: /^Status: / })
      .first()
      .click();
    await page.getByRole("menuitemradio", { name: "Done" }).click();
    await sleep(400);
    await focusPrimaryTab();
    await leaveTicket("escape");
    const ok = await holdsFocus(boardCard(idOf("Todo 10")));
    const focus = await active();
    const column = await page.evaluate(
      () =>
        document.activeElement?.closest("[data-board-column]")?.getAttribute("data-board-column") ??
        null,
    );
    await record("8 moved origin follows the ticket", { pass: ok, focus, column });
    return { ok, detail: `focus: ${focus.tag}/${focus.role ?? "-"} column=${column ?? "-"}` };
  });

  // ── 9 · the origin the window unmounted ──────────────────────────────────
  await attempt(9, "Virtualized origin far down the column is refocused", async () => {
    await page.getByRole("button", { name: "Clear", exact: true }).click();
    await sleep(600);
    // Scroll the Todo column to the deep card, then take it by keyboard.
    const deep = idOf("Todo 58") ?? null;
    if (deep === null) return { ok: false, detail: "Todo 58 never mounted; fixture too small" };
    await page.evaluate(() => {
      const scroller = document.querySelector("[data-column-scroller='todo']");
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });
    await sleep(600);
    // `focus()` scrolls the card into view itself, which is what mounts it; the
    // manual scroll above only brings the column into the neighbourhood.
    await openTicketByKeyboard(boardCard(deep));
    await focusPrimaryTab();
    await leaveTicket("escape");
    const mountedAfterReturn = await boardCard(deep).count();
    const ok = await holdsFocus(boardCard(deep));
    const focus = await active();
    await record("9 virtualized origin return focus", { pass: ok, focus, mountedAfterReturn });
    await page.screenshot({ path: join(evidence, "virtualized-return.png") });
    return {
      ok,
      detail: `focus: ${focus.tag}/${focus.role ?? "-"} slot=${focus.boardSlot ?? "-"} mounted=${mountedAfterReturn}`,
    };
  });
} catch (error) {
  console.error(`vc419 probe aborted: ${error?.stack ?? error}`);
  report.aborted = String(error?.message ?? error);
} finally {
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(join(evidence, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nreport: ${join(evidence, "report.json")}`);
  const code = summarize();
  await app.close().catch(() => {});
  await cleanup().catch(() => {});
  process.exit(code);
}
