/**
 * The ⌥ drag picker (VC-132), driven through the REAL packed app with a real
 * pointer and a real modifier key.
 *
 * What it proves, in dependency order:
 *   1. A drag over a column that offers something shows that column's Offered
 *      list, and the "⌥ to choose" hint near bottom-centre.
 *   2. Holding ⌥ mid-drag GROWS that column into landing targets: every offered
 *      row plus a Move only target, each carrying the digit that picks it.
 *   3. The armed Automation is pinned to digit `1`, so `1` reproduces a plain
 *      drop — and the hint hides once ⌥ is down.
 *   4. Nothing on the drag path offers a model override. The panel holds the
 *      Offered rows and Move only, and nothing else.
 *   5. A release on a NAMED Automation target opens the same 3500 ms window,
 *      with the same one Cancel, naming the Automation that was aimed at —
 *      never the column's armed default.
 *   6. A release on the Move only target moves the card and opens no window at
 *      all, in a column armed to fire.
 *   7. Releasing ⌥ collapses the picker without ending the drag, and Escape
 *      ends the drag itself — nothing moves and nothing starts.
 *
 * The digits and the state machine behind all of this are unit-tested at 100%
 * in `components/board/drag-picker-model.ts`; what needs a real app is that a
 * held modifier during a dnd-kit drag reaches it, that the panel is on screen
 * where a hand can aim at it, and that a picked release lands on the window
 * VC-128 built. That is what this drives.
 *
 * The live half of a Run needs provider credentials and spends tokens, so — as
 * in the arming smoke — this profile has no default model and every window here
 * is CANCELLED rather than left to fire. The window opening, naming the picked
 * Automation, is the claim under test.
 *
 * No fixed sleeps for a state: every wait is `waitUntil`/`waitFor` on a real
 * signal. The only bare waits are inside the drag itself, where a pointer has
 * to travel between two moves for dnd-kit's sensor to see it.
 *
 * MANUALLY RUN (needs a display + the built app):
 *
 *   pnpm -w run build
 *   node apps/desktop/e2e/automations-picker-smoke.mjs
 */
import {
  assertBuiltRendererLoaded,
  assertProfileIsolated,
  closeAppBounded,
  createRunner,
  launch,
  makeGitRepo,
  makeScratch,
  seedProjects,
  sleep,
  waitUntil,
} from "./lib/smoke-kit.mjs";

const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("volli-automations-picker-");
const { attempt, must, summarize } = createRunner();

console.log("scratch:", scratch, "\n");

const windowFor = (page, ticketId) => page.locator(`[data-armed-run-window="${ticketId}"]`);

/** The one board card whose mono display id is exactly `id` — board-smoke's own selector. */
function cardById(page, id) {
  return page
    .locator("article")
    .filter({ has: page.locator("span.font-mono", { hasText: new RegExp(`^${id}$`) }) });
}

/** A column's own root, hit-tested by the picker exactly as the pointer is. */
const columnFor = (page, status) => page.locator(`[data-board-column="${status}"]`);

/** One ticket's committed column, read from the database rather than the DOM. */
function statusOf(page, projectId, ticketId) {
  return page.evaluate(
    async ({ project, ticket }) => {
      const boot = await window.api.data.bootstrap();
      if (!boot.ok) return "unreadable";
      const tickets = boot.data.ticketsByProject[project] ?? [];
      return tickets.find((row) => row.id === ticket)?.status ?? "gone";
    },
    { project: projectId, ticket: ticketId },
  );
}

/**
 * A row's box once it has stopped growing.
 *
 * The panel's appearance transition (150ms of padding and gap) means the rows
 * are still moving in the frame after ⌥ goes down, and a box measured then is
 * a box for where the row WAS. Two identical measurements is the signal; there
 * is no sleep in it.
 */
async function stableBox(locator) {
  let last = null;
  await waitUntil(
    "the target row to stop moving",
    async () => {
      const box = await locator.boundingBox();
      if (box === null) return false;
      const settled =
        last !== null && Math.abs(box.y - last.y) < 0.5 && Math.abs(box.height - last.height) < 0.5;
      last = box;
      return settled;
    },
    { timeout: 5000, interval: 100 },
  );
  return last;
}

