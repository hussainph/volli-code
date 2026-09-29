/**
 * The ticket rail's Automations block (VC-129), driven through the REAL packed
 * app and through the CONTROLS a person would use — never the IPC door under
 * them. The doors themselves are the tracer smoke's subject
 * (`automations-smoke.mjs`); whether the rail is wired to them is this one's.
 *
 * What it proves, in dependency order:
 *   1. With no Automations in the project at all, the rail still draws the
 *      block, says so in one line, and its header's door reaches the
 *      Automations page — the block is never hidden when empty, and the empty
 *      state itself carries no link (VC-257: the word "Automations" once sat
 *      two lines under the eyebrow AUTOMATIONS). There is no Run once
 *      control: VC-406 retired it from the rail (a one-off is `+ Chat` and
 *      typing), and this step guards that it does not quietly come back.
 *   2. With a column armed, the offer list MARKS that Automation Armed where
 *      it already sits, because the Ticket sits in that column. It is not
 *      floated to the top: the menu and the lane are one list read twice
 *      (VC-132), and only the lane's drag has digits to protect.
 *   3. The list draws every column's Offered work as its own row, the Ticket's
 *      current column first and each row naming the column that offers it — a
 *      switched-off Automation among them is offered rather than withheld
 *      (running by hand is universal, VC-112), wearing a slashed bolt
 *      (`data-triggers="off"`) with the words in its title.
 *   4. Pressing the Armed row opens its inspection, and the Run inside that
 *      record — its own labelled act (VC-406) — reaches the Run door.
 *   5. There is no authoring form anywhere in the rail: no Name, no Trigger,
 *      no save, no delete.
 *   6. This Ticket's Runs are drawn from this Ticket's own read: with nothing
 *      run yet the rail draws no list, and the door it reads agrees.
 *   7. Right-clicking a ROW opens that row's own inspection — the other
 *      deliberate surface VC-112 names for the per-invocation override, now
 *      per Automation rather than only for the column's default (VC-406). It
 *      is the SAME record a press opens, never a second menu.
 *   8. The board card's own `Automations ▸` submenu offers every column's
 *      grouped list without opening the Ticket, and holds the same nested
 *      override.
 *
 * TWO LIMITS, both stated rather than papered over:
 *
 *  - **A Run needs a live model.** This profile has no default model, so check
 *    4 lands on the Session start's own `MODEL_REQUIRED` refusal, whose
 *    recovery is Model Access — Settings opening on it IS the evidence the
 *    click reached the door. `run.test.ts` owns the happy path.
 *  - **The nested model override depends on the catalog.** Its submenu lists
 *    the models a picker may offer, so on a profile with nothing available it
 *    is correctly absent — which makes it a bad thing to require. Checks 4, 7
 *    and 8 PRINT the menu they found (the override row shows up as "Run on
 *    model" when there is a catalog) and require only what must always be
 *    there. What the override menu may name — never a model without a
 *    reasoning level it can run — is pinned in
 *    `ticket-rail-automations-model.test.ts`; that the pick SURVIVES into the
 *    Run is pinned in `ticket-rail-automations.test.tsx` and
 *    `automation-run-menu.test.tsx`.
 *
 * No fixed sleeps: every wait is on a real signal.
 *
 * MANUALLY RUN (needs a display + the built app):
 *
 *   pnpm -w run build
 *   node apps/desktop/e2e/automations-rail-smoke.mjs
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
} from "./lib/smoke-kit.mjs";

const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("volli-automations-rail-");
const { attempt, must, summarize } = createRunner();

console.log("scratch:", scratch, "\n");

/** The one board card whose mono display id is exactly `id` — board-smoke's selector. */
function cardById(page, id) {
  return page
    .locator("article")
    .filter({ has: page.locator("span.font-mono", { hasText: new RegExp(`^${id}$`) }) });
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
    // The Ticket sits in Doing, which is the column the rail's default press
    // follows — the same column an armed board move would fire on.
    const ticket = await window.api.tickets.create({
      projectId: project.id,
      title: "Rail probe",
      status: "doing",
    });
    if (!ticket.ok) return { fail: ticket.error };
    return { projectId: project.id, ticketId: ticket.ticket.id };
  });
  await must(0, "a project and a Ticket in Doing exist", async () => ({
    ok: seeded.fail === undefined,
    detail: seeded.fail ?? `project=${seeded.projectId} ticket=${seeded.ticketId}`,
  }));

  // Tickets seeded straight into SQLite are not a board broadcast, so the
  // renderer meets them on its next read — the same reload the arming smoke
  // uses for the same reason.
  await page.reload();
  await cardById(page, "PRB-1").first().waitFor({ timeout: 30000 });

  /** Open the ticket workspace the way a person does: double-click its card. */
  async function openTicket() {
    await cardById(page, "PRB-1").first().dblclick();
    await page.locator('[data-testid="ticket-rail-automations"]').waitFor({ timeout: 20000 });
  }

  /** Back to the board from wherever we are — Settings is a surface, not an overlay. */
  async function backToBoard() {
    await page.getByRole("button", { name: "Home", exact: true }).first().click();
    await cardById(page, "PRB-1").first().waitFor({ timeout: 15000 });
  }

  const rail = () => page.locator('[data-testid="ticket-rail-automations"]');

  /** The rail's page door, in its header row at every state (VC-257/VC-406). */
  const pageDoor = () => rail().getByRole("button", { name: "Open Automations", exact: true });

  /** The offer list's rows — one per Automation this Ticket may be made to run. */
  const offerRows = () => rail().locator('[data-testid="ticket-rail-automation-row"]');

  /**
   * The one row wearing this column's Armed mark, wherever the lane's rank put
   * it (VC-132) — the list is not reordered to bring it to the front.
   */
  const armedOfferRow = () =>
    rail().locator('[data-testid="ticket-rail-automation-row"][data-armed="true"]');

  /**
   * Rows whose Automation has every Trigger switched off. The mark rides on
   * the ROW itself (VC-406), not on anything inside it.
   */
  const switchedOffRows = () =>
    rail().locator('[data-testid="ticket-rail-automation-row"][data-triggers="off"]');

  /** A row's inspection — the popover both a press and a right-click open. */
  const inspection = () => page.locator('[data-testid="ticket-rail-automation-inspect"]');

  await must(
    1,
    "with nothing to run, the block is still there and the header's door reaches the page",
    async () => {
      await openTicket();
      const heading = rail().getByRole("heading", { name: "Automations", exact: true });
      await heading.waitFor({ timeout: 15000 });
      const said = await rail().innerText();
      // VC-406 retired the rail's Run once; the block ends at its rows.
      const runOnce = await rail().locator('[data-testid="ticket-rail-run-once"]').count();
      const emptyReport = rail().getByText("No automations in this project yet.", { exact: true });
      const door = pageDoor();
      const [headingBox, doorBox] = await Promise.all([heading.boundingBox(), door.boundingBox()]);
      const reportMetrics = await emptyReport.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return {
          height: box.height,
          lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
        };
      });
      const doorSharesHeadingRow =
        headingBox !== null &&
        doorBox !== null &&
        Math.abs(headingBox.y + headingBox.height / 2 - (doorBox.y + doorBox.height / 2)) <= 1;
      const reportIsOneLine = reportMetrics.height <= reportMetrics.lineHeight + 1;
      // The report is never a second door under the heading (VC-257).
      const strayLinks = await rail()
        .getByRole("button", { name: "Automations", exact: true })
        .count();
      // The moved door still reaches the page the rail does not author (VC-112).
      await door.click();
      await page
        .getByRole("heading", { name: "Automations", exact: true })
        .waitFor({ timeout: 15000 });
      await backToBoard();
      return {
        ok:
          said.includes("No automations in this project yet.") &&
          runOnce === 0 &&
          strayLinks === 0 &&
          doorSharesHeadingRow &&
          reportIsOneLine,
        detail: `${said.replaceAll("\n", " ").slice(0, 160)} · heading row: ${doorSharesHeadingRow} · one-line report: ${reportIsOneLine} · stray "Automations" links: ${strayLinks} · run once controls: ${runOnce}`,
      };
    },
  );

  // Setup, not the act under test: the record's own CRUD and arming are the
  // page's and the board bolt's smokes. What follows drives the RAIL.
  const created = await page.evaluate(async (projectId) => {
    const armed = await window.api.automations.create({
      commandId: crypto.randomUUID(),
      projectId,
      name: "Review sweep",
      instructions: "/review the change set",
      trigger: { kind: "columns", columns: ["doing"] },
      runtime: null,
    });
    const offered = await window.api.automations.create({
      commandId: crypto.randomUUID(),
      projectId,
      name: "Nightly sweep",
      instructions: "/tdd",
      trigger: { kind: "columns", columns: ["doing"] },
      runtime: null,
    });
    const elsewhere = await window.api.automations.create({
      commandId: crypto.randomUUID(),
      projectId,
      name: "Done sweep",
      instructions: "/ship",
      trigger: { kind: "columns", columns: ["done"] },
      runtime: null,
    });
    if (!armed.ok || !offered.ok || !elsewhere.ok) {
      return { fail: armed.ok ? (offered.ok ? elsewhere.error : offered.error) : armed.error };
    }
    const arm = await window.api.automations.arm({
      commandId: crypto.randomUUID(),
      projectId,
      status: "doing",
      automationId: armed.automation.id,
    });
    return arm.ok ? { armedId: armed.automation.id } : { fail: arm.error };
  }, seeded.projectId);
  await must(2, "Doing is armed with one of the three Automations", async () => ({
    ok: created.fail === undefined,
    detail: created.fail ?? `armed=${created.armedId}`,
  }));

  await must(3, "the offer list marks this column's Armed automation in place", async () => {
    await openTicket();
    await offerRows().first().waitFor({ timeout: 15000 });
    // Marked WHERE IT SITS, not floated: the list keeps the lane's rank
    // (VC-132, pinned in `ticket-rail-automations-model.test.ts`), so this
    // asks which row wears the mark rather than what the first row is. The
    // row is the Inspect affordance now (VC-406) — the press that RUNS is its
    // own control inside the row, which check 4 takes.
    const markedRows = armedOfferRow();
    const markedCount = await markedRows.count();
    const label = markedCount > 0 ? await markedRows.first().getAttribute("aria-label") : null;
    // The door is in the header at EVERY state now (VC-406) — it used to be
    // the empty state's consolation prize, which left the one reader who could
    // not reach the page from here as the one with lanes to arrange.
    const pageDoors = await pageDoor().count();
    return {
      ok: label === "Inspect Review sweep" && markedCount === 1 && pageDoors === 1,
      detail: `marked=${label} markedCount=${markedCount} pageDoors=${pageDoors}`,
    };
  });

  await attempt(4, "the list draws every column's Offered work as a row", async () => {
    const items = await rail().locator('[data-testid="ticket-rail-automation-list"]').innerText();
    const offRows = await switchedOffRows().count();
    const offTitle =
      offRows === 0 ? "" : ((await switchedOffRows().first().getAttribute("title")) ?? "");
    return {
      ok:
        items.includes("Review sweep") &&
        items.includes("Nightly sweep") &&
        // Cross-column hand-runs remain available without moving this Ticket;
        // each row names the column where it is normally offered.
        items.includes("Done sweep") &&
        items.includes("Armed") &&
        items.indexOf("Armed") < items.indexOf("Done") &&
        // Nobody switched anything on here, and a switched-off Automation is
        // still offered — the note left the face for the bolt and the title
        // (VC-406), so the words are NOT in the list's text any more.
        !items.includes("Manual only") &&
        offRows > 0 &&
        offTitle.includes("Manual only"),
      detail: `${items.replaceAll("\n", " | ").slice(0, 200)} · off rows: ${offRows} · title: ${offTitle}`,
    };
  });

  await attempt(5, "the Armed row's inspection reaches the Run door", async () => {
    // Two acts now, not one (VC-406): the ROW opens the record, and the Run
    // inside it is its own labelled press. No default model on this profile,
    // so the Run's own refusal opens Model Access — which is the evidence the
    // press reached the door.
    await armedOfferRow().first().click();
    await inspection().waitFor({ timeout: 15000 });
    await page.getByTestId("ticket-rail-automation-run").click();
    await page.getByRole("navigation", { name: "Settings categories" }).waitFor({ timeout: 20000 });
    await backToBoard();
    return { ok: true, detail: "ran the armed Automation, refused for the missing model" };
  });

  await attempt(
    6,
    "the rail draws no Runs list of its own; the Ticket's door still answers",
    async () => {
      // Runs are Sessions, and since VC-406 the rail lists them once — in the
      // Sessions roster, wearing the bolt — never under the Automations block.
      // So the block draws no run list in ANY state, and this guards that the
      // list does not quietly come back. The `runsForTicket` door itself is
      // still read here: a Run needs a live model and spends tokens, so nothing
      // has run on this Ticket and the door has to say so.
      await openTicket();
      const drawn = await rail().locator('[data-testid="ticket-rail-runs"]').count();
      const outcome = await page.evaluate(async (ticketId) => {
        const mine = await window.api.automations.runsForTicket({ ticketId });
        return mine.ok ? { runs: mine.runs.length } : { refused: mine.error };
      }, seeded.ticketId);
      return {
        ok: drawn === 0 && outcome.runs === 0,
        detail: `lists=${drawn} ${JSON.stringify(outcome)}`,
      };
    },
  );

  await attempt(7, "right-clicking a row opens that row's own inspection", async () => {
    // The second deliberate surface VC-112 names beside the rail itself, and
    // since VC-406 it is PER ROW. It is deliberately NOT a second menu: the
    // right-click opens the SAME inspection the press does, because a
    // right-click that offered different controls would be a second answer to
    // what this row can be made to do. Check 6 left the Ticket open.
    await armedOfferRow().first().click({ button: "right" });
    await inspection().waitFor({ timeout: 10000 });
    const items = await inspection().innerText();
    await page.keyboard.press("Escape");
    await backToBoard();
    return {
      // The inspection is about THAT row: it runs the Automation it was opened
      // on, and offers no sibling's name to run by mistake.
      ok: items.includes("Review sweep") && !items.includes("Done sweep"),
      detail: items.replaceAll("\n", " | ").slice(0, 240),
    };
  });

  await attempt(8, "the board card runs one without opening the Ticket", async () => {
    await cardById(page, "PRB-1").first().click({ button: "right" });
    const menu = page.getByRole("menu").first();
    await menu.waitFor({ timeout: 10000 });
    await menu.getByRole("menuitem", { name: "Automations" }).hover();
    const submenu = page.getByRole("menu").nth(1);
    await submenu.waitFor({ timeout: 10000 });
    const items = await submenu.innerText();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    return {
      ok:
        items.includes("Review sweep") &&
        items.includes("Nightly sweep") &&
        items.includes("Done sweep") &&
        items.indexOf("DOING · THIS TICKET") < items.indexOf("DONE") &&
        // A card has nowhere to type an Unbound Run, so it offers none.
        !items.includes("Run once"),
      detail: items.replaceAll("\n", " | ").slice(0, 240),
    };
  });

  exitCode = summarize();
} finally {
  if (app !== null) await closeAppBounded(app);
  await cleanup();
}
process.exit(exitCode);
