import { afterEach, describe, expect, it } from "vite-plus/test";
import { NO_AUTOMATION_TRIGGER } from "@volli/shared";
import type { ModelSelection } from "@volli/shared";

import {
  clearColumnArming,
  createAutomation,
  deleteAutomation,
  getAutomation,
  getSkippedOccurrence,
  insertSkippedOccurrence,
  latestRunForTicket,
  listAllAutomations,
  listAutomationsForProject,
  listColumnArmings,
  listProjectRunsForAutomation,
  listRunsForProject,
  listRunsForTicket,
  listSkippedOccurrencesForProject,
  readAutomationRunAttendance,
  recordAutomationRun,
  setColumnArming,
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

  /* --------------------------- schedules (VC-130) ----------------------- */

  const NIGHTLY = {
    kind: "schedule" as const,
    schedule: { preset: "daily" as const, hour: 21, minute: 30, timeZone: "Europe/London" },
  };

  it("stores a schedule Trigger as JSON and reads it back whole", () => {
    const { project } = seeded();
    const automation = createAutomation(
      ctx.db,
      {
        projectId: project.id,
        name: "Nightly",
        instructions: "/sweep",
        trigger: NIGHTLY,
        runtime: null,
      },
      1000,
    );
    expect(getAutomation(ctx.db, automation.id)?.trigger).toEqual(NIGHTLY);
  });

  it("degrades a stored schedule this build cannot read to firing nothing", () => {
    // The safe direction, and the reason it is safe: an unreadable schedule can
    // only ever cost a Run that would have started on its own, and the record
    // stays runnable by hand. Repairing it would start work at an invented time.
    const { project } = seeded();
    const automation = createAutomation(
      ctx.db,
      {
        projectId: project.id,
        name: "Nightly",
        instructions: "/sweep",
        trigger: NIGHTLY,
        runtime: null,
      },
      1000,
    );
    ctx.db.prepare("UPDATE automations SET trigger_spec = ? WHERE id = ?").run(
      JSON.stringify({
        kind: "schedule",
        schedule: { preset: "daily", hour: 21, minute: 30, timeZone: "Mars/Olympus" },
      }),
      automation.id,
    );
    expect(getAutomation(ctx.db, automation.id)?.trigger).toEqual(NO_AUTOMATION_TRIGGER);
  });

  it("lists every Automation on this machine, whatever project it belongs to", () => {
    // The scheduler's read: a timer serves every project at once, so asking
    // per project would make the set of live schedules depend on which
    // projects a window happens to have open.
    const { project } = seeded();
    const other = testProject({ id: "project-two", path: "/repo/two", ticketPrefix: "OT" });
    insertProject(ctx.db, other);
    const draft = { name: "A", instructions: "x", trigger: NIGHTLY, runtime: null };
    createAutomation(ctx.db, { ...draft, projectId: project.id }, 1000);
    createAutomation(ctx.db, { ...draft, projectId: other.id, name: "B" }, 1001);
    createAutomation(ctx.db, { ...draft, projectId: null, name: "C" }, 1002);
    expect(listAllAutomations(ctx.db).map((automation) => automation.name)).toEqual([
      "A",
      "B",
      "C",
    ]);
  });

  it("finds one Automation's Runs inside one project, through their own Sessions", () => {
    const { project, ticket, session } = seeded();
    const automation = createAutomation(
      ctx.db,
      {
        projectId: project.id,
        name: "Nightly",
        instructions: "/sweep",
        trigger: NIGHTLY,
        runtime: null,
      },
      1000,
    );
    const ticketRun = recordAutomationRun(
      ctx.db,
      {
        automationId: automation.id,
        automationName: automation.name,
        ticketId: ticket.id,
        sessionId: session.id,
        model: { providerId: "anthropic", modelId: "claude-opus", reasoningLevel: "high" },
      },
      2000,
    );
    // A Run that names NO Ticket — a schedule's Project target. It is filed by
    // the project of the Session it opened, which is the only evidence it has.
    const projectSession = testSession(project.id, null, { id: "session-project" });
    insertSession(ctx.db, projectSession);
    const projectRun = recordAutomationRun(
      ctx.db,
      {
        automationId: automation.id,
        automationName: automation.name,
        ticketId: null,
        sessionId: projectSession.id,
        model: { providerId: "anthropic", modelId: "claude-opus", reasoningLevel: "high" },
      },
      3000,
    );

    expect(projectRun.ticketId).toBeNull();
    expect(
      listProjectRunsForAutomation(ctx.db, {
        automationId: automation.id,
        projectId: project.id,
      }),
    ).toEqual([projectRun, ticketRun]);
    // And the project's whole history carries the ticketless Run too, without
    // a second scoping rule.
    expect(listRunsForProject(ctx.db, project.id)).toEqual([projectRun, ticketRun]);
    expect(listRunsForTicket(ctx.db, ticket.id)).toEqual([ticketRun]);
  });

  it("records a Skipped occurrence and lists it newest due first", () => {
    const { project } = seeded();
    const automation = createAutomation(
      ctx.db,
      {
        projectId: project.id,
        name: "Nightly",
        instructions: "/sweep",
        trigger: NIGHTLY,
        runtime: null,
      },
      1000,
    );
    const skip = {
      id: "11111111-1111-4111-8111-111111111111",
      automationId: automation.id,
      automationName: "Nightly",
      projectId: project.id,
      dueAt: 5000,
      missedCount: 3,
      reason: { kind: "app-closed" as const },
    };
    insertSkippedOccurrence(ctx.db, { ...skip, recordedAt: 6000 });
    insertSkippedOccurrence(ctx.db, {
      ...skip,
      id: "22222222-2222-4222-8222-222222222222",
      dueAt: 9000,
      missedCount: 1,
      reason: { kind: "run-refused", code: "MODEL_REQUIRED", error: "Choose a model." },
      recordedAt: 9500,
    });

    const listed = listSkippedOccurrencesForProject(ctx.db, project.id);
    expect(listed.map((row) => row.dueAt)).toEqual([9000, 5000]);
    expect(listed[0]?.reason).toEqual({
      kind: "run-refused",
      code: "MODEL_REQUIRED",
      error: "Choose a model.",
    });
    expect(getSkippedOccurrence(ctx.db, skip.id)).toMatchObject({ missedCount: 3 });
    expect(getSkippedOccurrence(ctx.db, "nope")).toBeUndefined();
  });

  it("still reads as a skip when the stored reason is unreadable", () => {
    // The one asymmetry with the Trigger beside it: an unreadable REASON must
    // never make a skip look like a silence, so it degrades to "unknown"
    // rather than to a cause we would be inventing.
    const { project } = seeded();
    const automation = createAutomation(
      ctx.db,
      {
        projectId: project.id,
        name: "Nightly",
        instructions: "/sweep",
        trigger: NIGHTLY,
        runtime: null,
      },
      1000,
    );
    insertSkippedOccurrence(ctx.db, {
      id: "33333333-3333-4333-8333-333333333333",
      automationId: automation.id,
      automationName: "Nightly",
      projectId: project.id,
      dueAt: 5000,
      missedCount: 1,
      reason: { kind: "app-closed" },
      recordedAt: 6000,
    });
    ctx.db
      .prepare("UPDATE automation_skipped_occurrences SET reason = ? WHERE id = ?")
      .run(JSON.stringify({ kind: "from-the-future" }), "33333333-3333-4333-8333-333333333333");
    expect(listSkippedOccurrencesForProject(ctx.db, project.id)[0]?.reason).toEqual({
      kind: "unknown",
    });
  });

  it("takes a deleted Automation's skips with it — there is nothing left to run now", () => {
    const { project } = seeded();
    const automation = createAutomation(
      ctx.db,
      {
        projectId: project.id,
        name: "Nightly",
        instructions: "/sweep",
        trigger: NIGHTLY,
        runtime: null,
      },
      1000,
    );
    insertSkippedOccurrence(ctx.db, {
      id: "44444444-4444-4444-8444-444444444444",
      automationId: automation.id,
      automationName: "Nightly",
      projectId: project.id,
      dueAt: 5000,
      missedCount: 1,
      reason: { kind: "app-closed" },
      recordedAt: 6000,
    });
    deleteAutomation(ctx.db, automation.id);
    expect(listSkippedOccurrencesForProject(ctx.db, project.id)).toEqual([]);
  });
});