/** Everything the expanded panel says, row by row: the digit and the name it picks. */
function panelRows(page) {
  return page.locator("[data-offered-panel] [data-offered-row]").evaluateAll((rows) =>
    rows.map((row) => ({
      row: row.getAttribute("data-offered-row"),
      text: (row.textContent ?? "").trim(),
      chosen: row.getAttribute("aria-current") === "true",
    })),
  );
}

/**
 * Picks a card up and parks the pointer over `status`, WITHOUT releasing.
 * Returns the release helpers, so each check finishes the gesture its own way.
 *
 * `expectPanel` waits for the column's Offered list to appear before handing
 * the drag back, and every check that presses ⌥ needs it: the panel is on
 * screen only once the app has SEEN a pointer move over the column, and ⌥
 * pressed before that has no hovered column to open over (it would open on the
 * next move, and a check that presses and reads makes none).
 */
async function liftOver(page, displayId, status, { expectPanel = true } = {}) {
  // Both boxes measured only once they have stopped moving: a card that just
  // landed is still animating into its slot, and pressing down on where it WAS
  // starts no drag at all.
  const from = await stableBox(cardById(page, displayId).first());
  const column = await stableBox(columnFor(page, status));
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  // Two moves: the first passes dnd-kit's 4px activation constraint, the second
  // carries the pointer onto the target column.
  await page.mouse.move(from.x + from.width / 2 + 30, from.y + 40, { steps: 8 });
  await page.mouse.move(column.x + column.width / 2, column.y + 120, { steps: 20 });
  // dnd-kit has actually picked the card up. Asserted before anything is read,
  // because a drag that never activated and a panel that has not rendered yet
  // look identical from the outside.
  await page.locator("[data-board-drag]").waitFor({ timeout: 10_000 });
  if (expectPanel) {
    // Nudged on every poll rather than waited out: dnd-kit activates the drag
    // on the first 4px of travel and the board attaches its pointer listeners
    // on the commit AFTER that, so a burst of moves can all land before
    // anything is listening. Each poll is a real one-pixel move, and the
    // signal is the panel itself — never a sleep.
    let nudged = 0;
    await waitUntil(
      "the column's Offered list to appear under the pointer",
      async () => {
        nudged = nudged === 0 ? 3 : 0;
        await page.mouse.move(column.x + column.width / 2 + nudged, column.y + 120, { steps: 2 });
        return (await page.locator("[data-offered-panel]").count()) > 0;
      },
      { timeout: 10_000, interval: 150 },
    );
  }
  async function settle() {
    // The board says which card is in the air, so its absence is this gesture
    // being over — and waiting for it is what keeps the next drag from starting
    // into a board still tearing this one down.
    await waitUntil(
      "the drag to end",
      async () => (await page.locator("[data-board-drag]").count()) === 0,
      { timeout: 10_000, interval: 100 },
    );
    await sleep(200);
  }
  return {
    /** A pointer move that changes nothing but makes the app read ⌥ again. */
    async nudge(dx = 2, dy = 0) {
      await page.mouse.move(column.x + column.width / 2 + dx, column.y + 120 + dy, { steps: 2 });
    },
    async moveTo(x, y) {
      await page.mouse.move(x, y, { steps: 6 });
    },
    async release() {
      await page.mouse.up();
      await settle();
    },
    /**
     * Ends the drag WITHOUT a drop — dnd-kit's own pointer sensor makes Escape
     * mean cancel, which is what the picker inherits rather than redefining.
     * Every check that only needs to READ the panel ends this way, so it moves
     * no card and starts no Run.
     */
    async cancel() {
      await page.keyboard.press("Escape");
      // Park the pointer on the column's own padding before letting go: the
      // drag is already over, so the release is an ordinary CLICK — and a click
      // that lands on a card (selects it) or on the column's New button (opens
      // a composer that then eats the next keystrokes) is a surface change the
      // next check would inherit.
      await page.mouse.move(column.x + 4, column.y + 4, { steps: 2 });
      await page.mouse.up();
      await settle();
    },
  };
}

