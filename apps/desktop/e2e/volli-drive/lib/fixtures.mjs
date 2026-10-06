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
import { makeGitRepo, seedDefaultModel, seedProjects } from "../../lib/smoke-kit.mjs";

export const FIXTURES = ["basic", "empty"];

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

  const path = await makeGitRepo(layout.projectsDir, "drive-project-");
  await seedProjects(page, [{ ...DRIVE_PROJECT, path }]);
  seeded.project = { ...DRIVE_PROJECT, path };
  for (const ticket of BASIC_TICKETS) {
    const created = await createTicketViaBridge(page, DRIVE_PROJECT.name, ticket);
    seeded.tickets.push({ ...created, title: ticket.title, status: ticket.status });
  }
  // The bridge writes are live, but a reload makes the board read them the way
  // a person's next launch would, with no optimistic state left over.
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  return seeded;
}
