/**
 * The Automations page (VC-127), driven through the REAL packed app.
 *
 * One isolated, model-less profile exercises the page, preload record guards,
 * and ticket rail. The genuinely empty rail runs BEFORE any record is created;
 * the populated rail fixtures come AFTER the page's exact lane/rank checks.
 * Every claim below crosses the real app boundary:
 *
 *   1. A dedicated Automations nav control exists, and clicking it lands on
 *      a page — not on a room inside Home.
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
 * Page and rail acts use the controls a person would use. Separately reported
 * M6 checks read durable records and probe invalid writes and MODEL_REQUIRED
 * directly through preload, requiring zero Run/Session rows after refusal.
 * M5 checks retain real rail geometry, inspection/Run and card context menus.
 * A live successful Run still needs credentials; none are used here.
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
  cardById,
  closeAppBounded,
  createRunner,
  launch,
  makeGitRepo,
  makeScratch,
  seedProjects,
  waitUntil,
} from "./lib/smoke-kit.mjs";
import {
  assertSettingsWindow,
  closeSettingsWindow,
  settingsPageOf,
} from "./lib/settings-window.mjs";

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
  // Exercise the editor with its full action row on a compact window too;
  // a wide local display otherwise hides a name field collapsed by controls.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 800));
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
      status: "doing",
    });
    if (!ticket.ok) return { fail: ticket.error };
    return { projectId: project.id, ticketId: ticket.ticket.id };
  });
  await must(0, "a project and a ticket in Doing exist", async () => ({
    ok: seeded.fail === undefined,
    detail: seeded.fail ?? `project=${seeded.projectId} ticket=${seeded.ticketId}`,
  }));

  // Tickets seeded straight into SQLite are not a board broadcast, so the
  // renderer meets them on its next read — the same reload the arming smoke
  // uses for the same reason.
  await page.reload();
  await cardById(page, "PRB-1").first().waitFor({ timeout: 30000 });

  /** Open the Ticket view the way a person does: double-click its card. */
  async function openTicket() {
    await cardById(page, "PRB-1").first().dblclick();
    await page.locator('[data-testid="ticket-rail-automations"]').waitFor({ timeout: 20000 });
  }

  /** Return the main window to the board after closing any native Settings window. */
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
    "M5.1",
    "with nothing to run, the block is still there and the header's door reaches the page",
    async () => {
      await openTicket();
      const heading = rail().getByRole("heading", { name: "Automations", exact: true });
      await heading.waitFor({ timeout: 15000 });
      const said = await rail().innerText();
      // VC-406 retired the rail's Run once; the block ends at its rows.
      const runOnce = await rail().locator('[data-testid="ticket-rail-run-once"]').count();
      const emptyReport = rail().getByText("No automations", { exact: true });
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
          said.includes("No automations") &&
          runOnce === 0 &&
          strayLinks === 0 &&
          doorSharesHeadingRow &&
          reportIsOneLine,
        detail: `${said.replaceAll("\n", " ").slice(0, 160)} · heading row: ${doorSharesHeadingRow} · one-line report: ${reportIsOneLine} · stray "Automations" links: ${strayLinks} · run once controls: ${runOnce}`,
      };
    },
  );

  let ownRecord;
  let globalRecord;

  /** Exact durable records, not only their rendered names. */
  async function listedRecords() {
    return page.evaluate(async (projectId) => {
      const listed = await window.api.automations.list({ projectId });
      if (!listed.ok) throw new Error(listed.error);
      return listed.automations;
    }, seeded.projectId);
  }

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

  await must(1, "the dedicated nav control opens the Automations page", async () => {
    const nav = page.getByRole("button", { name: "Automations", exact: true }).first();
    await nav.click();
    // The page's own heading, not the nav row's label: this asserts we ARRIVED.
    await page
      .getByRole("heading", { name: "Automations", exact: true })
      .waitFor({ timeout: 15000 });
    return { ok: true, detail: "nav → page" };
  });

  await must(
    2,
    "the New form opens empty behind a /skill placeholder, on the ruled defaults",
    async () => {
      // Creation goes through the FORM, not the door under it: the criterion is
      // about what a new Automation opens on, and only the form can answer it.
      await page.getByRole("button", { name: "New Automation" }).first().click();
      const form = page.locator('[data-slot="automation-editor"]');
      await form.waitFor({ timeout: 15000 });
      const instructions = form.getByRole("textbox", { name: "Instructions", exact: true });
      const opensEmpty = (await instructions.inputValue()) === "";
      const placeholder = await instructions.getAttribute("placeholder");
      const body = await form.innerText();
      const ok =
        opensEmpty &&
        (placeholder ?? "").includes("/skill") &&
        (await form
          .getByRole("tab", { name: "None", exact: true })
          .getAttribute("aria-selected")) === "true" &&
        body.includes("Project default");
      if (ok) {
        await form.getByRole("textbox", { name: "Name", exact: true }).fill("  Review sweep  ");
        await instructions.fill("Review the change set");
        // The default was None. Offer Doing explicitly so the later machine-local
        // arming test acts on a trigger that can actually fire.
        await form.getByRole("tab", { name: "Columns", exact: true }).click();
        await form.getByRole("checkbox", { name: "Doing", exact: true }).click();
        await form.getByRole("button", { name: "Create", exact: true }).click();
        await form
          .getByRole("heading", { name: "Review sweep", exact: true })
          .waitFor({ timeout: 15000 });
      }
      return {
        ok,
        detail: `empty=${opensEmpty} placeholder=${JSON.stringify(placeholder)} ${body.replaceAll("\n", " ").slice(0, 200)}`,
      };
    },
  );

  await must(
    "M6.1",
    "UI create persists a trimmed name, UUID, project and inherited runtime",
    async () => {
      const records = await listedRecords();
      ownRecord = records.find((record) => record.name === "Review sweep");
      return {
        ok:
          records.length === 1 &&
          ownRecord?.projectId === seeded.projectId &&
          ownRecord.runtime === null &&
          ownRecord.instructions === "Review the change set" &&
          ownRecord.trigger.kind === "columns" &&
          JSON.stringify(ownRecord.trigger.columns) === JSON.stringify(["doing"]) &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(ownRecord.id),
        detail: JSON.stringify(records),
      };
    },
  );

  await attempt(
    "M6.2",
    "blank names and unavailable pins are refused without inserting rows",
    async () => {
      const refusals = await page.evaluate(async (projectId) => {
        const before = await window.api.automations.list({ projectId });
        const blank = await window.api.automations.create({
          commandId: crypto.randomUUID(),
          projectId,
          name: "   ",
          instructions: "x",
          trigger: { kind: "none" },
          runtime: null,
        });
        const pin = await window.api.automations.create({
          commandId: crypto.randomUUID(),
          projectId,
          name: "Pinned",
          instructions: "x",
          trigger: { kind: "none" },
          runtime: { providerId: "nope", modelId: "ghost", reasoningLevel: "high" },
        });
        const after = await window.api.automations.list({ projectId });
        return {
          blank: blank.ok ? "ACCEPTED" : blank.error,
          pin: pin.ok ? "ACCEPTED" : pin.error,
          before: before.ok ? before.automations.map((record) => record.id) : null,
          after: after.ok ? after.automations.map((record) => record.id) : null,
        };
      }, seeded.projectId);
      return {
        ok:
          /Name/.test(refusals.blank) &&
          /not currently available/.test(refusals.pin) &&
          refusals.before?.length === 1 &&
          refusals.after?.length === refusals.before.length &&
          JSON.stringify(refusals.before) === JSON.stringify(refusals.after),
        detail: JSON.stringify(refusals),
      };
    },
  );

  await attempt(3, "the same form creates a global one, and the page lists both", async () => {
    await page.getByRole("button", { name: "New Automation" }).first().click();
    const form = page.locator('[data-slot="automation-editor"]');
    await form.getByRole("textbox", { name: "Name", exact: true }).fill("Nightly sweep");
    await form
      .getByRole("textbox", { name: "Instructions", exact: true })
      .fill("Run the nightly sweep");
    // Ownership decides WHERE it is listed, and is editable on create only.
    await form.getByRole("combobox", { name: "Scope", exact: true }).click();
    await page.getByRole("option", { name: "All projects" }).click();
    await form.getByRole("button", { name: "Create", exact: true }).click();
    await form
      .getByRole("heading", { name: "Nightly sweep", exact: true })
      .waitFor({ timeout: 15000 });
    await form.getByRole("button", { name: "All automations", exact: true }).click();
    await page.locator("[data-automation-rail-row]").filter({ hasText: "Nightly sweep" }).waitFor();

    // This probe is about which Automations are listed under which Ownership,
    // not about letter case.
    const body = (await page.locator("body").innerText()).toLowerCase();
    const ok =
      body.includes("review sweep") &&
      body.includes("nightly sweep") &&
      (await page
        .locator("[data-automation-rail-row]")
        .filter({ hasText: "Nightly sweep" })
        .getByRole("img", { name: "All projects", exact: true })
        .count()) === 1 &&
      // Its own first, the everywhere set after — main's order, on screen.
      body.indexOf("review sweep") < body.indexOf("nightly sweep");
    return { ok, detail: ok ? "both listed, own first" : body.slice(0, 400) };
  });

  await must(
    "M6.3",
    "the durable list puts the project's record before the global record",
    async () => {
      const records = await listedRecords();
      globalRecord = records.find((record) => record.name === "Nightly sweep");
      return {
        ok:
          records.length === 2 &&
          records[0].id === ownRecord.id &&
          records[1].id === globalRecord?.id &&
          globalRecord?.projectId === null &&
          globalRecord.runtime === null &&
          globalRecord.instructions === "Run the nightly sweep" &&
          globalRecord.trigger.kind === "none",
        detail: JSON.stringify(records),
      };
    },
  );

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
      await page.locator("[data-automation-rail-row]").filter({ hasText: "Review sweep" }).click();
      const control = page.getByLabel("Automatic triggers on this Mac: Review sweep");
      const restingState = await control.getAttribute("aria-checked");

      await control.click();
      await expectAriaChecked(control, "true");
      const on = await page.evaluate(async () => window.api.automations.enablement());
      const footprint = await repoFootprint(repoDir);

      // And back off, because a switch that only travels one way is half a
      // switch. Both state transitions must persist.
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
      await page
        .locator('[data-slot="automation-editor"]')
        .getByRole("button", { name: "Run Review sweep", exact: true })
        .click();
      const chooser = page.getByRole("dialog");
      await chooser.getByText("Run \u201cReview sweep\u201d on").waitFor({ timeout: 10000 });
      await chooser.getByRole("option", { name: /Probe ticket/ }).click();
      await chooser.getByRole("button", { name: /^Run on PRB-/ }).click();
      // The refusal's recovery is Model Access, in its own native window. Do
      // not click Settings again: this waits for the window the Run opened.
      const settings = await waitUntil(
        "the native Settings window for Model Access",
        () => settingsPageOf(app),
        { timeout: 20000 },
      );
      try {
        await assertSettingsWindow(app, page, settings);
      } finally {
        await closeSettingsWindow(app, settings);
      }
      await chooser.waitFor({ state: "hidden", timeout: 10000 });
      await page
        .locator('[data-slot="automation-editor"]')
        .getByRole("heading", { name: "Review sweep", exact: true })
        .waitFor();
      await page
        .getByRole("heading", { name: "Automations", exact: true })
        .waitFor({ timeout: 15000 });
      return { ok: true, detail: "ran from the row, refused for the missing model" };
    },
  );

  await attempt(
    "M6.5",
    "a direct Run returns MODEL_REQUIRED/shared guidance and leaves no Run or Session",
    async () => {
      const outcome = await page.evaluate(
        async ({ automationId, ticketId }) => {
          const runResult = await window.api.automations.run({
            commandId: crypto.randomUUID(),
            target: { kind: "automation", automationId },
            ticketId,
            modelOverride: null,
          });
          const runs = await window.api.automations.runsForTicket({ ticketId });
          const sessions = await window.api.sessions.listForTicket({ ticketId });
          return {
            refusal: runResult.ok
              ? { started: true }
              : { code: runResult.code, error: runResult.error },
            runRows: runs.ok ? runs.runs.length : -1,
            sessionRows: sessions.ok ? sessions.sessions.length : -1,
          };
        },
        { automationId: ownRecord.id, ticketId: seeded.ticketId },
      );
      return {
        ok:
          outcome.refusal.code === "MODEL_REQUIRED" &&
          /Choose a default model/.test(outcome.refusal.error ?? "") &&
          outcome.runRows === 0 &&
          outcome.sessionRows === 0,
        detail: JSON.stringify(outcome),
      };
    },
  );

  await attempt(
    6,
    "Duplicate is one explicit click, and lands on the copy's own form",
    async () => {
      await page
        .locator('[data-slot="automation-editor"]')
        .getByRole("button", { name: "More actions", exact: true })
        .click();
      await page.getByRole("menuitem", { name: "Duplicate" }).click();
      // The copy's form opens on the copy: the reason to duplicate is to change
      // something, and the Trigger is what VC-112 expects to change next.
      const form = page.locator('[data-slot="automation-editor"]');
      await form
        .getByRole("heading", { name: "Review sweep (copy)", exact: true })
        .waitFor({ timeout: 10000 });
      const named = await form
        .getByRole("heading", { name: "Review sweep (copy)", exact: true })
        .innerText();
      const instructions = await form
        .getByRole("region", { name: "Instructions", exact: true })
        .locator("p")
        .innerText();
      const names = await listedNames();
      // The duplicated work stays identical until this explicit trigger edit.
      const copiedTrigger = await form
        .getByRole("region", { name: "Trigger", exact: true })
        .innerText();
      await form.getByRole("button", { name: "Edit trigger", exact: true }).click();
      await form.getByRole("tab", { name: "None", exact: true }).click();
      await form.getByRole("button", { name: "Save trigger", exact: true }).click();
      await form
        .getByRole("region", { name: "Trigger", exact: true })
        .getByText("Manual only", { exact: true })
        .waitFor();
      return {
        ok:
          copiedTrigger.includes("Doing") &&
          named === "Review sweep (copy)" &&
          instructions === "Review the change set" &&
          names.includes("Review sweep") &&
          names.includes("Review sweep (copy)"),
        detail: `name=${named} instructions=${instructions} list=${names.join(" | ")}`,
      };
    },
  );

  await attempt(
    "7/M6.4",
    "the row's inline-name and instructions edits persist exact fields",
    async () => {
      const reviewId = await listedId("Review sweep");
      await page
        .locator('[data-slot="automation-editor"]')
        .getByRole("button", { name: "All automations", exact: true })
        .click();
      await page.locator(`[data-automation-rail-row="${reviewId}"]`).click();
      const form = page.locator('[data-slot="automation-editor"]');
      await form
        .getByRole("heading", { name: "Review sweep", exact: true })
        .getByRole("button")
        .click();
      const name = form.getByRole("textbox", { name: "Name", exact: true });
      await name.fill("Review sweep v2");
      await form.getByRole("button", { name: "Save name", exact: true }).click();
      // `.first()`: the lanes above the list draw the same names, so a rename is
      // on screen twice — in its lane and in its row.
      await form
        .getByRole("heading", { name: "Review sweep v2", exact: true })
        .waitFor({ timeout: 10000 });
      // Save another editable field as well as the inline name: the original
      // bridge tracer rewrote Instructions, and a name-only oracle is weaker.
      await form.getByRole("button", { name: "Edit instructions", exact: true }).click();
      await form.getByRole("textbox", { name: "Instructions", exact: true }).fill("/review again");
      await form.getByRole("button", { name: "Save instructions", exact: true }).click();
      await form
        .getByRole("region", { name: "Instructions", exact: true })
        .getByText("/review again", { exact: true })
        .waitFor();
      const records = await listedRecords();
      const updated = records.find((record) => record.id === ownRecord.id);
      return {
        ok:
          updated?.name === "Review sweep v2" &&
          updated.instructions === "/review again" &&
          updated.projectId === seeded.projectId &&
          updated.runtime === null &&
          JSON.stringify(updated.trigger) === JSON.stringify(ownRecord.trigger),
        detail: JSON.stringify(updated),
      };
    },
  );

  await attempt(8, "the Run-history door answers for this project and guards the id", async () => {
    // A Run needs a live model and spends tokens, so this probe stops at the
    // door. What the door OWES
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
    "9/M6.6",
    "Delete asks once, removes only the own record, and preserves the global record",
    async () => {
      await page
        .locator('[data-slot="automation-editor"]')
        .getByRole("button", { name: "More actions", exact: true })
        .click();
      await page.getByRole("menuitem", { name: "Delete…", exact: true }).click();
      const confirm = page.getByRole("alertdialog");
      await confirm.getByText("Delete \u201cReview sweep v2\u201d?").waitFor({ timeout: 10000 });
      await confirm.getByRole("button", { name: "Delete" }).click();
      await waitUntil(
        "the deleted record to leave the durable list",
        async () => !(await listedRecords()).some((record) => record.id === ownRecord.id),
      );
      const records = await listedRecords();
      const survivingGlobal = records.find((record) => record.id === globalRecord.id);
      return {
        ok:
          !records.some((record) => record.id === ownRecord.id) &&
          records.length === 2 &&
          records.some((record) => record.name === "Review sweep (copy)") &&
          survivingGlobal?.name === "Nightly sweep" &&
          survivingGlobal.projectId === null &&
          survivingGlobal.instructions === globalRecord.instructions &&
          survivingGlobal.runtime === null,
        detail: JSON.stringify(records),
      };
    },
  );

  /* ------------------------------------------- the lane view (VC-132) ---- */

  /** Every row of one lane, in drawn order: what it answers to, and which record it is. */
  async function laneDigits(status) {
    const names = { doing: "Doing", needs_review: "Needs Review", none: "Other" };
    await page
      .getByRole("tablist", { name: "Automation columns", exact: true })
      .getByRole("tab", { name: names[status], exact: true })
      .click();
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
  await page.getByRole("heading", { name: "Automations", exact: true }).waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "Columns", exact: true }).click();

  await must(10, "the page draws one lane per column, in digit order", async () => {
    await page
      .getByRole("tablist", { name: "Automation columns", exact: true })
      .getByRole("tab", { name: "Doing", exact: true })
      .click();
    await page.locator('[data-lane-row^="doing:"]').first().waitFor({ timeout: 15000 });
    const doing = await laneDigits("doing");
    const review = await laneDigits("needs_review");
    // Nothing has been arranged yet, so the digits read in the order main
    // listed the records — a stable 1…n for a project nobody has arranged.
    const offBoard = (await laneDigits("none")).length;
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
    const mover = page.locator(`[data-lane-row="${status}:${before[1].id}"]`);
    const target = page.locator(`[data-lane-row="${status}:${before[0].id}"]`);
    // The lanes scroll sideways and the page scrolls down: on a window narrower
    // or shorter than this developer's, a box measured without scrolling the
    // row into view is a box the pointer cannot reach.
    await mover.scrollIntoViewIfNeeded();
    await target.scrollIntoViewIfNeeded();
    const from = await stableBox(mover);
    const to = await stableBox(target);
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    // Past dnd-kit's 4px activation — and then WAIT for it, nudging on every
    // poll. A drop aimed before the drag began lands on nothing, and dnd-kit
    // activates on a pointer MOVE it is listening for: on a loaded runner the
    // first moves can all land before that listener is attached, so each poll
    // travels another pixel rather than waiting out a drag nobody started.
    let nudged = 0;
    await waitUntil(
      "dnd-kit to pick the row up",
      async () => {
        nudged = nudged === 0 ? 1 : 0;
        await page.mouse.move(from.x + from.width / 2 + nudged, from.y + from.height / 2 - 12, {
          steps: 4,
        });
        return mover.evaluate((row) => row.hasAttribute("data-lane-dragging"));
      },
      { timeout: 15_000, interval: 150 },
    );
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
    await page.getByRole("button", { name: "Columns", exact: true }).click();
    await page
      .getByRole("tablist", { name: "Automation columns", exact: true })
      .getByRole("tab", { name: "Doing", exact: true })
      .click();
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

  /* ------------------------ populated ticket rail (M5, after lane ranks) ---- */

  await must(
    "M5.prepare",
    "all page fixtures are removed before the three-offer rail phase",
    async () => {
      const outcome = await page.evaluate(async (projectId) => {
        // Manual records are offered as Any column too. After all page and
        // surviving-global proofs, retire every fixture in this private
        // profile, not just the three records used by the rank tests.
        const before = await window.api.automations.list({ projectId });
        if (!before.ok) throw new Error(`list before rail isolation: ${before.error}`);
        const disarmed = await window.api.automations.arm({
          commandId: crypto.randomUUID(),
          projectId,
          status: "doing",
          automationId: null,
        });
        const deleted = [];
        for (const { id: automationId } of before.automations) {
          const off = await window.api.automations.setEnabled({
            commandId: crypto.randomUUID(),
            automationId,
            enabled: false,
          });
          const removed = await window.api.automations.delete({
            commandId: crypto.randomUUID(),
            automationId,
          });
          deleted.push({ automationId, off: off.ok, removed: removed.ok });
        }
        const listed = await window.api.automations.list({ projectId });
        const armings = await window.api.automations.armings({ projectId });
        const enabled = await window.api.automations.enablement();
        return {
          disarmed: disarmed.ok,
          deleted,
          records: listed.ok ? listed.automations : null,
          armings: armings.ok ? armings.armings : null,
          enabledIds: enabled.ok ? enabled.enabledAutomationIds : null,
        };
      }, seeded.projectId);
      await backToBoard();
      return {
        ok:
          outcome.disarmed &&
          outcome.deleted.every((record) => record.off && record.removed) &&
          outcome.records?.length === 0 &&
          outcome.armings?.every((arm) => arm.automationId === null) &&
          outcome.enabledIds?.length === 0,
        detail: JSON.stringify(outcome),
      };
    },
  );

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
    if (!arm.ok) return { fail: arm.error };
    const listed = await window.api.automations.list({ projectId });
    const armings = await window.api.automations.armings({ projectId });
    const enabled = await window.api.automations.enablement();
    return {
      armedId: armed.automation.id,
      offeredId: offered.automation.id,
      elsewhereId: elsewhere.automation.id,
      offered: listed.ok
        ? listed.automations.filter((record) => record.trigger.kind === "columns")
        : null,
      armings: armings.ok ? armings.armings : null,
      enabledIds: enabled.ok ? enabled.enabledAutomationIds : null,
    };
  }, seeded.projectId);
  try {
    await must(
      "M5.2",
      "three exact rail offers persist, Doing armed and all automatic triggers off",
      async () => {
        const ids = [created.armedId, created.offeredId, created.elsewhereId];
        const columns = new Map(
          created.offered?.map((record) => [record.id, record.trigger.columns]),
        );
        return {
          ok:
            created.fail === undefined &&
            created.offered?.length === 3 &&
            ids.every((id) => created.offered.some((record) => record.id === id)) &&
            JSON.stringify(columns.get(created.armedId)) === JSON.stringify(["doing"]) &&
            JSON.stringify(columns.get(created.offeredId)) === JSON.stringify(["doing"]) &&
            JSON.stringify(columns.get(created.elsewhereId)) === JSON.stringify(["done"]) &&
            created.armings?.some(
              (arm) => arm.status === "doing" && arm.automationId === created.armedId,
            ) &&
            created.enabledIds !== null &&
            ids.every((id) => !created.enabledIds.includes(id)),
          detail: JSON.stringify(created),
        };
      },
    );

    await must("M5.3", "the offer list marks this column's Armed automation in place", async () => {
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
      const authoringControls = await rail().getByRole("textbox").count();
      return {
        ok:
          label === "Inspect Review sweep" &&
          markedCount === 1 &&
          pageDoors === 1 &&
          authoringControls === 0,
        detail: `marked=${label} markedCount=${markedCount} pageDoors=${pageDoors} authoringControls=${authoringControls}`,
      };
    });

    await attempt("M5.4", "the list draws every column's Offered work as a row", async () => {
      const items = await rail().locator('[data-testid="ticket-rail-automation-list"]').innerText();
      const rowCount = await offerRows().count();
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
          rowCount === 3 &&
          offRows === 3 &&
          offTitle.includes("Manual only"),
        detail: `${items.replaceAll("\n", " | ").slice(0, 200)} · rows: ${rowCount} · off rows: ${offRows} · title: ${offTitle}`,
      };
    });

    await attempt("M5.5", "the Armed row's inspection reaches the Run door", async () => {
      // Two acts now, not one (VC-406): the ROW opens the record, and the Run
      // inside it is its own labelled press. No default model on this profile,
      // so the Run's own refusal opens Model Access — which is the evidence the
      // press reached the door.
      await armedOfferRow().first().click();
      await inspection().waitFor({ timeout: 15000 });
      await page.getByTestId("ticket-rail-automation-run").click();
      // The missing-model refusal opens Model Access in the native Settings
      // window; the press itself is the evidence, so never click Settings again.
      const settings = await waitUntil(
        "the native Settings window for Model Access",
        () => settingsPageOf(app),
        { timeout: 20000 },
      );
      try {
        await assertSettingsWindow(app, page, settings);
      } finally {
        await closeSettingsWindow(app, settings);
      }
      await backToBoard();
      return { ok: true, detail: "ran the armed Automation, refused for the missing model" };
    });

    await attempt(
      "M5.6",
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
          const sessions = await window.api.sessions.listForTicket({ ticketId });
          return {
            runs: mine.ok ? mine.runs.length : -1,
            sessions: sessions.ok ? sessions.sessions.length : -1,
          };
        }, seeded.ticketId);
        return {
          ok: drawn === 0 && outcome.runs === 0 && outcome.sessions === 0,
          detail: `lists=${drawn} ${JSON.stringify(outcome)}`,
        };
      },
    );

    await attempt("M5.7", "right-clicking a row opens that row's own inspection", async () => {
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

    await attempt("M5.8", "the board card runs one without opening the Ticket", async () => {
      await cardById(page, "PRB-1").first().click({ button: "right" });
      const menu = page.getByRole("menu").first();
      await menu.waitFor({ timeout: 10000 });
      await menu.getByRole("menuitem", { name: "Automations" }).hover();
      const submenu = page.getByRole("menu").nth(1);
      await submenu.waitFor({ timeout: 10000 });
      const items = await submenu.innerText();
      // Group labels read as their parts — the column, then the mark naming this
      // Ticket's own — case-folded: how the label lays out and cases those parts
      // is presentation, while the order is the claim.
      const headings = await submenu
        .locator('[data-slot="context-menu-label"]')
        .evaluateAll((labels) =>
          labels.map((label) =>
            [...label.childNodes]
              .map((part) => part.textContent?.trim() ?? "")
              .filter(Boolean)
              .join(" · ")
              .toLowerCase(),
          ),
        );
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      const ownColumn = headings.indexOf("doing · this ticket");
      const doneColumn = headings.indexOf("done");
      return {
        ok:
          items.includes("Review sweep") &&
          items.includes("Nightly sweep") &&
          items.includes("Done sweep") &&
          ownColumn >= 0 &&
          ownColumn < doneColumn &&
          // A card has nowhere to type an Unbound Run, so it offers none.
          !items.includes("Run once"),
        detail: `headings=${JSON.stringify(headings)} ${items.replaceAll("\n", " | ").slice(0, 200)}`,
      };
    });
  } finally {
    await attempt("M5.cleanup", "the rail fixtures finish disarmed and disabled", async () => {
      const outcome = await page.evaluate(
        async ({ projectId, ids }) => {
          const disarmed = await window.api.automations.arm({
            commandId: crypto.randomUUID(),
            projectId,
            status: "doing",
            automationId: null,
          });
          const off = [];
          for (const automationId of ids) {
            const result = await window.api.automations.setEnabled({
              commandId: crypto.randomUUID(),
              automationId,
              enabled: false,
            });
            off.push(result.ok);
          }
          const armings = await window.api.automations.armings({ projectId });
          const enabled = await window.api.automations.enablement();
          return {
            disarmed: disarmed.ok,
            off,
            armings: armings.ok ? armings.armings : null,
            enabledIds: enabled.ok ? enabled.enabledAutomationIds : null,
          };
        },
        {
          projectId: seeded.projectId,
          ids: [created.armedId, created.offeredId, created.elsewhereId].filter(Boolean),
        },
      );
      return {
        ok:
          outcome.disarmed &&
          outcome.off.every(Boolean) &&
          outcome.armings?.every((arm) => arm.automationId === null) &&
          outcome.enabledIds?.length === 0,
        detail: JSON.stringify(outcome),
      };
    });
  }

  exitCode = summarize();
} finally {
  if (app !== null) await closeAppBounded(app);
  await cleanup();
}
process.exit(exitCode);
