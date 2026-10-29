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
import { createCloudSessionOwner } from "../cloud-store/owner";
import {
  ProjectFrozenError,
  assertProjectWritable,
  bindCloudSessionOwner,
  cloudClaimsSessionWrite,
  projectFreeze,
} from "./freeze";
import { sqliteMoveJournal } from "./journal";
import { COMMITTED_STATES, FROZEN_STATES, MOVE_STATES } from "./states";

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

  describe("Volli Cloud's writes on a moved project", () => {
    const A = "33333333-3333-4333-8333-333333333333";
    const B = "44444444-4444-4444-8444-444444444444";

    async function claims() {
      const { project } = world();
      services = createHostSessionServices(ctx.db, {
        log: { error: vi.fn(), warn: vi.fn() },
        events: { publish: vi.fn() },
        attention: {
          deliver: vi.fn(() => ({ delivered: true as const })),
          focusedSessionIds: () => new Set<string>(),
        },
      });
      const engine = services.sessionEngine;
      let n = 0;
      const birth = (ownerUserId?: string) => ({
        commandId: `create-${++n}`,
        projectId: project.id,
        ticketId: null,
        role: "project" as const,
        parentSessionId: null,
        title: null,
        provenance: PROVENANCE,
        ...(ownerUserId === undefined ? {} : { ownerUserId }),
      });
      const command = (sessionId: string, stop = false) => ({
        commandId: `command-${++n}`,
        sessionId,
        intent: stop
          ? ({ kind: "session.stop", reason: null, by: { kind: "user" } } as const)
          : ({ kind: "session.retitle", title: "x" } as const),
        provenance: PROVENANCE,
      });
      // Before the move: a Session that moves (this runner drains it for A
      // after the handover), one that stays local, one born for A that no
      // cursor holds.
      const moved = (await engine.createSession(birth())).session.id;
      const local = (await engine.createSession(birth())).session.id;
      const uncursored = (await engine.createSession(birth(A))).session.id;
      ctx.db
        .prepare(
          `INSERT INTO session_drain_cursors (session_id, owner_user_id, claim_generation,
             accepted_through, updated_at) VALUES (?, ?, 1, 1, 1)`,
        )
        .run(moved, A);
      const setState = (state: string) =>
        ctx.db.prepare("UPDATE cloud_moves SET state = ? WHERE move_id = 'm'").run(state);
      const passes = (write: Promise<unknown>) =>
        write.then(
          () => true,
          (error: unknown) => {
            if (!(error instanceof ProjectFrozenError)) throw error;
            return false;
          },
        );
      return { project, engine, birth, command, moved, local, uncursored, setState, passes };
    }

    afterEach(() => {
      if (ctx !== undefined) bindCloudSessionOwner(ctx.db, null);
    });

    it("passes only once the move committed, only for the launch's own person, and never a local write", async () => {
      const { engine, birth, command, moved, local, setState, passes } = await claims();
      bindCloudSessionOwner(ctx.db, A);
      for (const state of FROZEN_STATES) {
        setState(state);
        const shown = COMMITTED_STATES.has(state);
        expect({ state, cloudBirth: await passes(engine.createSession(birth(A))) }).toEqual({
          state,
          cloudBirth: shown,
        });
        expect({ state, moved: await passes(engine.submit(command(moved))) }).toEqual({
          state,
          moved: shown,
        });
        expect({ state, localBirth: await passes(engine.createSession(birth())) }).toEqual({
          state,
          localBirth: false,
        });
        expect({ state, local: await passes(engine.submit(command(local))) }).toEqual({
          state,
          local: false,
        });
        expect({ state, stop: await passes(engine.submit(command(local, true))) }).toEqual({
          state,
          stop: true,
        });
      }
    });

    it("gives a local launch, or another person's, no claim at all", async () => {
      const { engine, birth, command, moved, setState, passes } = await claims();
      setState("confirmed");
      // A local launch (no cloud owner here): the archived copy is the only view.
      expect(await passes(engine.submit(command(moved)))).toBe(false);
      expect(await passes(engine.createSession(birth(A)))).toBe(false);
      // A cloud launch for someone else: A's cursor and A's births are not theirs.
      bindCloudSessionOwner(ctx.db, B);
      expect(await passes(engine.submit(command(moved)))).toBe(false);
      expect(await passes(engine.createSession(birth(A)))).toBe(false);
      bindCloudSessionOwner(ctx.db, A);
      expect(await passes(engine.submit(command(moved)))).toBe(true);
    });

    it("claims no Session whose birth names the person but no cursor of theirs holds", async () => {
      const { uncursored, setState } = await claims();
      setState("confirmed");
      bindCloudSessionOwner(ctx.db, A);
      expect(cloudClaimsSessionWrite(ctx.db, { kind: "session", sessionId: uncursored })).toBe(
        false,
      );
    });

    it("lets the cloud launch's own Session owner resume a moved Session and start one", async () => {
      const { project, birth, moved, setState } = await claims();
      setState("checked");
      bindCloudSessionOwner(ctx.db, A);
      const cloud = createCloudSessionOwner({
        db: ctx.db,
        engine: services!.sessionEngine,
        ownerUserId: A,
        adopt: (sessionId) =>
          ctx.db
            .prepare(
              `INSERT INTO session_drain_cursors (session_id, owner_user_id, claim_generation,
                 accepted_through, updated_at) VALUES (?, ?, 1, 0, 1)`,
            )
            .run(sessionId, A),
      }).engine;
      await expect(
        cloud.submit({
          commandId: "resume",
          sessionId: moved,
          intent: { kind: "session.retitle", title: "Resumed in Volli Cloud" },
          provenance: PROVENANCE,
        }),
      ).resolves.toBeDefined();
      const started = await cloud.createSession({ ...birth(), projectId: project.id });
      expect(
        cloudClaimsSessionWrite(ctx.db, { kind: "session", sessionId: started.session.id }),
      ).toBe(true);
    });
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
