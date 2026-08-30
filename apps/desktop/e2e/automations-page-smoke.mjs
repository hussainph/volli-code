/**
 * The Automations page (VC-127), driven through the REAL packed app.
 *
 * The tracer smoke beside this one (`automations-smoke.mjs`) owns the record's
 * CRUD and the Run door. What this one proves is what the PAGE promises, and
 * every claim below is one a unit test cannot make:
 *
 *   1. A fourth nav row exists beside Home and Configure, and clicking it
 *      lands on a page — not on a room inside Home.
 *   2. The New form opens EMPTY behind a `/skill` placeholder, on the manual
 *      Trigger and an inherited Runtime — and creating through it works, for
 *      both Ownerships, so the page lists its own and the global ones.
 *   3. The row's switch turns an Automation ON for this machine and off
 *      again, and writes NOTHING into the project's git repo. "Never travels
 *      with the project" is a claim about the repository, so the repository
 *      is what gets checked, on both sides of the click.
 *   4. An Automation the switch has NOT turned on is still runnable by hand
 *      from this page — through the row's own Run control, on a Ticket chosen
 *      here — and fails only for the ordinary missing-model reason.
 *   5. Duplicate is one explicit click that yields a second, distinguishable
 *      record carrying the same work, and lands on the copy's own form.
 *   6. A row opens the ONE authoring form, and an edit through it sticks.
 *   7. Delete asks once and removes the record — there is no archive.
 *   8. The Run-history door is project-scoped and guards its id.
 *   9. Delete asks once and removes the record.
 *  10. The page draws one LANE per board column holding that column's Offered
 *      list in digit order, plus a lane for the records no column offers.
 *  11. A lane is arranged by DRAGGING a row, and the new digit order survives a
 *      reload — the rank is durable, and machine-local like the arming.
 *  12. One Automation holds a different rank in two columns.
 *
 * Every act above goes through the CONTROL a person would use, not the IPC
 * door underneath it. The doors are the tracer smoke's subject; whether the
 * page is wired to them is this one's.
 *
 * Needs a display and the built app; it runs on the desktop smoke lane with no
 * registration step (`apps/desktop/scripts/run-smokes.mjs` globs this name).
 * Locally:
 *
 *   pnpm -w run build
 *   node apps/desktop/e2e/automations-page-smoke.mjs
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

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

const run = promisify(execFile);
const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("volli-automations-page-");
const { attempt, must, summarize } = createRunner();

console.log("scratch:", scratch, "\n");

/** Waits for a switch to actually READ as on or off, not merely to be clicked. */
async function expectAriaChecked(locator, value) {
  await locator
    .page()
    .waitForFunction(
      ({ selector, expected }) =>
        document.querySelector(selector)?.getAttribute("aria-checked") === expected,
      { selector: `[aria-label="${await locator.getAttribute("aria-label")}"]`, expected: value },
      { timeout: 10000 },
    );
}

/** Everything git can see in the repo: tracked changes plus untracked files. */
async function repoFootprint(repoDir) {
  const { stdout } = await run("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: repoDir,
  });
  return stdout.trim();
}

