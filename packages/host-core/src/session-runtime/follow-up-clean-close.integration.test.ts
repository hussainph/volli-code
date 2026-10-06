import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  createInMemoryTranscriptArtifactStore,
  createSessionRuntime,
  type HarnessCommand,
  type NativeHarnessAdapter,
} from "@volli/session-engine";
import { createTestSessionEngine } from "../testing/session-engine";
import { insertProject } from "../db/projects-repo";
import { getAppState, setAppState } from "../db/app-state-repo";
import {
  consumeFollowUpCleanClose,
  createSqliteSessionFollowUpLedger,
  FOLLOW_UP_CLEAN_CLOSE_KEY,
  FOLLOW_UP_DOWNGRADE_HOLD_DETAIL,
  stampFollowUpCleanClose,
} from "../db/session-follow-up-repo";
import { openRawDb, openTestDb, testProject, type TestDb } from "../db/test-helpers";

let fixture: TestDb;
let runtime: ReturnType<typeof createSessionRuntime> | undefined;
afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
  fixture?.cleanup();
});

async function setup() {
  fixture = openTestDb();
  insertProject(fixture.db, testProject({ id: "project" }));
  let nextId = 0;
  const engine = createTestSessionEngine(fixture.db, {
    now: () => 100,
    nextId: () => `id-${++nextId}`,
  });
  const created = await engine.createSession({
    commandId: "create",
    projectId: "project",
    ticketId: null,
    role: "project",
    parentSessionId: null,
    title: null,
    provenance: {
      source: { kind: "system", id: "test", detail: null },
      venue: { id: "local", kind: "local" },
    },
  });
  const sessionId = created.session.id;
  await createSqliteSessionFollowUpLedger(fixture.db).transaction(sessionId, (state) => {
    state.revision = 1;
    state.entries = ["first", "second"].map((id) => ({
      id,
      commandId: `queue-${id}`,
      deliveryCommandId: `follow-up:${sessionId}:${id}`,
      state: "queued",
      message: { id, role: "user", parts: [{ type: "text", text: id }] },
    }));
  });
  return { sessionId, engine };
}

async function boot(sessionId: string, unknownDelivery = false) {
  fixture.db.close();
  fixture.db = openRawDb(fixture.dbPath);
  const held = consumeFollowUpCleanClose(fixture.db);
  const engine = createTestSessionEngine(fixture.db);
  const commands: HarnessCommand[] = [];
  const adapter: NativeHarnessAdapter = {
    id: "fake",
    durableIdNamespace: "fake",
    adapterVersion: "1",
    runtime: { path: "/fake", version: "1", fingerprint: "fake" },
    attach: async (_spec, sink) => ({
      native: { id: "native", detail: null },
      dispatch: async (command) => {
        commands.push(command);
        if (unknownDelivery) {
          return {
            commandId: command.commandId,
            status: "unknown",
            detail: "No evidence",
            native: null,
          };
        }
        if (command.kind === "message.submit") {
          await sink.emit({
            kind: "turn",
            state: "started",
            turnId: `turn:${command.commandId}`,
            occurredAt: 200,
          });
        }
        return { commandId: command.commandId, status: "accepted", acceptedAt: 201, native: null };
      },
      reconcile: async () => ({ cursor: null, observations: [], receipts: [] }),
      release: async () => undefined,
    }),
  };
  runtime = createSessionRuntime({
    engine,
    executor: adapter,
    followUps: createSqliteSessionFollowUpLedger(fixture.db),
    artifacts: createInMemoryTranscriptArtifactStore(),
    clock: { now: () => 200 },
    ids: { next: (kind) => `${kind}-${crypto.randomUUID()}` },
    locations: {
      resolve: async () => ({ directory: "/fake", venue: { id: "local", kind: "local" } }),
      prepare: async () => ({ directory: "/fake", venue: { id: "local", kind: "local" } }),
      reaffirm: async () => undefined,
    },
  });
  for (const id of held)
    await runtime.reportMessageDeliveryFailure({
      sessionId: id,
      commandId: `follow-up:${id}`,
      detail: FOLLOW_UP_DOWNGRADE_HOLD_DETAIL,
    });
  await runtime.recoverFollowUps();
  expect(getAppState(fixture.db, FOLLOW_UP_CLEAN_CLOSE_KEY)).toBeUndefined();
  return {
    held,
    commands,
    engine,
    projection: (await runtime.projection({ sessionId })).projection,
  };
}

