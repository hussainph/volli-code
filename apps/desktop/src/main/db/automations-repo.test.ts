import { afterEach, describe, expect, it } from "vite-plus/test";
import { NO_AUTOMATION_TRIGGER, offeredAutomationsForColumn } from "@volli/shared";
import type { ModelSelection } from "@volli/shared";

import {
  clearColumnArming,
  createAutomation,
  deleteAutomation,
  getAutomation,
  latestRunForTicket,
  listAutomationsForProject,
  listColumnArmings,
  listColumnOrders,
  listRunsForProject,
  listRunsForTicket,
  recordAutomationRun,
  setColumnArming,
  setColumnOrder,
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
      {
        projectId: project.id,
        name: "Review",
        instructions: "/review go",
        trigger: NO_AUTOMATION_TRIGGER,
        runtime: null,
      },
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
      {
        projectId: project.id,
        name: "Pinned",
        instructions: "x",
        trigger: NO_AUTOMATION_TRIGGER,
        runtime: PIN,
      },
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
      {
        projectId: null,
        name: "A global",
        instructions: "x",
        trigger: NO_AUTOMATION_TRIGGER,
        runtime: null,
      },
      1,
    );
    createAutomation(
      ctx.db,
      {
        projectId: project.id,
        name: "Zed",
        instructions: "x",
        trigger: NO_AUTOMATION_TRIGGER,
        runtime: null,
      },
      2,
    );
    createAutomation(
      ctx.db,
      {
        projectId: project.id,
        name: "Alpha",
        instructions: "x",
        trigger: NO_AUTOMATION_TRIGGER,
        runtime: null,
      },
      3,
    );
    const other = testProject();
    insertProject(ctx.db, other);
    createAutomation(
      ctx.db,
      {
        projectId: other.id,
        name: "Elsewhere",
        instructions: "x",
        trigger: NO_AUTOMATION_TRIGGER,
        runtime: null,
      },
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
      {
        projectId: project.id,
        name: "Before",
        instructions: "x",
        trigger: NO_AUTOMATION_TRIGGER,
        runtime: null,
      },
      1000,
    );
    const updated = updateAutomation(
      ctx.db,
      automation.id,
      { name: "After", instructions: "y", trigger: NO_AUTOMATION_TRIGGER, runtime: PIN },
      2000,
    );
    expect(updated).toMatchObject({
      name: "After",
      instructions: "y",
      trigger: NO_AUTOMATION_TRIGGER,
      runtime: PIN,
      updatedAt: 2000,
    });
    expect(
      updateAutomation(
        ctx.db,
        "missing",
        { name: "n", instructions: "i", trigger: NO_AUTOMATION_TRIGGER, runtime: null },
        1,
      ),
    ).toBeUndefined();
  });

  it("deletes the record while its Runs keep Automation id and name provenance", () => {
    const { project, ticket, session } = seeded();
    const automation = createAutomation(
      ctx.db,
      {
        projectId: project.id,
        name: "Doomed",
        instructions: "x",
        trigger: NO_AUTOMATION_TRIGGER,
        runtime: null,
      },
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
      {
        projectId: project.id,
        name: "Review",
        instructions: "x",
        trigger: NO_AUTOMATION_TRIGGER,
        runtime: null,
      },
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

  it("scopes a project's Run history through the Run's own Session, newest first", () => {
    const { project, ticket, session } = seeded();
    const other = testProject();
    insertProject(ctx.db, other);
    const otherTicket = testTicket(other.id);
    insertTicket(ctx.db, otherTicket);
    const otherSession = testSession(other.id, otherTicket.id);
    insertSession(ctx.db, otherSession);
    // Global Ownership: listable in both projects, but its Run happened in one.
    const global = createAutomation(
      ctx.db,
      {
        projectId: null,
        name: "Sweep",
        instructions: "x",
        trigger: NO_AUTOMATION_TRIGGER,
        runtime: null,
      },
      500,
    );

    const older = recordAutomationRun(
      ctx.db,
      { automationId: global.id, ticketId: ticket.id, sessionId: session.id, model: PIN },
      1000,
    );
    const newer = recordAutomationRun(
      ctx.db,
      { automationId: global.id, ticketId: ticket.id, sessionId: session.id, model: PIN },
      2000,
    );
    const elsewhere = recordAutomationRun(
      ctx.db,
      {
        automationId: global.id,
        ticketId: otherTicket.id,
        sessionId: otherSession.id,
        model: PIN,
      },
      3000,
    );

    expect(listRunsForProject(ctx.db, project.id)).toEqual([newer, older]);
    expect(listRunsForProject(ctx.db, other.id)).toEqual([elsewhere]);
  });

  it("keeps a Run whose Ticket was deleted — the Session is what files it", () => {
    const { project, ticket, session } = seeded();
    const recorded = recordAutomationRun(
      ctx.db,
      { automationId: null, ticketId: ticket.id, sessionId: session.id, model: PIN },
      1000,
    );
    expect(listRunsForProject(ctx.db, project.id)).toEqual([recorded]);

    // `automation_runs.ticket_id` orphans on delete, exactly as
    // `sessions.ticket_id` does. The Run, its resolved model and its Session
    // door all survive that, so the history row does too — it simply stops
    // naming a Ticket.
    ctx.db.prepare("DELETE FROM tickets WHERE id = ?").run(ticket.id);
    expect(listRunsForProject(ctx.db, project.id)).toEqual([{ ...recorded, ticketId: null }]);
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

describe("column Trigger and arming (migration 031)", () => {
  it("round-trips a column Trigger, and stores 'Nothing else' as SQL NULL", () => {
    const { project } = seeded();
    const triggered = createAutomation(
      ctx.db,
      {
        projectId: project.id,
        name: "Sweep",
        instructions: "/review",
        trigger: { kind: "columns", columns: ["doing", "done"] },
        runtime: null,
      },
      1000,
    );
    expect(getAutomation(ctx.db, triggered.id)?.trigger).toEqual({
      kind: "columns",
      columns: ["doing", "done"],
    });

    const untriggered = createAutomation(
      ctx.db,
      {
        projectId: project.id,
        name: "By hand",
        instructions: "x",
        trigger: NO_AUTOMATION_TRIGGER,
        runtime: null,
      },
      1000,
    );
    expect(
      ctx.db.prepare("SELECT trigger_spec FROM automations WHERE id = ?").get(untriggered.id),
    ).toEqual({ trigger_spec: null });
    expect(getAutomation(ctx.db, untriggered.id)?.trigger).toEqual(NO_AUTOMATION_TRIGGER);
  });

  it("reads an unreadable stored Trigger as firing nothing, never as a guess", () => {
    const { project } = seeded();
    const automation = createAutomation(
      ctx.db,
      {
        projectId: project.id,
        name: "Sweep",
        instructions: "/review",
        trigger: { kind: "columns", columns: ["doing"] },
        runtime: null,
      },
      1000,
    );
    // A hand-edited row from a future build. Unlike a corrupted Runtime — which
    // must stay explicitly invalid, because inherit would still RUN — a Trigger
    // nobody can read may only ever cost a Run that starts on its own.
    ctx.db
      .prepare("UPDATE automations SET trigger_spec = ? WHERE id = ?")
      .run('{"kind":"phase-of-the-moon"}', automation.id);
    expect(getAutomation(ctx.db, automation.id)?.trigger).toEqual(NO_AUTOMATION_TRIGGER);
  });

  it("rewrites the Trigger on update like every other editable field", () => {
    const { project } = seeded();
    const automation = createAutomation(
      ctx.db,
      {
        projectId: project.id,
        name: "Sweep",
        instructions: "/review",
        trigger: { kind: "columns", columns: ["doing"] },
        runtime: null,
      },
      1000,
    );
    updateAutomation(
      ctx.db,
      automation.id,
      {
        name: "Sweep",
        instructions: "/review",
        trigger: { kind: "columns", columns: ["needs_review"] },
        runtime: null,
      },
      2000,
    );
    expect(getAutomation(ctx.db, automation.id)?.trigger).toEqual({
      kind: "columns",
      columns: ["needs_review"],
    });
  });

  it("holds a column to at most one arming, whatever order the writes arrive in", () => {
    const { project } = seeded();
    const first = createAutomation(
      ctx.db,
      {
        projectId: project.id,
        name: "A",
        instructions: "x",
        trigger: NO_AUTOMATION_TRIGGER,
        runtime: null,
      },
      1000,
    );
    const second = createAutomation(
      ctx.db,
      {
        projectId: project.id,
        name: "B",
        instructions: "x",
        trigger: NO_AUTOMATION_TRIGGER,
        runtime: null,
      },
      1000,
    );

    setColumnArming(
      ctx.db,
      { projectId: project.id, status: "doing", automationId: first.id },
      1000,
    );
    setColumnArming(
      ctx.db,
      { projectId: project.id, status: "doing", automationId: second.id },
      2000,
    );

    expect(listColumnArmings(ctx.db, project.id)).toEqual([
      { projectId: project.id, status: "doing", automationId: second.id, armedAt: 2000 },
    ]);
  });

  it("arms columns independently, and disarms one without touching the other", () => {
    const { project } = seeded();
    const automation = createAutomation(
      ctx.db,
      {
        projectId: project.id,
        name: "A",
        instructions: "x",
        trigger: NO_AUTOMATION_TRIGGER,
        runtime: null,
      },
      1000,
    );
    setColumnArming(
      ctx.db,
      { projectId: project.id, status: "doing", automationId: automation.id },
      1000,
    );
    setColumnArming(
      ctx.db,
      { projectId: project.id, status: "done", automationId: automation.id },
      1000,
    );

    clearColumnArming(ctx.db, { projectId: project.id, status: "doing" });
    // Disarming an unarmed column is silent: the end state is the point.
    clearColumnArming(ctx.db, { projectId: project.id, status: "backlog" });

    expect(listColumnArmings(ctx.db, project.id)).toEqual([
      { projectId: project.id, status: "done", automationId: automation.id, armedAt: 1000 },
    ]);
  });

  it("drops an arming with the Automation it names, leaving nothing pointing at a corpse", () => {
    const { project } = seeded();
    const automation = createAutomation(
      ctx.db,
      {
        projectId: project.id,
        name: "A",
        instructions: "x",
        trigger: NO_AUTOMATION_TRIGGER,
        runtime: null,
      },
      1000,
    );
    setColumnArming(
      ctx.db,
      { projectId: project.id, status: "doing", automationId: automation.id },
      1000,
    );

    deleteAutomation(ctx.db, automation.id);

    expect(listColumnArmings(ctx.db, project.id)).toEqual([]);
  });

  it("ignores an arming on a column this build has no name for", () => {
    const { project } = seeded();
    const automation = createAutomation(
      ctx.db,
      {
        projectId: project.id,
        name: "A",
        instructions: "x",
        trigger: NO_AUTOMATION_TRIGGER,
        runtime: null,
      },
      1000,
    );
    // Only reachable from a future build or a hand edit, and inert either way:
    // an arming on a column that does not exist can never fire.
    ctx.db
      .prepare(
        "INSERT INTO automation_column_arming (project_id, status, automation_id, armed_at) VALUES (?, 'shipped', ?, 1)",
      )
      .run(project.id, automation.id);

    expect(listColumnArmings(ctx.db, project.id)).toEqual([]);

    // Closed per ROW, not per project. Each row names its own column in its own
    // primary key, so an unreadable one can only ever be about a column this
    // build does not have — voiding the rest would disarm columns we can read
    // perfectly, which is a bigger lie than dropping the one we cannot.
    setColumnArming(
      ctx.db,
      { projectId: project.id, status: "doing", automationId: automation.id },
      2000,
    );

    expect(listColumnArmings(ctx.db, project.id)).toEqual([
      { projectId: project.id, status: "doing", automationId: automation.id, armedAt: 2000 },
    ]);
  });
});

describe("column order (migration 032)", () => {
  /** One project with two Automations offered in Doing, for the rank to arrange. */
  function twoOffered() {
    const { project } = seeded();
    const first = createAutomation(
      ctx.db,
      {
        projectId: project.id,
        name: "A",
        instructions: "x",
        trigger: { kind: "columns", columns: ["doing"] },
        runtime: null,
      },
      1000,
    );
    const second = createAutomation(
      ctx.db,
      {
        projectId: project.id,
        name: "B",
        instructions: "x",
        trigger: { kind: "columns", columns: ["doing"] },
        runtime: null,
      },
      1000,
    );
    return { project, first, second };
  }

  it("round-trips one column's rank and replaces it whole on the next write", () => {
    const { project, first, second } = twoOffered();

    setColumnOrder(
      ctx.db,
      { projectId: project.id, status: "doing", rankedAutomationIds: [first.id, second.id] },
      1000,
    );
    setColumnOrder(
      ctx.db,
      { projectId: project.id, status: "doing", rankedAutomationIds: [second.id, first.id] },
      2000,
    );

    expect(listColumnOrders(ctx.db, project.id)).toEqual([
      {
        projectId: project.id,
        status: "doing",
        rankedAutomationIds: [second.id, first.id],
        orderedAt: 2000,
      },
    ]);
  });

  it("keeps each column's rank to itself — one Automation, two ranks", () => {
    const { project, first, second } = twoOffered();

    setColumnOrder(
      ctx.db,
      { projectId: project.id, status: "doing", rankedAutomationIds: [first.id, second.id] },
      1000,
    );
    setColumnOrder(
      ctx.db,
      { projectId: project.id, status: "needs_review", rankedAutomationIds: [second.id, first.id] },
      1000,
    );

    const orders = listColumnOrders(ctx.db, project.id);
    expect(orders).toHaveLength(2);
    expect(orders.find((order) => order.status === "doing")?.rankedAutomationIds).toEqual([
      first.id,
      second.id,
    ]);
    expect(orders.find((order) => order.status === "needs_review")?.rankedAutomationIds).toEqual([
      second.id,
      first.id,
    ]);
  });

  it("stores an empty rank as no row at all — 'arranged into nothing' IS 'never arranged'", () => {
    const { project, first } = twoOffered();
    setColumnOrder(
      ctx.db,
      { projectId: project.id, status: "doing", rankedAutomationIds: [first.id] },
      1000,
    );

    setColumnOrder(
      ctx.db,
      { projectId: project.id, status: "doing", rankedAutomationIds: [] },
      2000,
    );

    expect(listColumnOrders(ctx.db, project.id)).toEqual([]);
  });

  it("keeps a rank naming a deleted Automation, inert rather than dangling", () => {
    // Unlike the arming beside it, a rank is a LIST and is stale-tolerant by
    // construction: every read filters it against the Offered list, so a
    // deleted record leaves an id nothing resolves rather than a broken row.
    const { project, first, second } = twoOffered();
    setColumnOrder(
      ctx.db,
      { projectId: project.id, status: "doing", rankedAutomationIds: [first.id, second.id] },
      1000,
    );

    deleteAutomation(ctx.db, first.id);

    expect(listColumnOrders(ctx.db, project.id)[0]?.rankedAutomationIds).toEqual([
      first.id,
      second.id,
    ]);
    expect(offeredAutomationsForColumn([second], "doing", [first.id, second.id])).toEqual([second]);
  });

  it("drops a row this build cannot read, per column and never per project", () => {
    const { project, first } = twoOffered();
    setColumnOrder(
      ctx.db,
      { projectId: project.id, status: "doing", rankedAutomationIds: [first.id] },
      1000,
    );
    // Three hand-edited rows from a future build: a column with no name here,
    // a rank that is not a list of ids, and one that is not a list at all.
    ctx.db
      .prepare(
        "INSERT INTO automation_column_order (project_id, status, ranked_ids, ordered_at) VALUES (?, 'shipped', '[\"a\"]', 1)",
      )
      .run(project.id);
    ctx.db
      .prepare(
        "INSERT INTO automation_column_order (project_id, status, ranked_ids, ordered_at) VALUES (?, 'todo', '[1,2]', 1)",
      )
      .run(project.id);
    ctx.db
      .prepare(
        "INSERT INTO automation_column_order (project_id, status, ranked_ids, ordered_at) VALUES (?, 'done', '\"nope\"', 1)",
      )
      .run(project.id);

    // The column we can read is untouched: a lost rank costs an arrangement,
    // never a Run, so it fails closed one row at a time.
    expect(listColumnOrders(ctx.db, project.id)).toEqual([
      {
        projectId: project.id,
        status: "doing",
        rankedAutomationIds: [first.id],
        orderedAt: 1000,
      },
    ]);
  });

  it("goes with the project, like every other machine-local projection", () => {
    const { project, first } = twoOffered();
    setColumnOrder(
      ctx.db,
      { projectId: project.id, status: "doing", rankedAutomationIds: [first.id] },
      1000,
    );

    ctx.db.prepare("DELETE FROM projects WHERE id = ?").run(project.id);

    expect(listColumnOrders(ctx.db, project.id)).toEqual([]);
  });
});