describe("Run attendance (VC-133)", () => {
  it("round-trips both answers, and reads back by Session", () => {
    const { project, ticket, session } = seeded();
    const automation = createAutomation(
      ctx.db,
      {
        projectId: project.id,
        name: "Nightly",
        instructions: "/sweep",
        trigger: NO_AUTOMATION_TRIGGER,
        runtime: null,
      },
      1000,
    );
    const run = recordAutomationRun(
      ctx.db,
      {
        automationId: automation.id,
        ticketId: ticket.id,
        sessionId: session.id,
        model: PIN,
        attendance: "unattended",
      },
      2000,
    );

    expect(run.attendance).toBe("unattended");
    expect(listRunsForTicket(ctx.db, ticket.id)[0]?.attendance).toBe("unattended");
    expect(readAutomationRunAttendance(ctx.db, session.id)).toBe("unattended");
  });

  it("records a Run whose door said nothing as attended, never as a guess", () => {
    // The legacy/test-support caller. Silence is the safe answer: an
    // `unattended` guess would notify about work somebody is watching.
    const { project, ticket, session } = seeded();
    const automation = createAutomation(
      ctx.db,
      {
        projectId: project.id,
        name: "Nightly",
        instructions: "/sweep",
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
    expect(run.attendance).toBe("attended");
    expect(readAutomationRunAttendance(ctx.db, session.id)).toBe("attended");
  });

  it("answers null for a Session no Run owns", () => {
    // A chat a person opened, and VC-131's pre-Run crash window alike. The
    // notification rule reads both as "do not notify".
    const { session } = seeded();
    expect(readAutomationRunAttendance(ctx.db, session.id)).toBeNull();
  });

  it("reads a row written before the column existed as attended", () => {
    // Migration 033 adds the column nullable rather than backfilling a default,
    // so a pre-VC-133 row really is NULL here. The degrade happens on READ,
    // which is what keeps the column's meaning and the rule in one place.
    const { project, ticket, session } = seeded();
    const automation = createAutomation(
      ctx.db,
      {
        projectId: project.id,
        name: "Nightly",
        instructions: "/sweep",
        trigger: NO_AUTOMATION_TRIGGER,
        runtime: null,
      },
      1000,
    );
    recordAutomationRun(
      ctx.db,
      {
        automationId: automation.id,
        ticketId: ticket.id,
        sessionId: session.id,
        model: PIN,
        attendance: "unattended",
      },
      2000,
    );
    ctx.db.prepare("UPDATE automation_runs SET attendance = NULL").run();

    expect(readAutomationRunAttendance(ctx.db, session.id)).toBe("attended");
    expect(listRunsForTicket(ctx.db, ticket.id)[0]?.attendance).toBe("attended");
  });

  it("refuses a word the vocabulary does not have", () => {
    // The CHECK constraint, so a hand-edited database cannot introduce a third
    // answer the reader would then have to interpret.
    const { project, ticket, session } = seeded();
    const automation = createAutomation(
      ctx.db,
      {
        projectId: project.id,
        name: "Nightly",
        instructions: "/sweep",
        trigger: NO_AUTOMATION_TRIGGER,
        runtime: null,
      },
      1000,
    );
    recordAutomationRun(
      ctx.db,
      { automationId: automation.id, ticketId: ticket.id, sessionId: session.id, model: PIN },
      2000,
    );
    expect(() => ctx.db.prepare("UPDATE automation_runs SET attendance = 'maybe'").run()).toThrow(
      /CHECK constraint failed/,
    );
  });
});
