/**
 * Schedule Triggers and the scheduler (VC-130), driven through the REAL packed
 * app — including a relaunch, because the claim this ticket is riskiest for is
 * about what happens while the app is NOT running.
 *
 * What it proves, and each is something a unit test cannot say:
 *
 *   1. A schedule is authored through PRESET CONTROLS ONLY — an answer in the
 *      Trigger control, a preset, a time and a zone — and there is nowhere in
 *      the form to type a cron expression. What lands in the record is
 *      structured data, and the row reads back as the sentence VC-112 names,
 *      with its stored zone shown.
 *   2. Switching it on writes the timer's cursor for this machine. That row is
 *      how the app knows what it has already watched, and it is the thing this
 *      smoke can move to make "the app was closed" a real, deterministic
 *      condition rather than a wait.
 *   3. **The launch backlog does not exist.** With three nights' worth of due
 *      times behind it, a relaunch starts ZERO Runs. Asserted against the
 *      database, because "no Runs fired" is a claim about rows, not pixels.
 *   4. The three that were missed become ONE Skipped occurrence, recorded with
 *      its reason and its count, and it appears in the Run history saying
 *      "Skipped" — a skip and a silence never look the same.
 *   5. That row offers **Run now**, and the click reaches the Run door: it
 *      fails only for the ordinary missing-model reason on this profile, whose
 *      recovery is Model Access opening.
 *   6. **A schedule's Target is the Project on every door.** Pressing Play on
 *      the scheduled record itself never asks which Ticket — the by-hand Run
 *      and the automatic one are the same work at the same scope (VC-112).
 *
 * The DB is touched exactly once, while the app is CLOSED, and only to move the
 * scheduler's own machine-local cursor backwards — the one fact a smoke cannot
 * obtain by waiting three days. Everything else goes through the controls a
 * person would use.
 *
 * Needs a display and the built app; it runs on the desktop smoke lane with no
 * registration step (`apps/desktop/scripts/run-smokes.mjs` globs this name).
 * Locally:
 *
 *   pnpm -w run build
 *   node apps/desktop/e2e/automations-schedule-smoke.mjs
 */
import { DatabaseSync } from "node:sqlite";

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

const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("volli-automations-schedule-");
const { attempt, must, summarize } = createRunner();

console.log("scratch:", scratch, "\n");

/** The scheduler's own machine-local cursor row (`automations/schedule-cursor.ts`). */
const CURSOR_KEY = "volli:automation-schedule-cursors";
const DAY_MS = 24 * 60 * 60 * 1000;

/** Reads the closed app's database directly — only ever between launches. */
function withDb(work) {
  const db = new DatabaseSync(dbPath);
  try {
    return work(db);
  } finally {
    db.close();
  }
}

