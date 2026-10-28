import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject, testTicket, type TestDb } from "../db/test-helpers";
import { insertTicket } from "../db/tickets-repo";
import { createHostSessionServices, type HostSessionServices } from "../session-services";
import {
  createTicketCommand,
  createTicketCommentCommand,
  updateTicketFieldsCommand,
} from "../ticket-commands";
import { reclaimIfStale } from "../worktree/retention";
import { ProjectFrozenError, assertProjectWritable, projectFreeze } from "./freeze";
import { sqliteMoveJournal } from "./journal";
import { FROZEN_STATES, MOVE_STATES } from "./states";

let ctx: TestDb;
let services: HostSessionServices | undefined;
afterEach(() => {
  services?.sessionActivityWatch.stop();
  services = undefined;
  ctx?.cleanup();
});

const PROVENANCE = {
  source: { kind: "system" as const, id: "test", detail: null },
  venue: { id: "local", kind: "local" as const },
};
const CONTEXT = { now: 1, actor: { kind: "user" as const } };

function world() {
  ctx = openTestDb();
  const project = testProject({ id: "11111111-1111-4111-8111-111111111111" });
  insertProject(ctx.db, project);
  const ticket = testTicket(project.id, { id: "22222222-2222-4222-8222-222222222222" });
  insertTicket(ctx.db, ticket);
  const journal = sqliteMoveJournal(ctx.db, { now: () => 1, appVersion: "test", mapperVersion: 3 });
  journal.createQueue(
    {
      queueId: "q",
      userId: "u",
      workspaceId: "w",
      runnerId: "r",
      stopAtFirstProblem: true,
      includeRemoved: false,
      profileStep: "pending",
      backup: null,
      state: "running",
    },
    [{ moveId: "m", projectId: project.id, position: 0 }],
  );
  return { project, ticket, journal };
}

describe("the move freeze", () => {
  it("holds a project exactly while its move is in a frozen state", () => {
    const { project, journal } = world();
    expect(projectFreeze(ctx.db, project.id)).toBeNull();
    let from: (typeof MOVE_STATES)[number] = "queued";
    for (const state of MOVE_STATES.filter((s) => s !== "queued")) {
      journal.advance("m", from, state);
      from = state;
      expect(projectFreeze(ctx.db, project.id)).toBe(FROZEN_STATES.has(state) ? state : null);
    }
  });

  it("refuses ticket writes on every shared door while frozen, and lets them through after", () => {
    const { project, ticket, journal } = world();
    journal.advance("m", "queued", "frozen");
    expect(() =>
      createTicketCommand(
        ctx.db,
        {
          id: "33333333-3333-4333-8333-333333333333",
          projectId: project.id,
          title: "New",
          status: "todo",
        },
        CONTEXT,
      ),
    ).toThrow(ProjectFrozenError);
    expect(() =>
      createTicketCommentCommand(
        ctx.db,
        { ticketId: ticket.id, body: "hi", commentActor: "user" },
        CONTEXT,
      ),
    ).toThrow("moving to Volli Cloud");
    expect(() =>
      updateTicketFieldsCommand(ctx.db, { ticketId: ticket.id, worktreePath: null }, CONTEXT, {
        allowArchived: true,
      }),
    ).toThrow(ProjectFrozenError);

    journal.advance("m", "frozen", "rolling_back");
    journal.advance("m", "rolling_back", "rolled_back");
    expect(() => assertProjectWritable(ctx.db, project.id)).not.toThrow();
    expect(
      createTicketCommentCommand(
        ctx.db,
        { ticketId: ticket.id, body: "hi", commentActor: "user" },
        CONTEXT,
      ).body,
    ).toBe("hi");
  });

  it("says the archived copy is read-only for good once the move is finished", () => {
    const { project, journal } = world();
    let from: (typeof MOVE_STATES)[number] = "queued";
    for (const state of [
      "frozen",
      "exported",
      "reserved",
      "staged",
      "objects",
      "rows",
      "history",
      "verified",
      "committed",
      "handed_over",
      "checked",
      "confirmed",
    ] as const) {
      journal.advance("m", from, state);
      from = state;
    }
    expect(() => assertProjectWritable(ctx.db, project.id)).toThrow("moved to Volli Cloud");
  });

  it("starts no Session and takes no command in a frozen project, except one that stops work", async () => {
    const { project, journal } = world();
    services = createHostSessionServices(ctx.db, {
      log: { error: vi.fn(), warn: vi.fn() },
      events: { publish: vi.fn() },
      attention: {
        deliver: vi.fn(() => ({ delivered: true as const })),
        focusedSessionIds: () => new Set<string>(),
      },
    });
    const engine = services.sessionEngine;
    const created = await engine.createSession({
      commandId: "create-1",
      projectId: project.id,
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: null,
      provenance: PROVENANCE,
    });
    journal.advance("m", "queued", "frozen");
    await expect(
      engine.createSession({
        commandId: "create-2",
        projectId: project.id,
        ticketId: null,
        role: "project",
        parentSessionId: null,
        title: null,
        provenance: PROVENANCE,
      }),
    ).rejects.toThrow(ProjectFrozenError);
    await expect(
      engine.submit({
        commandId: "retitle",
        sessionId: created.session.id,
        intent: { kind: "session.retitle", title: "x" },
        provenance: PROVENANCE,
      }),
    ).rejects.toThrow(ProjectFrozenError);
    await expect(
      engine.submit({
        commandId: "stop",
        sessionId: created.session.id,
        intent: { kind: "session.stop", reason: null, by: { kind: "user" } },
        provenance: PROVENANCE,
      }),
    ).resolves.toBeDefined();
  });

  it("keeps the worktree reclaim off a frozen project's tickets", async () => {
    const { ticket, journal } = world();
    journal.advance("m", "queued", "frozen");
    const outcome = await reclaimIfStale(
      { worktree: { db: ctx.db }, now: () => 1 } as never,
      ticket.id,
      null,
    );
    expect(outcome).toEqual({ kind: "skipped", reason: "moving to Volli Cloud" });
  });
});