let app = null;
let exitCode = 1;
try {
  const repoDir = await makeGitRepo(scratch);
  app = await launch({ dbPath, userDataDir });
  const page = await app.firstWindow();
  page.on("pageerror", (error) => console.log("[pageerror]", String(error).slice(0, 400)));
  assertBuiltRendererLoaded(page);
  await assertProfileIsolated(app, userDataDir);
  await page.waitForSelector("[data-empty-projects-state]", { timeout: 30000 });
  await seedProjects(page, [{ id: "probe-project", name: "Probe", path: repoDir, prefix: "PRB" }]);

  const seeded = await page.evaluate(async () => {
    const boot = await window.api.data.bootstrap();
    if (!boot.ok) return { fail: `bootstrap: ${boot.error}` };
    const project = boot.data.projects[0];
    if (project === undefined) return { fail: "no project imported" };
    const mover = await window.api.tickets.create({
      projectId: project.id,
      title: "Drag me",
      status: "todo",
    });
    // A resident in each column this smoke drags between: an EMPTY column
    // collapses into the board's rail, and a collapsed pill is not a column
    // with an Offered list to grow.
    const todoSitter = await window.api.tickets.create({
      projectId: project.id,
      title: "Stays in Todo",
      status: "todo",
    });
    const doingSitter = await window.api.tickets.create({
      projectId: project.id,
      title: "Stays in Doing",
      status: "doing",
    });
    if (!mover.ok || !todoSitter.ok || !doingSitter.ok) return { fail: "ticket create failed" };
    // Two Automations offered in Doing, plus one Todo-only so a column with
    // nothing offered is on the board as well (Needs Review).
    const armed = await window.api.automations.create({
      commandId: crypto.randomUUID(),
      projectId: project.id,
      name: "Implement",
      instructions: "/implement",
      trigger: { kind: "columns", columns: ["doing"] },
      runtime: null,
    });
    const other = await window.api.automations.create({
      commandId: crypto.randomUUID(),
      projectId: project.id,
      name: "Two-opinion review",
      instructions: "/review",
      trigger: { kind: "columns", columns: ["doing"] },
      runtime: null,
    });
    if (!armed.ok || !other.ok) return { fail: armed.ok ? other.error : armed.error };
    // Both switched ON here: a machine fires nothing until someone does
    // (VC-112), and the pin follows the EFFECTIVE armed Automation.
    for (const id of [armed.automation.id, other.automation.id]) {
      const on = await window.api.automations.setEnabled({
        commandId: crypto.randomUUID(),
        automationId: id,
        enabled: true,
      });
      if (!on.ok) return { fail: on.error };
    }
    // Authored rank puts "Two-opinion review" first, and the arming pins
    // "Implement" to digit 1 — so the pin is visible rather than coincidental.
    const ordered = await window.api.automations.setColumnOrder({
      commandId: crypto.randomUUID(),
      projectId: project.id,
      status: "doing",
      rankedAutomationIds: [other.automation.id, armed.automation.id],
    });
    const armedOk = await window.api.automations.arm({
      commandId: crypto.randomUUID(),
      projectId: project.id,
      status: "doing",
      automationId: armed.automation.id,
    });
    if (!ordered.ok || !armedOk.ok) return { fail: ordered.ok ? armedOk.error : ordered.error };
    return {
      projectId: project.id,
      ticketId: mover.ticket.id,
      armedId: armed.automation.id,
      otherId: other.automation.id,
    };
  });
  await must(
    0,
    "a project, three tickets, and an armed column with two offered Automations",
    async () => ({
      ok: seeded.fail === undefined,
      detail: seeded.fail ?? `project=${seeded.projectId}`,
    }),
  );

  // The board must be looking at this project, with the caches read, before a
  // drag can consult them.
  await page.reload();
  await cardById(page, "PRB-1").first().waitFor({ timeout: 30000 });

  await must(1, "a drag over the column shows its Offered list and the ⌥ hint", async () => {
    const drag = await liftOver(page, "PRB-1", "doing");
    const collapsed = await page.locator("[data-offered-panel]").getAttribute("data-offered-panel");
    const hint = await page.locator("[data-choose-hint]").textContent();
    // Collapsed rows are not landing targets — that is the needle-in-a-haystack
    // size the design rejected — so nothing carries a row attribute yet.
    const targets = await page.locator("[data-offered-row]").count();
    await drag.cancel();
    return {
      ok: collapsed === "collapsed" && (hint ?? "").includes("to choose") && targets === 0,
      detail: `panel=${collapsed} hint=${JSON.stringify((hint ?? "").trim())} targets=${targets}`,
    };
  });

  await must(2, "holding ⌥ grows the column into named landing targets", async () => {
    const drag = await liftOver(page, "PRB-1", "doing");
    await page.keyboard.down("Alt");
    await page.locator('[data-offered-panel="expanded"]').waitFor({ timeout: 5000 });
    const rows = await panelRows(page);
    const hint = await page.locator("[data-choose-hint]").count();
    await page.keyboard.up("Alt");
    await drag.cancel();
    return {
      // Two Automations plus Move only, and every one of them is a target with
      // a digit printed on it: no ambiguous drop region is left inside.
      ok:
        rows.length === 3 &&
        rows[0].row === "0" &&
        rows[1].row === "1" &&
        rows[2].row === "move-only" &&
        rows[2].text.includes("Move only") &&
        // Advice to press the key you are holding is noise.
        hint === 0,
      detail: `${JSON.stringify(rows)} hints=${hint}`,
    };
  });

  await must(3, "the armed Automation is pinned to digit 1 and preselected", async () => {
    const drag = await liftOver(page, "PRB-1", "doing");
    await page.keyboard.down("Alt");
    await page.locator('[data-offered-panel="expanded"]').waitFor({ timeout: 5000 });
    const rows = await panelRows(page);
    await page.keyboard.up("Alt");
    await drag.cancel();
    const first = rows[0];
    return {
      // "Implement" is armed and ranked SECOND by the authored order, so a
      // first row reading "Implement" is the pin, not the rank.
      ok: first.text.includes("1") && first.text.includes("Implement") && first.chosen === true,
      detail: JSON.stringify(rows.map((row) => `${row.row}:${row.text}:${row.chosen}`)),
    };
  });

  await attempt(4, "no model override anywhere on the drag path", async () => {
    const drag = await liftOver(page, "PRB-1", "doing");
    await page.keyboard.down("Alt");
    await page.locator('[data-offered-panel="expanded"]').waitFor({ timeout: 5000 });
    const panel = page.locator("[data-offered-panel]");
    const text = (await panel.textContent()) ?? "";
    const controls = await panel.locator("button, select, [role='combobox']").count();
    await page.keyboard.up("Alt");
    await drag.cancel();
    return {
      // The panel names Automations and the move, and offers no control that
      // could re-decide a Runtime: a Run's model is the record's, resolved at
      // launch (VC-112).
      ok:
        controls === 0 &&
        !/model|reasoning|opus|sonnet|haiku/i.test(text) &&
        text.includes("Implement") &&
        text.includes("Move only"),
      detail: `controls=${controls} text=${JSON.stringify(text.replace(/\s+/g, " ").trim())}`,
    };
  });

  await must(
    5,
    "a release on a NAMED target opens the same window, naming what was aimed at",
    async () => {
      const drag = await liftOver(page, "PRB-1", "doing");
      await page.keyboard.down("Alt");
      await page.locator('[data-offered-panel="expanded"]').waitFor({ timeout: 5000 });
      // Aim at the row that is NOT the column's default, by pointing at it:
      // row `0` is digit 1, which the pin gave to the armed Automation, so the
      // aimed row is `1` — and a window naming it proves the pointer, not the
      // default, decided.
      const target = page.locator('[data-offered-row="1"]');
      const box = await stableBox(target);
      await drag.moveTo(box.x + box.width / 2, box.y + box.height / 2);
      await waitUntil(
        "the aimed row to light up",
        async () => (await target.getAttribute("aria-current")) === "true",
        { timeout: 3000 },
      );
      await drag.release();
      await page.keyboard.up("Alt");

      await windowFor(page, seeded.ticketId).waitFor({ timeout: 5000 });
      const card = windowFor(page, seeded.ticketId);
      const labels = await card
        .locator("button")
        .evaluateAll((all) => all.map((button) => (button.textContent ?? "").trim()));
      const said = (await card.textContent()) ?? "";
      // Cancelled rather than left to fire: this profile has no default model,
      // and the window OPENING under the picked name is the claim.
      await card.getByRole("button", { name: "Cancel" }).click();
      await card.waitFor({ state: "detached", timeout: 5000 });
      const status = await statusOf(page, seeded.projectId, seeded.ticketId);
      return {
        ok:
          labels.length === 1 &&
          labels[0] === "Cancel" &&
          said.includes("Two-opinion review") &&
          !said.includes("Implement") &&
          // The move stands whatever the Run did — Cancel is about the Run.
          status === "doing",
        detail: `controls=${JSON.stringify(labels)} said=${said.trim()} status=${status}`,
      };
    },
  );

  await must(6, "a release on Move only moves the card and starts nothing", async () => {
    // Out of the armed column first, so the release back in is an arrival.
    const out = await liftOver(page, "PRB-1", "todo", { expectPanel: false });
    await out.release();
    await waitUntil("PRB-1 to leave Doing", async () =>
      statusOf(page, seeded.projectId, seeded.ticketId).then((status) => status === "todo"),
    );

    const drag = await liftOver(page, "PRB-1", "doing");
    await page.keyboard.down("Alt");
    await page.locator('[data-offered-panel="expanded"]').waitFor({ timeout: 5000 });
    const moveOnly = page.locator('[data-offered-row="move-only"]');
    const box = await stableBox(moveOnly);
    await drag.moveTo(box.x + box.width / 2, box.y + box.height / 2);
    await waitUntil(
      "Move only to light up",
      async () => (await moveOnly.getAttribute("aria-current")) === "true",
      { timeout: 3000 },
    );
    await drag.release();
    await page.keyboard.up("Alt");

    await waitUntil("PRB-1 to land in Doing", async () =>
      statusOf(page, seeded.projectId, seeded.ticketId).then((status) => status === "doing"),
    );
    // A window would have opened within a frame of the move committing; the
    // wait above already outlasts that.
    const windows = await page.locator("[data-armed-run-window]").count();
    const runs = await page.evaluate(async (ticketId) => {
      const result = await window.api.automations.runsForTicket({ ticketId });
      return result.ok ? result.runs.length : -1;
    }, seeded.ticketId);
    return { ok: windows === 0 && runs === 0, detail: `windows=${windows} runs=${runs}` };
  });

  await attempt(
    7,
    "⌥-up collapses the picker without ending the drag; Escape ends the drag",
    async () => {
      const before = await statusOf(page, seeded.projectId, seeded.ticketId);
      const drag = await liftOver(page, "PRB-1", "doing");
      await page.keyboard.down("Alt");
      await page.locator('[data-offered-panel="expanded"]').waitFor({ timeout: 5000 });
      await page.keyboard.up("Alt");
      // ⌥ is read as STATE: the release is seen on the key event and re-read on
      // the next pointer move, so a nudge is enough either way.
      await drag.nudge();
      await page.locator('[data-offered-panel="collapsed"]').waitFor({ timeout: 5000 });
      const stillDragging = await page.locator("[data-board-drag]").count();
      await drag.cancel();
      const after = await statusOf(page, seeded.projectId, seeded.ticketId);
      const windows = await page.locator("[data-armed-run-window]").count();
      return {
        ok: stillDragging > 0 && after === before && windows === 0,
        detail: `dragging=${stillDragging} status ${before}→${after} windows=${windows}`,
      };
    },
  );

  exitCode = summarize();
} finally {
  if (app !== null) await closeAppBounded(app);
  await cleanup();
}
process.exit(exitCode);
