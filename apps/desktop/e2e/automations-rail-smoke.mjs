/**
 * The ticket rail's Automations block (VC-129), driven through the REAL packed
 * app and through the CONTROLS a person would use — never the IPC door under
 * them. The doors themselves are the tracer smoke's subject
 * (`automations-smoke.mjs`); whether the rail is wired to them is this one's.
 *
 * What it proves, in dependency order:
 *   1. With no Automations in the project at all, the rail still draws its run
 *      control, says so in one line, and links to the Automations page — the
 *      button is never hidden when empty.
 *   2. With a column armed, the split button's default half names that
 *      Automation, because the Ticket sits in that column.
 *   3. The caret menu is that column's Offered list plus "Run once…" — a
 *      switched-off Automation among them, offered with its own note rather
 *      than withheld (running by hand is universal, VC-112).
 *   4. Pressing the default half reaches the Run door.
 *   5. "Run once…" takes Instructions and offers this invocation its own
 *      Runtime, and starting it reaches the Run door while writing NO record:
 *      the project's Automation list is unchanged and the git repo is
 *      untouched, so there is nothing afterwards to name, disable or delete.
 *   6. There is no authoring form anywhere in the rail: no Name, no Trigger,
 *      no save, no delete.
 *   7. This Ticket's Runs are drawn from this Ticket's own read: with nothing
 *      run yet the rail draws no list, and the door it reads agrees.
 *   8. Right-clicking the control opens the nested context menu — the other
 *      deliberate surface VC-112 names for the per-invocation override.
 *   9. The board card's own `Automations ▸` submenu offers this column's list
 *      without opening the Ticket, and holds the same nested override.
 *
 * TWO LIMITS, both stated rather than papered over:
 *
 *  - **A Run needs a live model.** This profile has no default model, so checks
 *    4 and 5 land on the Session start's own `MODEL_REQUIRED` refusal, whose
 *    recovery is Model Access — Settings opening on it IS the evidence the
 *    click reached the door. `run.test.ts` owns the happy path, including the
 *    unbound Run's own Session and its `null` Automation.
 *  - **The nested model override depends on the catalog.** Its submenu lists
 *    the models a picker may offer, so on a profile with nothing available it
 *    is correctly absent — which makes it a bad thing to require. Checks 4, 8
 *    and 9 PRINT the menu they found (the override row shows up as "Run on
 *    model" when there is a catalog) and require only what must always be
 *    there. What the override menu may name — never a model without a
 *    reasoning level it can run — is pinned in
 *    `ticket-rail-automations-model.test.ts`; that the pick SURVIVES into the
 *    Run, including into a Run once form opened by it, is pinned in
 *    `ticket-rail-automations.test.tsx` and `automation-run-menu.test.tsx`.
 *    The override surface this probe does require is the Run once form's own
 *    Runtime control, which the rail draws whatever the catalog says.
 *
 * No fixed sleeps: every wait is on a real signal.
 *
 * MANUALLY RUN (needs a display + the built app):
 *
 *   pnpm -w run build
 *   node apps/desktop/e2e/automations-rail-smoke.mjs
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
} from "./lib/smoke-kit.mjs";

const run = promisify(execFile);
const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("volli-automations-rail-");
const { attempt, must, summarize } = createRunner();

console.log("scratch:", scratch, "\n");

/** Everything git can see in the repo: tracked changes plus untracked files. */
async function repoFootprint(repoDir) {
  const { stdout } = await run("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: repoDir,
  });
  return stdout.trim();
}

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
  const cleanRepo = await repoFootprint(repoDir);

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

  /** Every Automation this project lists, by name, straight from the record. */
  async function listedNames() {
    return page.evaluate(async (projectId) => {
      const listed = await window.api.automations.list({ projectId });
      return listed.ok ? listed.automations.map((a) => a.name) : [listed.error];
    }, seeded.projectId);
  }

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

  await must(
    1,
    "with nothing to run, the control is still there and links to the page",
    async () => {
      await openTicket();
      const control = page.getByLabel("Run Run once on this ticket");
      await control.waitFor({ timeout: 15000 });
      const said = await rail().innerText();
      // The door out of the empty state is the page, because the rail never
      // authors (VC-112).
      await rail().getByRole("button", { name: "Automations", exact: true }).click();
      await page.getByRole("heading", { name: "Automations" }).waitFor({ timeout: 15000 });
      await backToBoard();
      return {
        ok: said.includes("No automations in this project yet."),
        detail: said.replaceAll("\n", " ").slice(0, 200),
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

  await must(
    3,
    "the default half of the split button is this column's Armed automation",
    async () => {
      await openTicket();
      const armed = page.getByLabel("Run Review sweep on this ticket");
      await armed.waitFor({ timeout: 15000 });
      return { ok: true, detail: "Doing is armed with Review sweep, and the button says so" };
    },
  );

  await attempt(4, "its menu is this column's Offered list plus Run once…", async () => {
    await page.getByLabel("Other automations").click();
    const menu = page.getByRole("menu").first();
    await menu.waitFor({ timeout: 10000 });
    const items = await menu.innerText();
    await page.keyboard.press("Escape");
    return {
      ok:
        items.includes("Review sweep") &&
        items.includes("Nightly sweep") &&
        // Offered is the record's Trigger: an Automation that names another
        // column is not offered here.
        !items.includes("Done sweep") &&
        items.includes("Run once") &&
        // Nobody switched anything on here, and a switched-off Automation is
        // still offered — with the note that says what off means.
        items.includes("Switched off"),
      detail: items.replaceAll("\n", " | ").slice(0, 240),
    };
  });

  await attempt(5, "pressing the default half reaches the Run door", async () => {
    // No default model on this profile, so the Run's own refusal opens Model
    // Access — which is the evidence the press reached the door.
    await page.getByLabel("Run Review sweep on this ticket").click();
    await page.getByRole("navigation", { name: "Settings categories" }).waitFor({ timeout: 20000 });
    await backToBoard();
    return { ok: true, detail: "ran the armed Automation, refused for the missing model" };
  });

  await attempt(
    6,
    "Run once takes Instructions and its own Runtime, and saves nothing",
    async () => {
      await openTicket();
      await page.getByLabel("Other automations").click();
      await page.getByRole("menuitem", { name: /Run once/ }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Instructions").waitFor({ timeout: 10000 });
      const form = await dialog.innerText();
      // No authoring form: an Unbound Run has nothing to name, and nothing here
      // offers to save one.
      const authoring =
        (await dialog.getByLabel("Name").count()) > 0 ||
        (await dialog.getByRole("button", { name: /Create automation|Save changes/ }).count()) > 0;
      await dialog.getByLabel("Instructions").fill("/review just this once");
      await dialog.getByRole("button", { name: "Run", exact: true }).click();
      await page
        .getByRole("navigation", { name: "Settings categories" })
        .waitFor({ timeout: 20000 });
      const names = await listedNames();
      const footprint = await repoFootprint(repoDir);
      await backToBoard();
      return {
        ok:
          !authoring &&
          // The per-invocation Runtime, on the rail's own surface.
          form.includes("Default model") &&
          form.includes("This run") &&
          // Nothing was named, so nothing was added to name, disable or delete.
          names.length === 3 &&
          !names.includes("/review just this once") &&
          footprint === cleanRepo,
        detail: `authoring=${authoring} list=${names.join(" | ")} repo=${JSON.stringify(footprint)} form=${form.replaceAll("\n", " ").slice(0, 160)}`,
      };
    },
  );

  await attempt(7, "this Ticket's Runs are drawn from this Ticket's own read", async () => {
    // A Run needs a live model and spends tokens, so nothing has run here: the
    // VISIBLE evidence is that the rail draws no run list, and the door it
    // reads says the same. What the rail DOES with rows once they exist
    // (newest first, the resolved model, a door back to the Session) is pinned
    // in `ticket-rail-automations.test.tsx`, which can mint Runs freely.
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
  });

  await attempt(8, "right-clicking the control opens the nested context menu", async () => {
    // The second deliberate surface VC-112 names beside the rail itself. The
    // override row rides here when the profile has a catalog; this profile has
    // none, so the row is printed rather than required.
    await page.getByLabel("Run Review sweep on this ticket").click({ button: "right" });
    const menu = page.getByRole("menu").first();
    await menu.waitFor({ timeout: 10000 });
    const items = await menu.innerText();
    await page.keyboard.press("Escape");
    await backToBoard();
    return {
      ok:
        items.includes("Review sweep") &&
        items.includes("Nightly sweep") &&
        !items.includes("Done sweep") &&
        items.includes("Run once"),
      detail: items.replaceAll("\n", " | ").slice(0, 240),
    };
  });

  await attempt(9, "the board card runs one without opening the Ticket", async () => {
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
        !items.includes("Done sweep") &&
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
