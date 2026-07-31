import { afterEach, describe, expect, it } from "vite-plus/test";
import { createControlPlane } from "@volli/control-plane";
import type { SessionLedger } from "@volli/shared";
import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject } from "../db/test-helpers";
import type { TestDb } from "../db/test-helpers";
import { createSqliteSessionLedger } from "./sqlite-ledger";

let ctx: TestDb;

afterEach(() => {
  ctx.cleanup();
});

function setup(): {
  ledger: SessionLedger;
  control: ReturnType<typeof createControlPlane>;
  projectId: string;
} {
  ctx = openTestDb();
  const project = testProject({ id: "project" });
  insertProject(ctx.db, project);
  let id = 0;
  const ledger = createSqliteSessionLedger(ctx.db);
  return {
    ledger,
    control: createControlPlane({
      ledger,
      clock: { now: () => 100 + id },
      ids: { next: (kind) => `${kind}-${++id}` },
    }),
    projectId: project.id,
  };
}

const provenance = {
  source: { kind: "system" as const, id: "desktop", detail: null },
  venue: { id: "local", kind: "local" as const },
};

describe("SqliteSessionLedger", () => {
  it("commits a complete create fact set once, replays it idempotently, and orders cloned reads", async () => {
    const { control, projectId } = setup();
    const first = await control.createSession({
      commandId: "create-a",
      projectId,
      ticketId: null,
      title: "One",
      provenance,
    });
    const replay = await control.createSession({
      commandId: "create-a",
      projectId,
      ticketId: null,
      title: "One",
      provenance,
    });
    const second = await control.createSession({
      commandId: "create-b",
      projectId,
      ticketId: null,
      title: "Two",
      provenance,
    });

    expect(replay).toEqual(first);
    expect(
      (await control.listSessions({ projectId, scope: "all" })).map((item) => item.session.id),
    ).toEqual([second.session.id, first.session.id]);
    const page = await control.listEvents({
      sessionId: first.session.id,
      afterSequence: 1,
      limit: 2,
    });
    expect(page.map((event) => event.sequence)).toEqual([2, 3]);
    page[0]!.payload = { kind: "session.archived" };
    expect((await control.listEvents({ sessionId: first.session.id }))[1]!.payload.kind).toBe(
      "session.created",
    );
  });

  it("serializes async transactions and rolls a failed transaction back", async () => {
    const { ledger, control, projectId } = setup();
    const created = await control.createSession({
      commandId: "create",
      projectId,
      ticketId: null,
      title: "One",
      provenance,
    });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = ledger.transaction(async (tx) => {
      expect(tx.getSession(created.session.id)?.id).toBe(created.session.id);
      await gate;
    });
    const second = ledger.transaction((tx) => {
      expect(tx.getSession(created.session.id)?.id).toBe(created.session.id);
    });
    await Promise.resolve();
    release?.();
    await Promise.all([first, second]);

    await expect(
      ledger.transaction((tx) => {
        tx.appendEvent({
          id: "bad-event",
          sessionId: created.session.id,
          sequence: 99,
          occurredAt: 1,
          recordedAt: 1,
          provenance,
          payload: { kind: "session.archived" },
        });
      }),
    ).rejects.toThrow("sequence must be monotonic");
    expect(await control.listEvents({ sessionId: created.session.id })).toHaveLength(3);
  });

  it("persists attachment evidence atomically and refuses a corrupt JSON row on read", async () => {
    const { control, projectId } = setup();
    const created = await control.createSession({
      commandId: "create",
      projectId,
      ticketId: null,
      title: "One",
      provenance,
    });
    const start = await control.submit({
      commandId: "start",
      sessionId: created.session.id,
      intent: { kind: "executor.start", adapterId: "terminal", continuity: "fresh" },
      provenance,
    });
    await control.observe({
      id: "opened",
      kind: "attachment.opened",
      sessionId: created.session.id,
      commandId: start.command.id,
      occurredAt: 200,
      provenance,
      attachment: {
        id: "attachment",
        sessionId: created.session.id,
        adapterId: "terminal",
        venue: { id: "local", kind: "local" },
        continuity: "fresh",
        native: { id: null, detail: { kind: "volli.terminal.v1", cwd: "/repo" } },
      },
    });
    expect(
      ctx.db.prepare("SELECT created_sequence, observed_kind FROM session_attachments").get(),
    ).toEqual({ created_sequence: 5, observed_kind: "opened" });

    ctx.db.pragma("ignore_check_constraints = ON");
    ctx.db.prepare("UPDATE session_events SET provenance = '{' WHERE id = ?").run(created.event.id);
    ctx.db.pragma("ignore_check_constraints = OFF");
    await expect(control.listEvents({ sessionId: created.session.id })).rejects.toThrow(
      "contains invalid JSON",
    );
  });
});