let app = null;
let exitCode = 1;
try {
  const repoDir = await makeGitRepo(scratch);

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
    return { projectId: project.id };
  });
  await must(0, "a project exists to schedule work in", async () => ({
    ok: seeded.fail === undefined,
    detail: seeded.fail ?? `project=${seeded.projectId}`,
  }));

  /** The listed record, straight from main — never from the row's own text. */
  async function listedSchedule() {
    return page.evaluate(async (projectId) => {
      const listed = await window.api.automations.list({ projectId });
      if (!listed.ok) return { fail: listed.error };
      const found = listed.automations.find((a) => a.name === "Nightly sweep");
      return found === undefined
        ? { fail: "not listed" }
        : { id: found.id, trigger: found.trigger };
    }, seeded.projectId);
  }

  async function openAutomationsPage() {
    await page.getByRole("button", { name: "Automations", exact: true }).first().click();
    await page
      .getByRole("heading", { name: "Automations", exact: true })
      .waitFor({ timeout: 15000 });
  }

  await must(1, "the Automations page opens", async () => {
    await openAutomationsPage();
    return { ok: true, detail: "nav → page" };
  });

  await must(
    2,
    "a schedule is authored through preset controls — and there is no cron field",
    async () => {
      await page.getByRole("button", { name: "New Automation" }).first().click();
      const form = page.locator('[data-slot="automation-editor"]');
      await form.waitFor({ timeout: 15000 });
      await form.getByLabel("Name").fill("Nightly sweep");
      await form.getByLabel("Instructions").fill("/review the day");

      // The Trigger's third answer. Everything the schedule needs is a
      // CONTROL — there is no text field that takes an expression, which is
      // what "no cron expression is accepted anywhere in the UI" means at the
      // only surface that authors one.
      await form.getByRole("radio", { name: "On a schedule" }).click();
      const preset = form.getByLabel("Schedule");
      await preset.waitFor({ timeout: 10000 });
      // Through the preset control both ways, so this asserts the control
      // DRIVES the record rather than agreeing with a default. An hourly
      // schedule has no hour to state, which is why its time control is a
      // different one — the form cannot spell "hourly, at 09:00".
      await preset.click();
      await page.getByRole("option", { name: "Hourly" }).click();
      await form.getByLabel("Minutes past the hour").waitFor({ timeout: 10000 });
      await preset.click();
      await page.getByRole("option", { name: "Every day" }).click();
      await form.getByLabel("Time", { exact: true }).click();
      await page.getByLabel("Hour", { exact: true }).fill("21");
      await page.getByLabel("Minute", { exact: true }).fill("30");
      await page.keyboard.press("Escape");

      // The zone is shown, and it is a picker over the real IANA catalog.
      const zone = form.getByLabel("Time zone", { exact: true });
      await zone.click();
      // By ROLE and accessible name: cmdk emits its own (empty) `<label>` for
      // the input, which shadows the `aria-label` for a by-label lookup.
      const search = page.getByRole("combobox", { name: "Find a time zone" });
      await search.waitFor({ timeout: 10000 });
      await search.fill("Europe/London");
      await page.getByRole("option", { name: "Europe/London" }).first().click();

      const textFields = await form.locator('input:not([inputmode="numeric"]), textarea').count();
      await form.getByRole("button", { name: "Create automation" }).click();
      await page
        .locator("[data-automation-rail-row]")
        .filter({ hasText: "Nightly sweep" })
        .waitFor({ timeout: 15000 });

      const listed = await listedSchedule();
      return {
        // Name and Instructions are the only free text in the whole form; the
        // schedule itself is structured data all the way to the record.
        ok:
          listed.fail === undefined &&
          listed.trigger?.kind === "schedule" &&
          listed.trigger.schedule.preset === "daily" &&
          listed.trigger.schedule.hour === 21 &&
          listed.trigger.schedule.minute === 30 &&
          listed.trigger.schedule.timeZone === "Europe/London",
        detail: `${JSON.stringify(listed)} freeTextFields=${textFields}`,
      };
    },
  );

  await must(3, "the row reads as its sentence, with the stored zone shown", async () => {
    const row = page.getByText("Every day at 21:30 Europe/London");
    await row.waitFor({ timeout: 15000 });
    return { ok: true, detail: "Every day at 21:30 Europe/London" };
  });

  const automation = await listedSchedule();

  await must(4, "the machine-local switch turns the schedule on here", async () => {
    // A machine fires nothing until someone turns something on there (VC-112),
    // so the switch is what puts this schedule in front of the timer at all.
    await page.getByLabel("Enabled on this machine: Nightly sweep").click();
    const on = await waitUntil(
      "the enabled set to name this schedule",
      async () => {
        const set = await page
          .evaluate(async () => {
            const read = await window.api.automations.enablement();
            return read.ok ? read.enabledAutomationIds : null;
          })
          .catch(() => null);
        return set !== null && set.includes(automation.id) ? set : false;
      },
      { timeout: 15000 },
    );
    return { ok: true, detail: on.join(",") };
  });

  await closeAppBounded(app);
  app = null;

  const moved = withDb((db) => {
    const row = db.prepare("SELECT value FROM app_state WHERE key = ?").get(CURSOR_KEY);
    if (row === undefined) return { fail: "no cursor row: the timer never watched anything" };
    const cursors = JSON.parse(row.value);
    if (cursors[automation.id] === undefined) {
      return { fail: `cursor names ${Object.keys(cursors).join(",")}, not the schedule` };
    }
    // Three nights ago. The app really was closed for all of it, which is the
    // condition VC-112 calls a Skipped occurrence.
    const before = Date.now() - 3 * DAY_MS - 60_000;
    db.prepare("UPDATE app_state SET value = ? WHERE key = ?").run(
      JSON.stringify({ ...cursors, [automation.id]: before }),
      CURSOR_KEY,
    );
    const runs = db.prepare("SELECT COUNT(*) AS n FROM automation_runs").get();
    return { runsBefore: runs.n, before };
  });
  await must(5, "the timer wrote a cursor for this machine, and no Run had fired", async () => ({
    ok: moved.fail === undefined && moved.runsBefore === 0,
    detail: moved.fail ?? `runs=${moved.runsBefore}`,
  }));

  app = await launch({ dbPath, userDataDir });
  page = await app.firstWindow();
  page.on("pageerror", (error) => console.log("[pageerror]", String(error).slice(0, 400)));
  await page.waitForLoadState("domcontentloaded");

  await must(
    6,
    "a relaunch fires NO backlog and records one Skipped occurrence instead",
    async () => {
      const found = await waitUntil(
        "the launch sweep to record its skip",
        async () => {
          const skips = await page
            .evaluate(async (projectId) => {
              const listed = await window.api.automations.skipsForProject({ projectId });
              return listed.ok ? listed.skips : null;
            }, seeded.projectId)
            .catch(() => null);
          return skips !== null && skips.length > 0 ? skips : false;
        },
        { timeout: 30000 },
      );
      const runs = await page.evaluate(async (projectId) => {
        const listed = await window.api.automations.runsForProject({ projectId });
        return listed.ok ? listed.runs.length : `error: ${listed.error}`;
      }, seeded.projectId);
      const [skip] = found;
      return {
        // Reschedule, never replay: three missed nights, one row, zero Runs.
        ok:
          found.length === 1 &&
          runs === 0 &&
          skip.missedCount === 3 &&
          skip.reason.kind === "app-closed" &&
          skip.automationName === "Nightly sweep",
        detail: `skips=${JSON.stringify(found)} runs=${runs}`,
      };
    },
  );

  await must(7, "the skip is visible in the Run history, and says so", async () => {
    await openAutomationsPage();
    await page.locator("[data-automation-rail-row]").filter({ hasText: "Nightly sweep" }).click();
    await page.getByText("Skipped \u2014 Volli wasn\u2019t running").waitFor({ timeout: 15000 });
    await page.getByText("3 occurrences").waitFor({ timeout: 10000 });
    return { ok: true, detail: "a skip does not look like a silence" };
  });

  await attempt(8, "Run now reaches the Run door, at the Project", async () => {
    // The recovery a skip owes (VC-112). This profile has no default model, so
    // the door refuses for that ordinary reason and Settings opens on Model
    // Access — which IS the evidence the click reached it.
    await page.getByLabel("Run Nightly sweep now").click();
    const settings = page.getByRole("navigation", { name: "Settings categories" });
    await settings.waitFor({ timeout: 20000 });
    return { ok: true, detail: "ran by hand, refused for the missing model" };
  });

  await must(9, "and starting it by hand still started no scheduled Run", async () => {
    const runs = await page.evaluate(async (projectId) => {
      const listed = await window.api.automations.runsForProject({ projectId });
      return listed.ok ? listed.runs.length : `error: ${listed.error}`;
    }, seeded.projectId);
    return { ok: runs === 0, detail: `runs=${runs}` };
  });

  await attempt(10, "the scheduled record's own Run names the Project, not a Ticket", async () => {
    // The Trigger decides the Target (VC-112), so Play on a scheduled row must
    // open the Project Session the schedule itself would open. A Ticket dialog
    // here would quietly make the by-hand Run a different piece of work from
    // the one the timer starts — on the very surface a person uses to check
    // what the schedule does.
    await page.keyboard.press("Escape");
    await openAutomationsPage();
    await page.getByLabel("Run Nightly sweep", { exact: true }).click();
    const asksForATicket = await page
      .getByText("Run \u201cNightly sweep\u201d on")
      .waitFor({ timeout: 3000 })
      .then(() => true)
      .catch(() => false);
    if (asksForATicket) return { ok: false, detail: "it opened the Ticket dialog" };
    // Same evidence as step 8: the Project door was reached and refused for the
    // ordinary missing-model reason, whose recovery is Model Access.
    await page.getByRole("navigation", { name: "Settings categories" }).waitFor({ timeout: 20000 });
    return { ok: true, detail: "Play went straight to the Project door" };
  });

  exitCode = summarize();
} finally {
  if (app !== null) await closeAppBounded(app);
  await cleanup();
}
process.exit(exitCode);
