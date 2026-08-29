/**
 * Column Trigger and arming (VC-128), driven through the REAL packed app.
 *
 * What it proves, in dependency order:
 *   1. An Automation's Trigger names one or more columns, stored in board
 *      order and readable back as vocabulary.
 *   2. A column arms at most one Automation, or none — enforced by the record's
 *      own key, so a second arm REPLACES rather than adds.
 *   3. Arming is a property of the column: the same Automation is armed in one
 *      column and merely offered in another.
 *   4. A column may only arm what it offers, and a deleted Automation takes its
 *      arming with it.
 *   5. Arming is not retroactive — a ticket already sitting in the column when
 *      it was armed starts nothing.
 *   6. A Deliberate move into an armed column opens ONE window with exactly ONE
 *      control (Cancel) and a progress bar that visibly advances.
 *   7. Cancel keeps the move and starts nothing.
 *   8. A move into an unarmed column opens no window at all.
 *   9. Left alone, the window starts the Run — and not before 3500 ms have
 *      passed, measured rather than assumed.
 *
 * The live half of a Run needs provider credentials and spends tokens, so — as
 * in `automations-smoke.mjs` — this profile has no default model and check 9
 * lands on the Session start's own `MODEL_REQUIRED` refusal. That refusal is
 * still proof the window FIRED, which is the claim under test; `run.test.ts`
 * owns the happy path.
 *
 * No fixed sleeps anywhere: every wait is `waitUntil` on a real signal (an
 * element appearing, a width growing, a toast arriving). The one number this
 * probe reads off the clock is the elapsed time between the window opening and
 * the Run being attempted, which is the acceptance criterion itself.
 *
 * MANUALLY RUN (needs a display + the built app):
 *
 *   pnpm -w run build
 *   node apps/desktop/e2e/automations-arming-smoke.mjs
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
  waitUntil,
} from "./lib/smoke-kit.mjs";

const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("volli-arming-");
const { attempt, must, summarize } = createRunner();

/** The delay under test. Stated once here, exactly as `@volli/shared` states it. */
const ARMED_RUN_DELAY_MS = 3500;

console.log("scratch:", scratch, "\n");

const windowFor = (page, ticketId) => page.locator(`[data-armed-run-window="${ticketId}"]`);

/** The one board card whose mono display id is exactly `id` — board-smoke's own selector. */
function cardById(page, id) {
  return page
    .locator("article")
    .filter({ has: page.locator("span.font-mono", { hasText: new RegExp(`^${id}$`) }) });
}

/** One ticket's committed column, read from the database rather than the DOM. */
function statusOf(page, seeded) {
  return page.evaluate(
    async ({ projectId, ticketId }) => {
      const boot = await window.api.data.bootstrap();
      if (!boot.ok) return "unreadable";
      const tickets = boot.data.ticketsByProject[projectId] ?? [];
      return tickets.find((ticket) => ticket.id === ticketId)?.status ?? "gone";
    },
    { projectId: seeded.projectId, ticketId: seeded.moverId },
  );
}

