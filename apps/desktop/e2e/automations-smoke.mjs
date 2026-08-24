/**
 * Automations V1 tracer smoke (VC-126) — the record and one Run by hand,
 * driven through the REAL packed app's preload bridge.
 *
 * What it proves, in dependency order:
 *   1. An Automation persists with a name (trimmed), Instructions, an
 *      Ownership, and an inherit Runtime — under a UUID id.
 *   2. Main's validating door refuses a blank draft and an unspellable pin,
 *      inline, without writing anything.
 *   3. A global Automation lists in a project's own list, after its own.
 *   4. Update rewrites the editable fields.
 *   5. A run request on a profile with NO default model refuses through the
 *      Session start's own error path (`MODEL_REQUIRED` + the shared
 *      sentence), and leaves NOTHING durable behind — no Run row, no Session.
 *   6. Delete is a record delete.
 *
 * The live half of a Run — a fresh Pi-backed chat Session actually answering
 * the Instructions — needs provider credentials and spends tokens, so this
 * smoke deliberately stops at the refusal arm; `run.test.ts` pins the happy
 * path against the Sessions facade, and the pi-* smokes own live turns.
 *
 * MANUALLY RUN (needs a display + the built app); CI does not run it:
 *
 *   pnpm -w run build
 *   node apps/desktop/e2e/automations-smoke.mjs
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

const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("volli-automations-");
const { attempt, must, summarize } = createRunner();

console.log("scratch:", scratch, "\n");

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
    const ticket = await window.api.tickets.create({
      projectId: project.id,
      title: "Probe ticket",
      status: "todo",
    });
    return ticket.ok
      ? { projectId: project.id, ticketId: ticket.ticket.id }
      : { fail: ticket.error };
  });
  await must(0, "a project and a ticket exist to run against", async () => ({
    ok: seeded.fail === undefined,
    detail: seeded.fail ?? `project=${seeded.projectId}`,
  }));

  const created = await page.evaluate(async (projectId) => {
    const result = await window.api.automations.create({
      projectId,
      name: "  Review sweep  ",
      instructions: "/review the change set, then read @docs/DESIGN.md",
      runtime: null,
    });
    return result.ok ? result.automation : { fail: result.error };
  }, seeded.projectId);
  await must(
    1,
    "an Automation persists: trimmed name, Ownership, inherit Runtime, UUID id",
    async () => ({
      ok:
        created.fail === undefined &&
        created.name === "Review sweep" &&
        created.projectId === seeded.projectId &&
        created.runtime === null &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(created.id),
      detail: created.fail ?? `id=${created.id}`,
    }),
  );

  await attempt(
    2,
    "main refuses a blank draft and an unspellable pin, storing neither",
    async () => {
      const refusals = await page.evaluate(async (projectId) => {
        const blank = await window.api.automations.create({
          projectId,
          name: "   ",
          instructions: "x",
          runtime: null,
        });
        const pin = await window.api.automations.create({
          projectId,
          name: "Pinned",
          instructions: "x",
          runtime: { providerId: "nope", modelId: "ghost", reasoningLevel: "high" },
        });
        const listed = await window.api.automations.list({ projectId });
        return {
          blank: blank.ok ? "ACCEPTED" : blank.error,
          pin: pin.ok ? "ACCEPTED" : pin.error,
          count: listed.ok ? listed.automations.length : -1,
        };
      }, seeded.projectId);
      return {
        ok:
          /Name/.test(refusals.blank) &&
          /not currently available/.test(refusals.pin) &&
          refusals.count === 1,
        detail: JSON.stringify(refusals),
      };
    },
  );

  await attempt(3, "a global Automation lists after the project's own", async () => {
    const names = await page.evaluate(async (projectId) => {
      const global = await window.api.automations.create({
        projectId: null,
        name: "A global one",
        instructions: "/tdd",
        runtime: null,
      });
      if (!global.ok) return [global.error];
      const listed = await window.api.automations.list({ projectId });
      return listed.ok ? listed.automations.map((a) => a.name) : [listed.error];
    }, seeded.projectId);
    return {
      ok: names.length === 2 && names[0] === "Review sweep" && names[1] === "A global one",
      detail: names.join(" | "),
    };
  });

  await attempt(4, "update rewrites the editable fields", async () => {
    const updated = await page.evaluate(async (automationId) => {
      const result = await window.api.automations.update({
        automationId,
        name: "Review sweep v2",
        instructions: "/review again",
        runtime: null,
      });
      return result.ok ? result.automation.name : result.error;
    }, created.id);
    return { ok: updated === "Review sweep v2", detail: String(updated) };
  });

  await attempt(
    5,
    "a run with no default model refuses through the existing path and leaves nothing durable",
    async () => {
      const outcome = await page.evaluate(
        async ({ automationId, ticketId }) => {
          const run = await window.api.automations.run({ automationId, ticketId });
          const runs = await window.api.automations.runsForTicket({ ticketId });
          const sessions = await window.api.sessions.listForTicket({ ticketId });
          return {
            refusal: run.ok ? { started: true } : { code: run.code, error: run.error },
            runRows: runs.ok ? runs.runs.length : -1,
            sessionRows: sessions.ok ? sessions.sessions.length : -1,
          };
        },
        { automationId: created.id, ticketId: seeded.ticketId },
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

  await attempt(6, "delete is a record delete", async () => {
    const after = await page.evaluate(
      async ({ automationId, projectId }) => {
        const deleted = await window.api.automations.delete({ automationId });
        const listed = await window.api.automations.list({ projectId });
        return {
          deleted: deleted.ok,
          names: listed.ok ? listed.automations.map((a) => a.name) : [listed.error],
        };
      },
      { automationId: created.id, projectId: seeded.projectId },
    );
    return {
      ok: after.deleted && after.names.length === 1 && after.names[0] === "A global one",
      detail: JSON.stringify(after),
    };
  });

  exitCode = summarize();
} finally {
  if (app !== null) await closeAppBounded(app);
  await cleanup();
}
process.exit(exitCode);
