import { afterEach, describe, expect, it } from "vite-plus/test";
import type { ModelSelection } from "@volli/shared";

import {
  createAutomation,
  deleteAutomation,
  getAutomation,
  latestRunForTicket,
  listAutomationsForProject,
  listRunsForTicket,
  recordAutomationRun,
  updateAutomation,
} from "./automations-repo";
import { insertProject } from "./projects-repo";
import { insertSession } from "../session-control/test-support";
import { openTestDb, testProject, testSession, testTicket } from "./test-helpers";
import type { TestDb } from "./test-helpers";
import { insertTicket } from "./tickets-repo";

let ctx: TestDb;

afterEach(() => {
  ctx.cleanup();
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const PIN: ModelSelection = {
  providerId: "anthropic",
  modelId: "claude-opus",
  reasoningLevel: "high",
};

/** A migrated db with one project/ticket/session, plus their ids. */
function seeded() {
  ctx = openTestDb();
  const project = testProject();
  insertProject(ctx.db, project);
  const ticket = testTicket(project.id);
  insertTicket(ctx.db, ticket);
  const session = testSession(project.id, ticket.id);
  insertSession(ctx.db, session);
  return { project, ticket, session };
}

describe("automations repo", () => {
  it("creates with a UUID id — never a counter, never machine-derived (BOUNDARIES rule 1)", () => {
    const { project } = seeded();
    const automation = createAutomation(
      ctx.db,
      { projectId: project.id, name: "Review", instructions: "/review go", runtime: null },
      1000,
    );
    expect(automation.id).toMatch(UUID_PATTERN);
    expect(automation.projectId).toBe(project.id);
    expect(automation.runtime).toBeNull();
    expect(getAutomation(ctx.db, automation.id)).toEqual(automation);
  });

  it("round-trips a pinned Runtime as one selection, and keeps a corrupted pin distinct from inherit", () => {
    const { project } = seeded();
    const automation = createAutomation(
      ctx.db,
      { projectId: project.id, name: "Pinned", instructions: "x", runtime: PIN },
      1000,
    );
    expect(getAutomation(ctx.db, automation.id)?.runtime).toEqual(PIN);

    // A hand-edited pin that is valid JSON but not a selection is not silently
    // coerced to inherit: the caller can fail it closed and preserve its bytes.
    ctx.db
      .prepare("UPDATE automations SET runtime = ? WHERE id = ?")
      .run('{"providerId":"anthropic"}', automation.id);
    expect(getAutomation(ctx.db, automation.id)?.runtime).toEqual({
      kind: "invalid",
      raw: { providerId: "anthropic" },
    });
  });

  it("lists a project's own Automations before the global shelf, name-ordered", () => {
    const { project } = seeded();
    createAutomation(
      ctx.db,
      { projectId: null, name: "A global", instructions: "x", runtime: null },
      1,
    );
    createAutomation(
      ctx.db,
      { projectId: project.id, name: "Zed", instructions: "x", runtime: null },
      2,
    );
    createAutomation(
      ctx.db,
      { projectId: project.id, name: "Alpha", instructions: "x", runtime: null },
      3,
    );
    const other = testProject();
    insertProject(ctx.db, other);
    createAutomation(
      ctx.db,
      { projectId: other.id, name: "Elsewhere", instructions: "x", runtime: null },
      4,
    );

    expect(listAutomationsForProject(ctx.db, project.id).map((a) => a.name)).toEqual([
      "Alpha",
      "Zed",
      "A global",
    ]);
  });

  it("updates the editable fields whole and bumps updatedAt; unknown id updates nothing", () => {
    const { project } = seeded();
    const automation = createAutomation(
      ctx.db,
      { projectId: project.id, name: "Before", instructions: "x", runtime: null },
      1000,
    );
    const updated = updateAutomation(
      ctx.db,
      automation.id,
      { name: "After", instructions: "y", runtime: PIN },
      2000,
    );
    expect(updated).toMatchObject({
      name: "After",
      instructions: "y",
      runtime: PIN,
      updatedAt: 2000,
    });
    expect(
      updateAutomation(ctx.db, "missing", { name: "n", instructions: "i", runtime: null }, 1),
    ).toBeUndefined();
  });

  it("deletes the record while its Runs keep Automation id and name provenance", () => {
    const { project, ticket, session } = seeded();
    const automation = createAutomation(
      ctx.db,
      { projectId: project.id, name: "Doomed", instructions: "x", runtime: null },
      1000,
    );
    const run = recordAutomationRun(
      ctx.db,
      { automationId: automation.id, ticketId: ticket.id, sessionId: session.id, model: PIN },
      2000,
    );

    expect(deleteAutomation(ctx.db, automation.id)).toBe(true);
    expect(deleteAutomation(ctx.db, automation.id)).toBe(false);
    expect(listRunsForTicket(ctx.db, ticket.id)).toEqual([run]);
  });
});

describe("automation runs repo", () => {
  it("records a UUID-id Run holding the resolved model, and reads it back newest first", () => {
    const { project, ticket, session } = seeded();
    const automation = createAutomation(
      ctx.db,
      { projectId: project.id, name: "Review", instructions: "x", runtime: null },
      500,
    );
    const first = recordAutomationRun(
      ctx.db,
      { automationId: automation.id, ticketId: ticket.id, sessionId: session.id, model: PIN },
      1000,
    );
    const second = recordAutomationRun(
      ctx.db,
      {
        automationId: null,
        ticketId: ticket.id,
        sessionId: session.id,
        model: { providerId: "openai", modelId: "gpt-5", reasoningLevel: "medium" },
      },
      2000,
    );

    expect(first.id).toMatch(UUID_PATTERN);
    expect(listRunsForTicket(ctx.db, ticket.id)).toEqual([second, first]);
    expect(latestRunForTicket(ctx.db, ticket.id)).toEqual(second);
  });

  it("answers undefined for a Ticket with no Runs", () => {
    const { ticket } = seeded();
    expect(latestRunForTicket(ctx.db, ticket.id)).toBeUndefined();
    expect(listRunsForTicket(ctx.db, ticket.id)).toEqual([]);
  });

  it("preserves an out-of-vocabulary historical reasoning level exactly", () => {
    const { ticket, session } = seeded();
    const run = recordAutomationRun(
      ctx.db,
      { automationId: null, ticketId: ticket.id, sessionId: session.id, model: PIN },
      1000,
    );
    ctx.db
      .prepare("UPDATE automation_runs SET reasoning_level = 'galactic' WHERE id = ?")
      .run(run.id);
    expect(latestRunForTicket(ctx.db, ticket.id)?.model.reasoningLevel).toBe("galactic");
  });
});
