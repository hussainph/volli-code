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
 *      passed, measured between two facts the app produced rather than assumed.
 *  10. An explicit `volli ticket move` is a Deliberate move too: it opens the
 *      same window, with the same one control, for a caller that is not this
 *      renderer.
 *  11. An Automation switched off on this machine fires nothing on its
 *      Trigger, and the column it armed stays armed.
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
  grantUnauthenticatedWrites,
  makeShortScratch,
  runVolliShim,
  shimPathFor,
  socketPathFor,
} from "./lib/agent-kit.mjs";
import {
  assertBuiltRendererLoaded,
  assertProfileIsolated,
  closeAppBounded,
  createRunner,
  launch,
  makeGitRepo,
  pathExists,
  seedProjects,
  waitUntil,
} from "./lib/smoke-kit.mjs";

// A SHORT scratch root, because check 11 drives the real `volli` CLI: the
// app's Unix socket lives under the profile dir and a long path would exceed
// the platform's sun_path limit before the socket could ever bind.
const { scratch, userDataDir, dbPath, cleanup } = await makeShortScratch("arm");
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

const shimPath = shimPathFor(userDataDir);
const socketPath = socketPathFor(userDataDir);

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
    if (!sweep.ok || !elsewhere.ok) return { fail: sweep.ok ? elsewhere.error : sweep.error };
    // A record is OFF until someone switches it on HERE (VC-112/VC-127): a
    // machine fires nothing until someone turns something on there. Everything
    // below that expects a Trigger to fire needs both switches — the column's
    // arming AND this one — so the probe throws this one explicitly rather
    // than inheriting a default that does not exist.
    const on = await window.api.automations.setEnabled({
      commandId: crypto.randomUUID(),
      automationId: sweep.automation.id,
      enabled: true,
    });
    return on.ok
      ? {
          sweep: sweep.automation,
          elsewhere: elsewhere.automation,
          enabled: on.enabledAutomationIds,
        }
      : { fail: on.error };
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
          commandId: crypto.randomUUID(),
          projectId,
          status: "done",
          automationId: doneSweep,
        });
        const second = await window.api.automations.arm({
          commandId: crypto.randomUUID(),
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
            commandId: crypto.randomUUID(),
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
          commandId: crypto.randomUUID(),
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
          commandId: crypto.randomUUID(),
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
      // The floor is measured between two facts the APP produced, not between
      // two things this probe noticed:
      //
      //  - the ARRIVAL is `enteredAt` from main's own status-entry read — the
      //    instant the move committed, written by the process that committed
      //    it. Anchoring on the window's DOM instead would start the clock
      //    after the arrival and quietly shorten the interval under test.
      //  - the ATTEMPT is stamped in the page by a MutationObserver watching
      //    for the Run door's answer, so it is the moment the refusal landed
      //    rather than the moment a poll got around to looking.
      //
      // What is left is an over-read of a few milliseconds (one IPC round trip
      // between the Run being asked for and its refusal reaching the DOM), so
      // the assertion is the criterion itself with no slack subtracted: an
      // attempt earlier than 3500 ms after the arrival fails this check.
      await page.evaluate(() => {
        const target = "start on PRB-1";
        window.volliArmedRunAttemptAt = null;
        const stamp = () => {
          if (window.volliArmedRunAttemptAt !== null) return;
          const toasts = [...document.querySelectorAll("[data-sonner-toast]")];
          if (toasts.some((toast) => (toast.textContent ?? "").includes(target))) {
            window.volliArmedRunAttemptAt = Date.now();
          }
        };
        new MutationObserver(stamp).observe(document.body, { childList: true, subtree: true });
        stamp();
      });

      // Out and back in: a fresh arrival, and therefore a fresh window.
      await moveViaContextMenu(page, "PRB-1", "Todo");
      await waitUntil("PRB-1 to leave Doing", async () =>
        statusOf(page, seeded).then((status) => status === "todo"),
      );
      await moveViaContextMenu(page, "PRB-1", "Doing");
      await windowFor(page, seeded.moverId).waitFor({ timeout: 5000 });

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

      const measured = await page.evaluate(
        async ({ projectId, ticketId }) => {
          const entries = await window.api.tickets.statusEntries({ projectId });
          const entry = entries.ok
            ? entries.entries.find((candidate) => candidate.ticketId === ticketId)
            : undefined;
          return {
            arrivedAt: entry?.enteredAt ?? null,
            status: entry?.status ?? null,
            attemptedAt: window.volliArmedRunAttemptAt,
          };
        },
        { projectId: seeded.projectId, ticketId: seeded.moverId },
      );
      const attempts = await refusals.count();
      const elapsed =
        measured.arrivedAt === null || measured.attemptedAt === null
          ? null
          : measured.attemptedAt - measured.arrivedAt;
      return {
        // One attempt, not two: the window cancelled in check 9 fired nothing,
        // and this one fired once.
        ok:
          measured.status === "doing" &&
          elapsed !== null &&
          elapsed >= ARMED_RUN_DELAY_MS &&
          attempts === 1,
        detail: `elapsed=${elapsed}ms (arrival→attempt) attempts=${attempts}`,
      };
    },
  );

  await attempt(
    11,
    "an explicit `volli ticket move` opens the same window — a Deliberate move either way",
    async () => {
      // CONTEXT.md defines a Deliberate move as a human drag OR an explicit
      // `volli` move, with the same semantics. Unattended moves are what this
      // feature is FOR, so the CLI path is exercised through the real socket
      // and the real shim rather than simulated through the bridge.
      await grantUnauthenticatedWrites(page, seeded.projectId, ["ticket.move"]);
      await waitUntil(
        "shim + socket to exist",
        async () => (await pathExists(shimPath)) && (await pathExists(socketPath)),
      );

      // Out of the armed column first, over the same door. A move into an
      // UNARMED column is a pure status change from the CLI as well.
      const out = await runVolliShim(shimPath, ["ticket", "move", "PRB-1", "--to", "todo"]);
      if (out.code !== 0) {
        return { ok: false, detail: `CLI move out failed: ${out.stderr.trim()}` };
      }
      await waitUntil("PRB-1 to leave Doing", async () =>
        statusOf(page, seeded).then((status) => status === "todo"),
      );
      const openedOnUnarmed = await page.locator("[data-armed-run-window]").count();

      const back = await runVolliShim(shimPath, ["ticket", "move", "PRB-1", "--to", "doing"]);
      if (back.code !== 0) {
        return { ok: false, detail: `CLI move in failed: ${back.stderr.trim()}` };
      }
      await windowFor(page, seeded.moverId).waitFor({ timeout: 10_000 });
      const labels = await windowFor(page, seeded.moverId)
        .locator("button")
        .evaluateAll((all) => all.map((button) => (button.textContent ?? "").trim()));

      // Cancelled rather than left to fire: this check is about the window
      // opening for a CLI move, and check 10 already owns what firing does.
      await windowFor(page, seeded.moverId).getByRole("button", { name: "Cancel" }).click();
      await windowFor(page, seeded.moverId).waitFor({ state: "detached", timeout: 5000 });
      const status = await statusOf(page, seeded);
      return {
        ok:
          openedOnUnarmed === 0 &&
          labels.length === 1 &&
          labels[0] === "Cancel" &&
          // Cancel keeps the move whoever made it.
          status === "doing",
        detail: `unarmedWindows=${openedOnUnarmed} controls=${JSON.stringify(labels)} status=${status}`,
      };
    },
  );

  await attempt(
    12,
    "a switched-off Automation fires nothing on its Trigger, though the column stays armed",
    async () => {
      // The other switch (VC-127). Arming says WHICH Automation a column
      // fires; enablement says whether this machine fires that Automation at
      // all — and by-hand Runs are deliberately unaffected by it (VC-112).
      const off = await page.evaluate(
        (automationId) =>
          window.api.automations.setEnabled({
            commandId: crypto.randomUUID(),
            automationId,
            enabled: false,
          }),
        created.sweep.id,
      );
      if (!off.ok) return { ok: false, detail: `could not switch it off: ${off.error}` };
      // Reloaded so the board reads the switch back from main rather than from
      // what this renderer believed before the probe flipped it behind its back.
      await page.reload();
      await cardById(page, "PRB-1").first().waitFor({ timeout: 30000 });

      const runsBefore = await page.evaluate(async (ticketId) => {
        const result = await window.api.automations.runsForTicket({ ticketId });
        return result.ok ? result.runs.length : -1;
      }, seeded.moverId);

      await moveViaContextMenu(page, "PRB-1", "Todo");
      await waitUntil("PRB-1 to leave Doing", async () =>
        statusOf(page, seeded).then((status) => status === "todo"),
      );
      await moveViaContextMenu(page, "PRB-1", "Doing");
      await waitUntil("PRB-1 to land back in Doing", async () =>
        statusOf(page, seeded).then((status) => status === "doing"),
      );

      // No window at all: the arrival is a pure status change, exactly as one
      // into an unarmed column is.
      const open = await page.locator("[data-armed-run-window]").count();
      const state = await page.evaluate(
        async ({ projectId, ticketId }) => {
          const armings = await window.api.automations.armings({ projectId });
          const runs = await window.api.automations.runsForTicket({ ticketId });
          return {
            // The column keeps its arming: the switch is about the record.
            doingArmed: armings.ok ? armings.armings.some((a) => a.status === "doing") : false,
            runs: runs.ok ? runs.runs.length : -1,
          };
        },
        { projectId: seeded.projectId, ticketId: seeded.moverId },
      );
      return {
        ok: open === 0 && state.doingArmed === true && state.runs === runsBefore,
        detail: `windows=${open} doingArmed=${state.doingArmed} runs=${state.runs} (was ${runsBefore})`,
      };
    },
  );

  exitCode = summarize();
} finally {
  if (app !== null) await closeAppBounded(app);
  await cleanup();
}
process.exit(exitCode);