/** Move a card through the board's own context menu — a Deliberate move a person can make. */
async function moveViaContextMenu(page, displayId, columnLabel) {
  const card = cardById(page, displayId).first();
  await card.click({ button: "right" });
  const moveTo = page.getByRole("menuitem", { name: "Move to", exact: true });
  await moveTo.waitFor();
  await moveTo.hover();
  const target = page.getByRole("menuitem", { name: columnLabel, exact: true });
  await target.waitFor();
  await target.click();
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
      title: "Moves into Doing",
      status: "todo",
    });
    const sitter = await window.api.tickets.create({
      projectId: project.id,
      title: "Already in Doing",
      status: "doing",
    });
    if (!mover.ok || !sitter.ok) return { fail: "ticket create failed" };
    return {
      projectId: project.id,
      moverId: mover.ticket.id,
      sitterId: sitter.ticket.id,
    };
  });
  await must(0, "a project and two tickets exist to move", async () => ({
    ok: seeded.fail === undefined,
    detail: seeded.fail ?? `project=${seeded.projectId}`,
  }));

  const created = await page.evaluate(async (projectId) => {
    const sweep = await window.api.automations.create({
      commandId: crypto.randomUUID(),
      projectId,
      name: "Review sweep",
      instructions: "/review the change set",
      // Deliberately out of board order — the record stores board order.
      trigger: { kind: "columns", columns: ["done", "doing"] },
      runtime: null,
    });
    const elsewhere = await window.api.automations.create({
      commandId: crypto.randomUUID(),
      projectId,
      name: "Done sweep",
      instructions: "/tdd",
      trigger: { kind: "columns", columns: ["done"] },
      runtime: null,
    });
    return sweep.ok && elsewhere.ok
      ? { sweep: sweep.automation, elsewhere: elsewhere.automation }
      : { fail: sweep.ok ? elsewhere.error : sweep.error };
  }, seeded.projectId);
  await must(1, "a Trigger names one or more columns, stored in board order", async () => ({
    ok:
      created.fail === undefined &&
      JSON.stringify(created.sweep.trigger) ===
        JSON.stringify({ kind: "columns", columns: ["doing", "done"] }),
    detail: created.fail ?? JSON.stringify(created.sweep.trigger),
  }));

  await must(2, "a column arms at most one Automation — a second arm replaces", async () => {
    const outcome = await page.evaluate(
      async ({ projectId, doneSweep, reviewSweep }) => {
        const first = await window.api.automations.arm({
          projectId,
          status: "done",
          automationId: doneSweep,
        });
        const second = await window.api.automations.arm({
          projectId,
          status: "done",
          automationId: reviewSweep,
        });
        return {
          firstCount: first.ok ? first.armings.length : -1,
          secondCount: second.ok ? second.armings.length : -1,
          secondNames: second.ok ? second.armings.map((a) => `${a.status}:${a.automationId}`) : [],
        };
      },
      {
        projectId: seeded.projectId,
        doneSweep: created.elsewhere.id,
        reviewSweep: created.sweep.id,
      },
    );
    return {
      ok:
        outcome.firstCount === 1 &&
        outcome.secondCount === 1 &&
        outcome.secondNames[0] === `done:${created.sweep.id}`,
      detail: JSON.stringify(outcome),
    };
  });

  await attempt(
    3,
    "arming is the column's property: one Automation armed here, merely offered there",
    async () => {
      const armings = await page.evaluate(
        async ({ projectId, reviewSweep }) => {
          const armed = await window.api.automations.arm({
            projectId,
            status: "doing",
            automationId: reviewSweep,
          });
          return armed.ok
            ? armed.armings.map((a) => `${a.status}:${a.automationId}`).toSorted()
            : [armed.error];
        },
        { projectId: seeded.projectId, reviewSweep: created.sweep.id },
      );
      // The same Automation is now armed in BOTH columns it offers — two
      // separate column choices, one record, and neither visible in the other.
      return {
        ok:
          armings.length === 2 &&
          armings.includes(`doing:${created.sweep.id}`) &&
          armings.includes(`done:${created.sweep.id}`),
        detail: JSON.stringify(armings),
      };
    },
  );

  await attempt(4, "a column may only arm what it offers, and a delete disarms", async () => {
    const outcome = await page.evaluate(
      async ({ projectId, doneSweep }) => {
        // "Done sweep" names only Done, so Todo may not arm it.
        const refused = await window.api.automations.arm({
          projectId,
          status: "todo",
          automationId: doneSweep,
        });
        const armings = await window.api.automations.armings({ projectId });
        return {
          refusal: refused.ok ? "ACCEPTED" : refused.error,
          // The refused arm wrote nothing: Todo is still unarmed.
          todoArmed: armings.ok ? armings.armings.some((a) => a.status === "todo") : true,
        };
      },
      { projectId: seeded.projectId, doneSweep: created.elsewhere.id },
    );
    const afterDelete = await page.evaluate(
      async ({ projectId, doneSweep }) => {
        await window.api.automations.arm({
          projectId,
          status: "done",
          automationId: doneSweep,
        });
        await window.api.automations.delete({
          commandId: crypto.randomUUID(),
          automationId: doneSweep,
        });
        const armings = await window.api.automations.armings({ projectId });
        return armings.ok ? armings.armings.map((a) => a.status).toSorted() : [armings.error];
      },
      { projectId: seeded.projectId, doneSweep: created.elsewhere.id },
    );
    return {
      ok:
        /not offered in this column/.test(outcome.refusal) &&
        outcome.todoArmed === false &&
        // Done's arming went with the deleted Automation; Doing's is untouched.
        afterDelete.length === 1 &&
        afterDelete[0] === "doing",
      detail: `${JSON.stringify(outcome)} after=${JSON.stringify(afterDelete)}`,
    };
  });

  // The board must be looking at this project before a move can be made in it.
  await page.reload();
  await cardById(page, "PRB-1").first().waitFor({ timeout: 30000 });

  await attempt(
    5,
    "arming is not retroactive — the ticket already there starts nothing",
    async () => {
      // Doing was armed above while PRB-2 was already sitting in it. Nothing
      // opened then, and nothing is open now.
      const open = await windowFor(page, seeded.sitterId).count();
      return { ok: open === 0, detail: `open windows for the sitting ticket: ${open}` };
    },
  );

  await attempt(6, "a move into an UNARMED column opens no window", async () => {
    await moveViaContextMenu(page, "PRB-1", "Needs Review");
    await waitUntil("PRB-1 to land in Needs Review", async () =>
      statusOf(page, seeded).then((status) => status === "needs_review"),
    );
    const open = await page.locator("[data-armed-run-window]").count();
    return { ok: open === 0, detail: `open windows: ${open}` };
  });

  await must(
    7,
    "a move into the ARMED column opens one window with exactly one control",
    async () => {
      await moveViaContextMenu(page, "PRB-1", "Doing");
      await windowFor(page, seeded.moverId).waitFor({ timeout: 5000 });
      const card = windowFor(page, seeded.moverId);
      const buttons = card.locator("button");
      const labels = await buttons.evaluateAll((all) =>
        all.map((b) => (b.textContent ?? "").trim()),
      );
      const names = await card.textContent();
      return {
        ok:
          labels.length === 1 &&
          labels[0] === "Cancel" &&
          (names ?? "").includes("Review sweep") &&
          (names ?? "").includes("PRB-1"),
        detail: `controls=${JSON.stringify(labels)} text=${(names ?? "").trim()}`,
      };
    },
  );

  await attempt(8, "the window shows visible progress toward the moment", async () => {
    const bar = windowFor(page, seeded.moverId).locator("[data-armed-run-progress]");
    const width = async () => bar.evaluate((element) => element.getBoundingClientRect().width);
    const first = await width();
    // A real signal, not a sleep: wait for the bar to actually grow.
    const grew = await waitUntil(
      "the progress bar to advance",
      async () => (await width()) > first,
      { timeout: ARMED_RUN_DELAY_MS, interval: 100 },
    );
    return { ok: grew === true, detail: `from ${first}px` };
  });

  await attempt(9, "Cancel keeps the move and starts nothing", async () => {
    await windowFor(page, seeded.moverId).getByRole("button", { name: "Cancel" }).click();
    await windowFor(page, seeded.moverId).waitFor({ state: "detached", timeout: 5000 });
    const status = await statusOf(page, seeded);
    const runs = await page.evaluate(async (ticketId) => {
      const result = await window.api.automations.runsForTicket({ ticketId });
      return result.ok ? result.runs.length : -1;
    }, seeded.moverId);
    // The move stands — reverting it is the board's own undo, not this control.
    return { ok: status === "doing" && runs === 0, detail: `status=${status} runs=${runs}` };
  });

  await attempt(
    10,
    "left alone, the window starts the Run — and never before 3500 ms",
    async () => {
      // Out and back in: a fresh arrival, and therefore a fresh window.
      await moveViaContextMenu(page, "PRB-1", "Todo");
      await waitUntil("PRB-1 to leave Doing", async () =>
        statusOf(page, seeded).then((status) => status === "todo"),
      );
      await moveViaContextMenu(page, "PRB-1", "Doing");
      await windowFor(page, seeded.moverId).waitFor({ timeout: 5000 });
      const openedAt = Date.now();

      // This profile has no default model, so the Run lands on the Session
      // start's own refusal — OFFERED as a toast rather than performed by
      // taking the window over with Settings (VC-13 decision 2: nobody asked
      // for a surface change, they moved a card). That the refusal ARRIVED is
      // the proof the window fired; when it arrived is the proof it did not
      // fire early.
      const refusals = page.locator("[data-sonner-toast]", { hasText: "start on PRB-1" });
      await waitUntil("the Run to be attempted", async () => (await refusals.count()) > 0, {
        timeout: ARMED_RUN_DELAY_MS + 15_000,
        interval: 100,
      });
      const elapsed = Date.now() - openedAt;
      const attempts = await refusals.count();
      return {
        // One attempt, not two: the window cancelled in check 9 fired nothing,
        // and this one fired once.
        // The floor allows for the poll lag between the window opening and
        // this probe seeing it; it is still far below anything an early fire
        // could produce.
        ok: elapsed >= ARMED_RUN_DELAY_MS - 250 && attempts === 1,
        detail: `elapsed=${elapsed}ms attempts=${attempts}`,
      };
    },
  );

  exitCode = summarize();
} finally {
  if (app !== null) await closeAppBounded(app);
  await cleanup();
}
process.exit(exitCode);