describe("follow-up clean-close round trips", () => {
  it("reads late delivery proof inside SQLite's cancel transaction", async () => {
    const { sessionId } = await setup();
    const f = await boot(sessionId, true);
    expect(f.projection.queue?.[0].state).toBe("releasing");
    const delivery = f.commands.find((command) => command.kind === "message.submit")!;
    const latest = f.engine.latestEventSequence;
    let armed = true;
    f.engine.latestEventSequence = async (query) => {
      const sequence = await latest(query);
      if (armed) {
        armed = false;
        await f.engine.observe({
          id: "late-delivery-proof",
          sessionId,
          attachmentId: f.projection.liveExecutor!.id,
          occurredAt: 300,
          provenance: { source: { kind: "adapter", id: "fake", detail: null }, venue: null },
          kind: "command.receipt",
          receipt: {
            id: "late-delivery-receipt",
            commandId: delivery.commandId,
            status: "accepted",
            acceptedAt: 300,
            result: { kind: "message.submitted", sessionId },
          },
        });
      }
      return sequence;
    };
    const cancelled = await runtime!.command({
      commandId: "cancel-late",
      sessionId,
      command: { kind: "message.cancel", messageId: "first" },
    });
    expect(armed).toBe(false);
    expect(cancelled.receipt).toMatchObject({
      status: "rejected",
      detail: "This message was already delivered",
    });
    expect(fixture.db.inTransaction).toBe(false);
    expect(f.commands.filter((command) => command.kind === "message.submit")).toHaveLength(1);
  });

  it("holds every queued row after an older writer advanced the Session, never submits, and allows removal", async () => {
    const { sessionId, engine } = await setup();
    stampFollowUpCleanClose(fixture.db, 100);
    // N−1 knows nothing about the queue, but ordinary Session history still advances.
    await engine.observe({
      id: "older-writer",
      sessionId,
      occurredAt: 101,
      provenance: { source: { kind: "system", id: "older-version", detail: null }, venue: null },
      kind: "attention.cleared",
      attentionId: "nonexistent",
    });
    const result = await boot(sessionId);
    expect(result.held).toEqual([sessionId]);
    expect(result.commands).toEqual([]);
    expect(result.projection.queue).toHaveLength(2);
    expect(result.projection.attention.active).toContainEqual(
      expect.objectContaining({ detail: FOLLOW_UP_DOWNGRADE_HOLD_DETAIL }),
    );
    const state = await createSqliteSessionFollowUpLedger(fixture.db).transaction(
      sessionId,
      (snapshot) => snapshot,
    );
    expect(state.entries.every((entry) => entry.refused)).toBe(true);
    expect(state.revision).toBe(2);
    // Clearing Attention/repeated recovery must not release an unchanged held row.
    await createTestSessionEngine(fixture.db).observe({
      id: "clear-held",
      sessionId,
      occurredAt: 202,
      provenance: { source: { kind: "system", id: "test", detail: null }, venue: null },
      kind: "attention.cleared",
      attentionId: result.projection.attention.active[0]!.id,
    });
    await runtime!.recoverFollowUps();
    expect(result.commands).toEqual([]);
    const cancelled = await runtime!.command({
      commandId: "remove",
      sessionId,
      command: { kind: "message.cancel", messageId: "first", expectedRevision: 2 },
    });
    expect(cancelled.receipt?.status).toBe("accepted");
    await runtime!.recoverFollowUps();
    expect(result.commands).toEqual([]);
    // The other held row can be edited explicitly; only the edited words run.
    const edited = await runtime!.command({
      commandId: "edit",
      sessionId,
      command: {
        kind: "message.edit",
        messageId: "second",
        expectedRevision: 3,
        message: { id: "second", role: "user", parts: [{ type: "text", text: "reviewed" }] },
      },
    });
    expect(edited.receipt?.status).toBe("accepted");
    await runtime!.recoverFollowUps();
    expect(result.commands.filter((command) => command.kind === "message.submit")).toHaveLength(1);
  });

  it("releases after a clean restart with unchanged history", async () => {
    const { sessionId } = await setup();
    stampFollowUpCleanClose(fixture.db, 100);
    expect(JSON.parse(getAppState(fixture.db, FOLLOW_UP_CLEAN_CLOSE_KEY)!)).toMatchObject({
      v: 1,
      sessions: { [sessionId]: expect.any(Number) },
    });
    const result = await boot(sessionId);
    expect(result.held).toEqual([]);
    expect(result.commands.filter((command) => command.kind === "message.submit")).toHaveLength(1);
  });

  it("releases after a crash with no clean-close key", async () => {
    const { sessionId } = await setup();
    const result = await boot(sessionId);
    expect(result.held).toEqual([]);
    expect(result.commands.filter((command) => command.kind === "message.submit")).toHaveLength(1);
  });

  it("holds Sessions absent from a present stamp", async () => {
    const { sessionId } = await setup();
    setAppState(fixture.db, FOLLOW_UP_CLEAN_CLOSE_KEY, '{"v":1,"sessions":{}}', 100);
    const result = await boot(sessionId);
    expect(result.held).toEqual([sessionId]);
    expect(result.commands).toEqual([]);
  });

  it.each(['{"v":2,"sessions":{}}', "invalid-json", "null"])(
    "holds safely with unreadable watermark %s",
    async (encoded) => {
      const { sessionId } = await setup();
      setAppState(fixture.db, FOLLOW_UP_CLEAN_CLOSE_KEY, encoded, 100);
      const result = await boot(sessionId);
      expect(result.held).toEqual([sessionId]);
      expect(result.commands).toEqual([]);
      // The explanation survives a crash between consumption and Attention.
      expect(consumeFollowUpCleanClose(fixture.db)).toEqual([sessionId]);
    },
  );

  it("preserves an unconsumed stamp if the host stops before readiness", async () => {
    const { sessionId } = await setup();
    setAppState(fixture.db, FOLLOW_UP_CLEAN_CLOSE_KEY, '{"v":1,"sessions":{}}', 100);
    stampFollowUpCleanClose(fixture.db, 101);
    expect(getAppState(fixture.db, FOLLOW_UP_CLEAN_CLOSE_KEY)).toBe('{"v":1,"sessions":{}}');
    expect((await boot(sessionId)).commands).toEqual([]);
  });

  it("holds an orphaned claim with no recorded send after an older visit", async () => {
    const { sessionId } = await setup();
    await createSqliteSessionFollowUpLedger(fixture.db).transaction(sessionId, (state) => {
      state.entries[0]!.state = "releasing";
      state.releasedBoundary = "idle:birth";
    });
    setAppState(fixture.db, FOLLOW_UP_CLEAN_CLOSE_KEY, '{"v":1,"sessions":{}}', 100);
    const result = await boot(sessionId);
    expect(result.held).toEqual([sessionId]);
    expect(result.commands).toEqual([]);
    expect(result.projection.queue?.[0].state).toBe("queued");
  });
});
