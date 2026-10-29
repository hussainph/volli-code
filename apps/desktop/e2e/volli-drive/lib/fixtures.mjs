/**
 * Fixtures a volli-drive instance boots into.
 *
 * Seeding goes through the same doors the smokes use (smoke-kit's
 * localStorage-envelope project import, agent-kit's preload ticket create,
 * the Settings model-default mutation) because the native folder picker is
 * not drivable. It is SETUP, done before the agent gets the instance: every
 * behaviour under test is then driven through the UI.
 */
import { createTicketViaBridge } from "../../lib/agent-kit.mjs";
import { seedDefaultModel, seedProjects } from "../../lib/smoke-kit.mjs";
import { makeScratchRepo } from "./core.mjs";

export const FIXTURES = ["basic", "empty", "move"];
export const MOVE_PROJECT = Object.freeze({
  id: "b7f783e2-6c9c-4a6d-8ea2-137defb38c19",
  name: "Move Project",
  prefix: "MOV",
});

export const DRIVE_PROJECT = Object.freeze({
  id: "drive-project",
  name: "Drive Project",
  prefix: "DRV",
});

/** DRV-1..DRV-4, in creation order. */
export const BASIC_TICKETS = Object.freeze([
  { title: "Fix the login button alignment", status: "todo", priority: "medium" },
  { title: "Write the onboarding guide", status: "backlog", priority: "low" },
  { title: "Speed up the board query", status: "doing", priority: "high" },
  { title: "Review the settings copy", status: "needs_review", priority: "low" },
]);

/**
 * @param {import("playwright-core").Page} page
 * @param {string} name
 * @param {{projectsDir:string}} layout
 * @param {{providerId:string, modelId:string, reasoningLevel?:string}|null} modelPin
 */
export async function seedFixture(page, name, layout, modelPin) {
  if (!FIXTURES.includes(name)) throw new Error(`unknown fixture ${name} (${FIXTURES.join(", ")})`);
  const seeded = { fixture: name, project: null, tickets: [], model: null };
  if (modelPin) {
    // Every structured Session needs an app-wide default model before it can
    // start; seeded for each purpose so a Ticket Session and a project chat
    // both resolve to the pinned (fake or env) model.
    for (const purpose of ["global", "ticket"]) {
      seeded.model = await seedDefaultModel(page, modelPin, purpose);
    }
  }
  if (name === "empty") return seeded;

  // Scratch-created, never a clone: its only remote is a local bare repo in
  // scratch, so nothing an agent does with it can reach a credential.
  const project = name === "move" ? MOVE_PROJECT : DRIVE_PROJECT;
  const { dir: path, origin } = await makeScratchRepo(layout.projectsDir, "drive-project");
  await seedProjects(page, [{ ...project, path }]);
  seeded.project = { ...project, path, origin };
  for (const ticket of BASIC_TICKETS) {
    const created = await createTicketViaBridge(page, project.name, ticket);
    seeded.tickets.push({ ...created, title: ticket.title, status: ticket.status });
  }
  if (name === "move") {
    // SETUP only: an actual stored attachment and ticket text, before the user moves anything.
    seeded.attachment = await page.evaluate(async (ticketId) => {
      const bytes = Uint8Array.from(
        atob(
          // A visible 128 × 64 checkerboard for screenshot and accessibility evidence.
          "iVBORw0KGgoAAAANSUhEUgAAAIAAAABACAIAAABdtOgoAAAAu0lEQVR4nO3RsQmAQBBFwSvJ3HpsxGItwdgOBKM7eQM/fuwy4zq2T9vP+9P03zf+/sDf+wAAtPsAALT7AAC0+wAAtPsAALT7AAC0+wAAtPtjtYNqfQAA2n0AANp9AADafQAA2n0AANp9AADafQAA2n0AswFWO6jWBwCg3QcAoN0HAKDdBwCg3QcAoN0HAKDdBwCg3QcwG2C1g2p9AADafQAA2n0AANp9AADafQAA2n0AANp9AADafQCT+w+OBeLvcsfjZAAAAABJRU5ErkJggg==",
        ),
        (char) => char.charCodeAt(0),
      );
      const attached = await window.api.attachments.attach({
        fileName: "move-proof.png",
        bytes,
        mime: "image/png",
        owner: { ticketId },
      });
      if (!attached.ok || attached.blob === null) throw new Error("Move fixture attachment failed");
      const updated = await window.api.tickets.update({
        ticketId,
        body: "Move proof — café 🌍\n\n![Moved attachment](.volli/attachments/move-proof.png)",
      });
      if (!updated.ok) throw new Error(updated.error);
      return attached.blob;
    }, seeded.tickets[0].ticketId);
    // SETUP only: a historical Done arrival before its column is armed, plus
    // saved definitions and a future schedule. Machine enablement stays off.
    seeded.automations = await page.evaluate(
      async ({ projectId, ticketId }) => {
        const arrived = await window.api.tickets.move({
          projectId,
          ticketId,
          toStatus: "done",
          toIndex: 0,
        });
        if (!arrived.ok) throw new Error(arrived.error);
        if (arrived.tickets.find((ticket) => ticket.id === ticketId)?.status !== "done")
          throw new Error("Move fixture historical arrival did not reach Done");
        const ahead = new Date(Date.now() + 12 * 60 * 60_000);
        const definitions = [
          { projectId, name: "Move column proof", trigger: { kind: "columns", columns: ["done"] } },
          {
            projectId,
            name: "Move schedule proof",
            trigger: {
              kind: "schedule",
              schedule: {
                preset: "daily",
                hour: ahead.getUTCHours(),
                minute: ahead.getUTCMinutes(),
                timeZone: "UTC",
              },
            },
          },
          { projectId: null, name: "Move personal proof", trigger: { kind: "none" } },
        ];
        const saved = [];
        for (const input of definitions) {
          const result = await window.api.automations.create({
            commandId: crypto.randomUUID(),
            runtime: null,
            instructions: "Report one finding.",
            ...input,
          });
          if (!result.ok) throw new Error(result.error);
          saved.push(result.automation);
        }
        const [column, schedule, personal] = saved;
        const armed = await window.api.automations.arm({
          commandId: crypto.randomUUID(),
          projectId,
          status: "done",
          automationId: column.id,
        });
        if (!armed.ok) throw new Error(armed.error);
        return { columnId: column.id, scheduleId: schedule.id, personalId: personal.id };
      },
      { projectId: project.id, ticketId: seeded.tickets[3].ticketId },
    );
    seeded.tickets[3].status = "done";
  }
  // The bridge writes are live, but a reload makes the board read them the way
  // a person's next launch would, with no optimistic state left over.
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  return seeded;
}
