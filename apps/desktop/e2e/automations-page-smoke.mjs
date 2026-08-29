/**
 * The Automations page (VC-127), driven through the REAL packed app.
 *
 * The tracer smoke beside this one (`automations-smoke.mjs`) owns the record's
 * CRUD and the Run door. What this one proves is what the PAGE promises, and
 * every claim below is one a unit test cannot make:
 *
 *   1. A fourth nav row exists beside Home and Configure, and clicking it
 *      lands on a page — not on a room inside Home.
 *   2. The page lists both project-owned and global Automations.
 *   3. The row's switch disables an Automation, writes NOTHING into the
 *      project's git repo, and does not lock it: a disabled Automation is
 *      still runnable by hand, because the Trigger says only what ELSE starts
 *      one. "Never travels with the project" is a claim about the repository,
 *      so the repository is what gets checked, on both sides of the click.
 *   4. Duplicate is one explicit click that yields a second, distinguishable
 *      record carrying the same work, and lands on the copy's own form.
 *   5. A row opens the ONE authoring form, and an edit through it sticks.
 *   6. Delete asks once and removes the record — there is no archive.
 *   7. The Run-history door is project-scoped and guards its id.
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
} from "./lib/smoke-kit.mjs";

const run = promisify(execFile);
const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("volli-automations-page-");
const { attempt, must, summarize } = createRunner();

console.log("scratch:", scratch, "\n");

/** Everything git can see in the repo: tracked changes plus untracked files. */
async function repoFootprint(repoDir) {
  const { stdout } = await run("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: repoDir,
  });
  return stdout.trim();
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
    const own = await window.api.automations.create({
      commandId: crypto.randomUUID(),
      projectId: project.id,
      name: "Review sweep",
      instructions: "/review the change set",
      runtime: null,
    });
    const global = await window.api.automations.create({
      commandId: crypto.randomUUID(),
      projectId: null,
      name: "Nightly sweep",
      instructions: "/tdd",
      runtime: null,
    });
    if (!own.ok || !global.ok) return { fail: "seed automations refused" };
    return {
      projectId: project.id,
      ticketId: ticket.ticket.id,
      ownId: own.automation.id,
      globalId: global.automation.id,
    };
  });
  await must(0, "a project, a ticket and two Automations exist", async () => ({
    ok: seeded.fail === undefined,
    detail: seeded.fail ?? `own=${seeded.ownId} global=${seeded.globalId}`,
  }));

  await must(1, "a fourth nav row opens the Automations page", async () => {
    const nav = page.getByRole("button", { name: "Automations", exact: true }).first();
    await nav.click();
    // The page's own heading, not the nav row's label: this asserts we ARRIVED.
    await page.getByRole("heading", { name: "Automations" }).waitFor({ timeout: 15000 });
    return { ok: true, detail: "nav → page" };
  });

  await attempt(2, "the page lists project-owned and global Automations", async () => {
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
    3,
    "a new Automation defaults to the manual Trigger and an inherited Runtime",
    async () => {
      const body = await page.locator("body").innerText();
      const ok = body.includes("Only when I run it") && body.includes("Default model");
      return { ok, detail: ok ? "manual Trigger + inherited Runtime" : body.slice(0, 400) };
    },
  );

  await attempt(
    4,
    "the row's switch disables it, and writes nothing into the git repo",
    async () => {
      // Through the CONTROL, not the door: "local to this machine" is a promise
      // about what a person's click does, and the repo is checked on both sides
      // of it because "never travels with the project" is a claim about the
      // repository rather than about the database.
      await page.getByLabel("Enabled on this machine: Review sweep").click();
      await page.getByText("Won\u2019t start on its own").waitFor({ timeout: 10000 });
      const stored = await page.evaluate(async () => window.api.automations.enablement());
      const footprint = await repoFootprint(repoDir);
      return {
        ok:
          stored.ok &&
          stored.disabledAutomationIds.includes(seeded.ownId) &&
          footprint === cleanRepo,
        detail: `${JSON.stringify(stored.disabledAutomationIds)} repo=${JSON.stringify(footprint)} was=${JSON.stringify(cleanRepo)}`,
      };
    },
  );

  await attempt(
    5,
    "a disabled Automation stays runnable by hand \u2014 the switch is not a lock",
    async () => {
      // VC-112: run by hand is universal, and the Trigger says only what ELSE
      // starts an Automation. So a disabled record must still reach the Run
      // door and fail there for the ordinary reason (no default model on this
      // profile), never be refused for being off.
      const outcome = await page.evaluate(
        async ({ ownId, ticketId }) =>
          window.api.automations.run({
            commandId: crypto.randomUUID(),
            automationId: ownId,
            ticketId,
          }),
        seeded,
      );
      return {
        ok: !outcome.ok && outcome.code === "MODEL_REQUIRED",
        detail: JSON.stringify(outcome).slice(0, 200),
      };
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
      const names = await page.evaluate(async (projectId) => {
        const listed = await window.api.automations.list({ projectId });
        return listed.ok ? listed.automations.map((a) => a.name) : [listed.error];
      }, seeded.projectId);
      return {
        ok:
          named === "Review sweep (copy)" &&
          instructions === "/review the change set" &&
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
    await page.getByText("Review sweep v2").waitFor({ timeout: 10000 });
    const names = await page.evaluate(async (projectId) => {
      const listed = await window.api.automations.list({ projectId });
      return listed.ok ? listed.automations.map((a) => a.name) : [listed.error];
    }, seeded.projectId);
    return { ok: names.includes("Review sweep v2"), detail: names.join(" | ") };
  });

  await attempt(8, "the Run-history door answers for this project and guards the id", async () => {
    // A Run needs a live model and spends tokens, so this probe stops at the
    // door \u2014 the same line `automations-smoke.mjs` draws. What the door OWES
    // (project scoping through the Ticket, newest-first order, the resolved
    // model) is pinned in `automations-repo.test.ts` and the page test.
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
      const names = await page.evaluate(async (projectId) => {
        const listed = await window.api.automations.list({ projectId });
        return listed.ok ? listed.automations.map((a) => a.name) : [listed.error];
      }, seeded.projectId);
      return {
        ok: !names.includes("Review sweep v2") && names.includes("Nightly sweep"),
        detail: names.join(" | "),
      };
    },
  );

  exitCode = summarize();
} finally {
  if (app !== null) await closeAppBounded(app);
  await cleanup();
}
process.exit(exitCode);