/** A box measured only once it has stopped moving (rows animate into place). */
async function stableBox(locator) {
  let last = null;
  await waitUntil(
    "a lane row to stop moving",
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

let app = null;
let exitCode = 1;
try {
  const repoDir = await makeGitRepo(scratch);
  const cleanRepo = await repoFootprint(repoDir);

  app = await launch({ dbPath, userDataDir });
  let page = await app.firstWindow();
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
    const ticket = await window.api.tickets.create({
      projectId: project.id,
      title: "Probe ticket",
      status: "todo",
    });
    if (!ticket.ok) return { fail: ticket.error };
    return { projectId: project.id, ticketId: ticket.ticket.id };
  });
  await must(0, "a project and a ticket exist", async () => ({
    ok: seeded.fail === undefined,
    detail: seeded.fail ?? `project=${seeded.projectId} ticket=${seeded.ticketId}`,
  }));

  /** Every Automation this project lists, by name, straight from the record. */
  async function listedNames() {
    return page.evaluate(async (projectId) => {
      const listed = await window.api.automations.list({ projectId });
      return listed.ok ? listed.automations.map((a) => a.name) : [listed.error];
    }, seeded.projectId);
  }

  /** The id of one listed Automation, for the machine-local set's own check. */
  async function listedId(name) {
    return page.evaluate(
      async ({ projectId, name: wanted }) => {
        const listed = await window.api.automations.list({ projectId });
        if (!listed.ok) return null;
        return listed.automations.find((a) => a.name === wanted)?.id ?? null;
      },
      { projectId: seeded.projectId, name },
    );
  }

  await must(1, "a fourth nav row opens the Automations page", async () => {
    const nav = page.getByRole("button", { name: "Automations", exact: true }).first();
    await nav.click();
    // The page's own heading, not the nav row's label: this asserts we ARRIVED.
    await page.getByRole("heading", { name: "Automations" }).waitFor({ timeout: 15000 });
    return { ok: true, detail: "nav → page" };
  });

  await must(
    2,
    "the New form opens empty behind a /skill placeholder, on the ruled defaults",
    async () => {
      // Creation goes through the FORM, not the door under it: the criterion is
      // about what a new Automation opens on, and only the form can answer it.
      await page.getByRole("button", { name: "New Automation" }).first().click();
      const dialog = page.getByRole("dialog");
      await dialog.getByText("New Automation").waitFor({ timeout: 15000 });
      const instructions = dialog.getByLabel("Instructions");
      const opensEmpty = (await instructions.inputValue()) === "";
      const placeholder = await instructions.getAttribute("placeholder");
      const body = await dialog.innerText();
      const ok =
        opensEmpty &&
        (placeholder ?? "").includes("/skill") &&
        body.includes("Only when I run it") &&
        body.includes("Default model");
      if (ok) {
        await dialog.getByLabel("Name").fill("Review sweep");
        await instructions.fill("Review the change set");
        await dialog.getByRole("button", { name: "Create automation" }).click();
        await page.getByText("Review sweep").first().waitFor({ timeout: 15000 });
      }
      return {
        ok,
        detail: `empty=${opensEmpty} placeholder=${JSON.stringify(placeholder)} ${body.replaceAll("\n", " ").slice(0, 200)}`,
      };
    },
  );

  await attempt(3, "the same form creates a global one, and the page lists both", async () => {
    await page.getByRole("button", { name: "New Automation" }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name").fill("Nightly sweep");
    await dialog.getByLabel("Instructions").fill("Run the nightly sweep");
    // Ownership decides WHERE it is listed, and is editable on create only.
    await dialog.getByRole("button", { name: "All projects" }).click();
    await dialog.getByRole("button", { name: "Create automation" }).click();
    await page.getByText("Nightly sweep").first().waitFor({ timeout: 15000 });

    // Lowercased because `innerText` reports the RENDERED text and the section
    // eyebrows are `uppercase` in CSS. This probe is about which Automations
    // are listed under which Ownership, not about letter case.
    const body = (await page.locator("body").innerText()).toLowerCase();
    const ok =
      body.includes("this project") &&
      body.includes("review sweep") &&
      body.includes("all projects") &&
      body.includes("nightly sweep") &&
      // Its own first, the everywhere set after — main's order, on screen.
      body.indexOf("review sweep") < body.indexOf("nightly sweep");
    return { ok, detail: ok ? "both listed, own first" : body.slice(0, 400) };
  });

  await attempt(
    4,
    "the switch turns it on for this machine and off again, touching no git repo",
    async () => {
      // Through the CONTROL, not the door: "local to this machine" is a promise
      // about what a person's click does, and the repo is checked on both sides
      // of it because "never travels with the project" is a claim about the
      // repository rather than about the database.
      //
      // It starts OFF: VC-112 rules that a machine fires nothing until someone
      // turns something on there, so the resting row says so.
      const ownId = await listedId("Review sweep");
      const control = page.getByLabel("Enabled on this machine: Review sweep");
      const restingState = await control.getAttribute("aria-checked");
      await page.getByText("Won\u2019t start on its own").first().waitFor({ timeout: 10000 });

      await control.click();
      await expectAriaChecked(control, "true");
      const on = await page.evaluate(async () => window.api.automations.enablement());
      const footprint = await repoFootprint(repoDir);

      // And back off, because a switch that only travels one way is half a
      // switch — the arm the first review found untested.
      await control.click();
      await expectAriaChecked(control, "false");
      const off = await page.evaluate(async () => window.api.automations.enablement());

      return {
        ok:
          restingState === "false" &&
          on.ok &&
          on.enabledAutomationIds.includes(ownId) &&
          off.ok &&
          !off.enabledAutomationIds.includes(ownId) &&
          footprint === cleanRepo,
        detail: `resting=${restingState} on=${JSON.stringify(on.enabledAutomationIds)} off=${JSON.stringify(off.enabledAutomationIds)} repo=${JSON.stringify(footprint)} was=${JSON.stringify(cleanRepo)}`,
      };
    },
  );

  await attempt(
    5,
    "an Automation that is off still runs by hand, from this page's own control",
    async () => {
      // VC-112: run by hand is universal, and the Trigger says only what ELSE
      // starts an Automation. So a record nobody switched on must still reach
      // the Run door through the page — and fail there for the ordinary reason
      // (no default model on this profile), never be refused for being off.
      // The recovery for that reason is Model Access, so Settings opening on it
      // IS the evidence that the click reached the door.
      await page.getByLabel("Run Review sweep").click();
      const chooser = page.getByRole("dialog");
      await chooser.getByText("Run \u201cReview sweep\u201d on").waitFor({ timeout: 10000 });
      await chooser.getByRole("button", { name: /Probe ticket/ }).click();
      const settings = page.getByRole("navigation", { name: "Settings categories" });
      await settings.waitFor({ timeout: 20000 });
      // Back to the page: Settings is a surface, not an overlay, and every nav
      // click closes it.
      await page.getByRole("button", { name: "Automations", exact: true }).first().click();
      await page.getByRole("heading", { name: "Automations" }).waitFor({ timeout: 15000 });
      return { ok: true, detail: "ran from the row, refused for the missing model" };
    },
  );

  await attempt(
    6,
    "Duplicate is one explicit click, and lands on the copy's own form",
    async () => {
      await page.getByLabel("Actions for Review sweep").click();
      await page.getByRole("menuitem", { name: "Duplicate" }).click();
      // The copy's form opens on the copy: the reason to duplicate is to change
      // something, and the Trigger is what VC-112 expects to change next.
      const dialog = page.getByRole("dialog");
      await dialog.getByText("Edit Automation").waitFor({ timeout: 10000 });
      const named = await dialog.getByLabel("Name").inputValue();
      const instructions = await dialog.getByLabel("Instructions").inputValue();
      await page.keyboard.press("Escape");
      const names = await listedNames();
      return {
        ok:
          named === "Review sweep (copy)" &&
          instructions === "Review the change set" &&
          names.includes("Review sweep") &&
          names.includes("Review sweep (copy)"),
        detail: `name=${named} instructions=${instructions} list=${names.join(" | ")}`,
      };
    },
  );

  await attempt(7, "the row opens the one authoring form, and an edit sticks", async () => {
    await page
      .getByRole("button", { name: /^Review sweep\b/ })
      .first()
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText("Edit Automation").waitFor({ timeout: 10000 });
    const name = dialog.getByLabel("Name");
    await name.fill("Review sweep v2");
    await dialog.getByRole("button", { name: "Save changes" }).click();
    // `.first()`: the lanes above the list draw the same names, so a rename is
    // on screen twice — in its lane and in its row.
    await page.getByText("Review sweep v2").first().waitFor({ timeout: 10000 });
    const names = await listedNames();
    return { ok: names.includes("Review sweep v2"), detail: names.join(" | ") };
  });

  await attempt(8, "the Run-history door answers for this project and guards the id", async () => {
    // A Run needs a live model and spends tokens, so this probe stops at the
    // door \u2014 the same line `automations-smoke.mjs` draws. What the door OWES
    // (project scoping through the Run's own Session, newest-first order, the
    // resolved model, and a door that survives its Ticket) is pinned in
    // `automations-repo.test.ts` and the page test.
    const outcome = await page.evaluate(async (projectId) => {
      const mine = await window.api.automations.runsForProject({ projectId });
      const stranger = await window.api.automations.runsForProject({
        projectId: "no-such-project",
      });
      return {
        mine: mine.ok ? mine.runs.length : `refused: ${mine.error}`,
        stranger: stranger.ok ? "ACCEPTED" : stranger.error,
      };
    }, seeded.projectId);
    return {
      ok: outcome.mine === 0 && outcome.stranger === "Unknown project",
      detail: JSON.stringify(outcome),
    };
  });

  await attempt(
    9,
    "Delete asks once, then removes the record \u2014 there is no archive",
    async () => {
      await page.getByLabel("Actions for Review sweep v2").click();
      await page.getByRole("menuitem", { name: "Delete" }).click();
      const confirm = page.getByRole("alertdialog");
      await confirm.getByText("Can\u2019t be undone").waitFor({ timeout: 10000 });
      await confirm.getByRole("button", { name: "Delete" }).click();
      const names = await listedNames();
      return {
        ok: !names.includes("Review sweep v2") && names.includes("Nightly sweep"),
        detail: names.join(" | "),
      };
    },
  );

  /* ------------------------------------------- the lane view (VC-132) ---- */

  /** Every row of one lane, in drawn order: what it answers to, and which record it is. */
  async function laneDigits(status) {
    return page.locator(`[data-lane-row^="${status}:"]`).evaluateAll((rows) =>
      rows.map((row) => ({
        digit: row.getAttribute("data-lane-digit"),
        id: (row.getAttribute("data-lane-row") ?? "").split(":").slice(1).join(":"),
        name: (row.textContent ?? "").replace(/^\s*\d+\s*/, "").trim(),
      })),
    );
  }

  const laneSeed = await page.evaluate(async (projectId) => {
    // Two Automations offered in Doing, one of them offered in Needs Review as
    // well: the record that must be able to hold a different rank in each.
    const shared = await window.api.automations.create({
      commandId: crypto.randomUUID(),
      projectId,
      name: "Standards sweep",
      instructions: "/standards",
      trigger: { kind: "columns", columns: ["doing", "needs_review"] },
      runtime: null,
    });
    const implement = await window.api.automations.create({
      commandId: crypto.randomUUID(),
      projectId,
      name: "Implement",
      instructions: "/implement",
      trigger: { kind: "columns", columns: ["doing"] },
      runtime: null,
    });
    const review = await window.api.automations.create({
      commandId: crypto.randomUUID(),
      projectId,
      name: "Two-opinion review",
      instructions: "/review",
      trigger: { kind: "columns", columns: ["needs_review"] },
      runtime: null,
    });
    if (!shared.ok || !implement.ok || !review.ok) return { fail: "create failed" };
    return {
      sharedId: shared.automation.id,
      implementId: implement.automation.id,
      reviewId: review.automation.id,
    };
  }, seeded.projectId);
  await page.reload();
  await page.getByRole("button", { name: "Automations", exact: true }).first().click();
  await page.getByRole("heading", { name: "Automations" }).waitFor({ timeout: 15000 });

  await must(10, "the page draws one lane per column, in digit order", async () => {
    await page.locator('[data-lane-row^="doing:"]').first().waitFor({ timeout: 15000 });
    const doing = await laneDigits("doing");
    const review = await laneDigits("needs_review");
    // Nothing has been arranged yet, so the digits read in the order main
    // listed the records — a stable 1…n for a project nobody has arranged.
    const offBoard = await page.locator('[data-lane-row^="none:"]').count();
    return {
      ok:
        laneSeed.fail === undefined &&
        doing.length === 2 &&
        doing[0].digit === "1" &&
        doing[1].digit === "2" &&
        review.length === 2 &&
        // "Nightly sweep" answers to no column and is still on the page.
        offBoard > 0,
      detail: `doing=${JSON.stringify(doing)} review=${JSON.stringify(review)} offBoard=${offBoard}`,
    };
  });

  /**
   * Drags a lane's SECOND row above its first, through the control a person
   * uses. Answers with what the lane read before and after.
   */
  async function flipLane(status) {
    const before = await laneDigits(status);
    const from = await stableBox(page.locator(`[data-lane-row="${status}:${before[1].id}"]`));
    const to = await stableBox(page.locator(`[data-lane-row="${status}:${before[0].id}"]`));
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    // Past dnd-kit's 4px activation, then above the row it is displacing.
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 - 12, { steps: 6 });
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2 - 4, { steps: 12 });
    await page.mouse.up();
    await waitUntil(
      `the ${status} lane to renumber`,
      async () => (await laneDigits(status))[0]?.id === before[1].id,
      { timeout: 10_000 },
    );
    return { before, after: await laneDigits(status) };
  }

  await must(11, "dragging a row rewrites the digits, and the rank survives a reload", async () => {
    const { before, after } = await flipLane("doing");

    // Durable, and machine-local: read back through the door, then again after
    // a reload, because a rank that only lived in this renderer would print one
    // digit here and mean another to the next drag.
    const stored = await page.evaluate(async (projectId) => {
      const result = await window.api.automations.columnOrders({ projectId });
      return result.ok
        ? result.orders.map((order) => `${order.status}:${order.rankedAutomationIds.join(",")}`)
        : [`refused: ${result.error}`];
    }, seeded.projectId);
    await page.reload();
    await page.getByRole("button", { name: "Automations", exact: true }).first().click();
    await page.locator('[data-lane-row^="doing:"]').first().waitFor({ timeout: 15000 });
    const reloaded = await laneDigits("doing");
    return {
      ok:
        after[0].id === before[1].id &&
        after[0].digit === "1" &&
        after[1].id === before[0].id &&
        stored.includes(`doing:${before[1].id},${before[0].id}`) &&
        reloaded[0].id === before[1].id,
      detail: `before=${JSON.stringify(before)} after=${JSON.stringify(after)} reloaded=${JSON.stringify(reloaded)} stored=${JSON.stringify(stored)}`,
    };
  });

  await attempt(12, "one Automation holds a different rank in two columns", async () => {
    // "Standards sweep" is offered in Doing and in Needs Review. Arranging one
    // lane must not touch the other, so flipping Needs Review leaves it at a
    // different digit in each.
    const doingBefore = await laneDigits("doing");
    await flipLane("needs_review");
    const doing = await laneDigits("doing");
    const review = await laneDigits("needs_review");
    const inDoing = doing.find((row) => row.id === laneSeed.sharedId)?.digit;
    const inReview = review.find((row) => row.id === laneSeed.sharedId)?.digit;
    return {
      // One record, two lanes, two digits: the arrangement is a property of the
      // COLUMN, which is the whole reason it is keyed by (project, status).
      ok:
        inDoing !== undefined &&
        inReview !== undefined &&
        inDoing !== inReview &&
        // …and Doing is exactly where check 11 left it.
        JSON.stringify(doing) === JSON.stringify(doingBefore),
      detail: `doing=${inDoing} needs_review=${inReview} doingOrder=${JSON.stringify(doing.map((row) => row.digit + row.name))}`,
    };
  });

  exitCode = summarize();
} finally {
  if (app !== null) await closeAppBounded(app);
  await cleanup();
}
process.exit(exitCode);
