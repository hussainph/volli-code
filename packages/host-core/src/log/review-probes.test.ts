/**
 * The VC-699 review's probes, permanent (blockers 5 and 6): each one showed
 * a defect; each now asserts the fixed behaviour, against the real Session
 * runtime and SQLite ledger where the probe used them.
 */
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  createInMemoryTranscriptArtifactStore,
  createSessionEngine,
  createSessionRuntime,
  type BindingHandle,
  type HarnessCommand,
  type NativeHarnessAdapter,
  type ObservationSink,
} from "@volli/session-engine";
import type { LogRecord } from "@volli/shared";

import { insertProject } from "../db/projects-repo";
import { logQueueChanges } from "../db/session-follow-up-repo";
import { openTestDb, testProject } from "../db/test-helpers";
import { correlatedExecutor } from "../session-runtime/correlated-executor";
import { createSqliteSessionLedger } from "../session-control/sqlite-ledger";
import { currentTrace, logContext, withRootLogContext, withTrace } from "./context";
import {
  commandTrace,
  MAX_REMEMBERED,
  rememberCommandTrace,
  rememberTurnTrace,
  resetLogCorrelation,
  turnTrace,
} from "./correlation";
import { createLogger, MAX_LOG_LINE_BYTES } from "./logger";
import { installHostLog } from "./root";

const A = { traceId: "a".repeat(32), spanId: "1".repeat(16) };
const B = { traceId: "b".repeat(32), spanId: "2".repeat(16) };
const C = { traceId: "c".repeat(32), spanId: "3".repeat(16) };

afterEach(() => resetLogCorrelation());

function captureRoot(): { records: LogRecord[]; undo: () => void } {
  const records: LogRecord[] = [];
  const undo = installHostLog({
    level: "debug",
    sink: { write: (record) => records.push(record) },
  });
  return { records, undo };
}

describe("the line ceiling holds whatever the fields hold", () => {
  it("cuts oversized correlation values, so the cut line fits the advertised ceiling", () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: "info",
      component: "probe",
      sink: { write: (_record, line) => lines.push(line) },
    });
    const huge = Object.fromEntries(
      ["traceId", "spanId", "sessionId", "turnId", "commandId", "ticketId", "projectId"].map(
        (key) => [key, "界".repeat(2000)],
      ),
    );
    logger.info("large identifiers", huge);
    // The reviewer's probe: 42,221 bytes.
    expect(Buffer.byteLength(lines[0]!)).toBeLessThanOrEqual(MAX_LOG_LINE_BYTES);
    const cut = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(cut).toMatchObject({ truncated: true, msg: "large identifiers" });
    expect(cut["sessionId"]).toBeUndefined();
  });

  it("keeps short identifiers, and stays under the ceiling for the worst escapes", () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: "info",
      component: "\u0001".repeat(5_000),
      sink: { write: (_record, line) => lines.push(line) },
    });
    logger.info("\u0001".repeat(5_000), {
      sessionId: "session-1",
      turnId: 7,
      blob: "x".repeat(20_000),
    });
    expect(Buffer.byteLength(lines[0]!)).toBeLessThanOrEqual(MAX_LOG_LINE_BYTES);
    expect(JSON.parse(lines[0]!)).toMatchObject({ sessionId: "session-1", turnId: 7 });
  });
});

describe("background work does not inherit a request's trace", () => {
  it("isolates concurrent requests, and a detached producer carries no trace", async () => {
    const seen = await Promise.all([
      withTrace(A, {}, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return currentTrace();
      }),
      withTrace(B, {}, async () => {
        await Promise.resolve();
        return currentTrace();
      }),
    ]);
    expect(seen).toEqual([A, B]);
    expect(currentTrace()).toBeNull();
    // The reviewer's timer kept A on every tick; started detached, it holds its own ids only.
    const ticks: unknown[] = [];
    let done!: () => void;
    const finished = new Promise<void>((resolve) => (done = resolve));
    withTrace(A, { operation: "sessions.attach" }, () =>
      withRootLogContext({ sessionId: "s-1" }, () => {
        const timer = setInterval(() => {
          ticks.push({ ...logContext() });
          if (ticks.length === 3) {
            clearInterval(timer);
            done();
          }
        }, 1);
      }),
    );
    await finished;
    expect(ticks).toEqual([{ sessionId: "s-1" }, { sessionId: "s-1" }, { sessionId: "s-1" }]);
  });

  it("remembers command and turn traces, first owner wins, bounded", () => {
    rememberCommandTrace("cmd-1", A.traceId);
    rememberCommandTrace("cmd-1", B.traceId);
    rememberCommandTrace("cmd-bad", "not-a-trace");
    rememberCommandTrace("", A.traceId);
    expect(commandTrace("cmd-1")).toBe(A.traceId);
    expect(commandTrace("cmd-bad")).toBeUndefined();
    expect(commandTrace(undefined)).toBeUndefined();
    rememberTurnTrace("s-1", "t-1", B.traceId);
    rememberTurnTrace("s-1", "t-1", A.traceId);
    expect(turnTrace("s-1", "t-1")).toBe(B.traceId);
    expect(turnTrace("s-2", "t-1")).toBeUndefined();
    expect(turnTrace("s-1", undefined)).toBeUndefined();
    for (let index = 0; index < MAX_REMEMBERED; index += 1) {
      rememberCommandTrace(`fill-${index}`, C.traceId);
    }
    expect(commandTrace("cmd-1")).toBeUndefined();
    expect(commandTrace(`fill-${MAX_REMEMBERED - 1}`)).toBe(C.traceId);
  });
});

/**
 * The real runtime and ledger, composed as host-core composes them (the
 * executor wrapped by `correlatedExecutor`), with a fake executor whose
 * long-lived producer is an interval created during `attach` under trace A.
 */
async function runtimeHarness(behaviour: {
  onDispatch: (command: HarnessCommand, sink: ObservationSink) => Promise<void>;
  onTick?: (sink: ObservationSink) => Promise<void> | undefined;
}) {
  const ctx = openTestDb();
  const project = testProject({ id: "project-probe" });
  insertProject(ctx.db, project);
  const { records, undo } = captureRoot();
  let seq = 0;
  const ids = { next: (kind: string) => `${kind}-${++seq}` };
  const clock = { now: () => 100 + seq };
  let timer: ReturnType<typeof setInterval> | undefined;
  const tickContexts: unknown[] = [];
  const inner: NativeHarnessAdapter = {
    id: "fake",
    durableIdNamespace: "fake",
    adapterVersion: "1.0.0",
    runtime: { path: "/trusted/fake", version: "1.0.0", fingerprint: "sha256:fake" },
    async attach(_spec, sink): Promise<BindingHandle> {
      timer = setInterval(() => {
        tickContexts.push(logContext()["traceId"]);
        void behaviour.onTick?.(sink);
      }, 1);
      return {
        native: { id: "native-1", detail: null },
        dispatch: async (command) => {
          await behaviour.onDispatch(command, sink);
          return {
            commandId: command.commandId,
            status: "accepted",
            acceptedAt: 200,
            native: { id: command.commandId, detail: null },
          };
        },
        reconcile: async () => ({ cursor: { value: 0 }, observations: [], receipts: [] }),
        release: async () => clearInterval(timer),
      };
    },
  };
  const venue = { id: "machine", kind: "local" as const };
  const location = async () => ({ directory: "/fixture", venue });
  const runtime = createSessionRuntime({
    engine: createSessionEngine({ ledger: createSqliteSessionLedger(ctx.db), clock, ids }),
    executor: correlatedExecutor(inner),
    artifacts: createInMemoryTranscriptArtifactStore(),
    locations: { resolve: location, prepare: location, reaffirm: async () => {} },
    clock,
    ids,
  });
  const created = await runtime.command({
    commandId: "create",
    command: {
      kind: "session.create",
      projectId: project.id,
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: null,
    },
  });
  await withTrace(A, { operation: "sessions.attach" }, () =>
    runtime.command({
      commandId: "attach",
      sessionId: created.sessionId,
      command: { kind: "adapter.attach", continuity: "fresh" },
    }),
  );
  const submit = () =>
    withTrace(B, { operation: "session.command", commandId: "submit" }, () =>
      runtime.command({
        commandId: "submit",
        sessionId: created.sessionId,
        command: {
          kind: "message.submit",
          message: { id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] },
        },
      }),
    );
  return {
    records,
    tickContexts,
    submit,
    async close() {
      clearInterval(timer);
      await runtime.close();
      undo();
      ctx.cleanup();
    },
  };
}

describe("a Session's turns, under the real runtime and ledger", () => {
  it("never files a turn an attach-time producer reports under the attach's trace", async () => {
    let pending = false;
    let observed!: () => void;
    const emitted = new Promise<void>((resolve) => (observed = resolve));
    const harness = await runtimeHarness({
      onDispatch: async () => {
        pending = true;
      },
      onTick: (sink) => {
        if (!pending) return undefined;
        pending = false;
        return sink
          .emit({ kind: "turn", state: "started", turnId: "late-turn", occurredAt: 200 })
          .then(observed);
      },
    });
    try {
      await harness.submit();
      await emitted;
      const turn = harness.records.find((record) => record.msg === "session turn.started");
      // The reviewer's probe: this line carried the attach's trace (aaaa…).
      expect(turn).toBeDefined();
      expect(turn?.traceId).not.toBe(A.traceId);
      // No data joins this turn to the message, so it claims no trace at all.
      expect(turn?.traceId).toBeUndefined();
      expect(turn).toMatchObject({ sessionId: expect.any(String), turnId: "late-turn" });
      expect(turn?.["operation"]).toBeUndefined();
      expect(harness.tickContexts.every((traceId) => traceId === undefined)).toBe(true);
      // The message's own command line is the message's.
      const recorded = harness.records.find(
        (record) => record.msg === "session command.recorded" && record.commandId === "submit",
      );
      expect(recorded?.traceId).toBe(B.traceId);
      const attached = harness.records.find((record) => record.msg === "session attachment.opened");
      expect(attached?.traceId).toBe(A.traceId);
    } finally {
      await harness.close();
    }
  });

  it("files a turn opened on the dispatch's chain under the message, and its later end too", async () => {
    let finish = false;
    let ended!: () => void;
    const completed = new Promise<void>((resolve) => (ended = resolve));
    const harness = await runtimeHarness({
      onDispatch: async (command, sink) => {
        if (command.kind !== "message.submit") return;
        expect(logContext()).toMatchObject({ traceId: B.traceId, commandId: "submit" });
        await sink.emit({ kind: "turn", state: "started", turnId: "turn-b", occurredAt: 200 });
        finish = true;
      },
      onTick: (sink) => {
        if (!finish) return undefined;
        finish = false;
        // Reported later, from the attach-time listener: detached, no trace of its own.
        return sink
          .emit({ kind: "turn", state: "completed", turnId: "turn-b", occurredAt: 300 })
          .then(ended);
      },
    });
    try {
      await harness.submit();
      await completed;
      const started = harness.records.find((record) => record.msg === "session turn.started");
      const done = harness.records.find((record) => record.msg === "session turn.completed");
      expect(started?.traceId).toBe(B.traceId);
      expect(done?.traceId).toBe(B.traceId);
      expect(done?.["spanId"]).toBeUndefined();
    } finally {
      await harness.close();
    }
  });
});

function state(entries: { id: string; state: "queued" | "releasing" }[], released = false) {
  return {
    revision: 1,
    releasedBoundary: null,
    entries: entries.map((entry) => ({
      id: entry.id,
      state: entry.state,
      commandId: `queue-${entry.id}`,
      deliveryCommandId: `follow-up:s-1:queue-${entry.id}`,
      message: { id: entry.id, role: "user" as const, parts: [] },
    })),
    releases: released
      ? {
          "follow-up:s-1:queue-m1": {
            receipt: { status: "accepted" },
          },
        }
      : {},
  } as unknown as Parameters<typeof logQueueChanges>[2];
}
const rows = (s: Parameters<typeof logQueueChanges>[2]) =>
  new Map(
    s.entries.map((entry) => [
      entry.id,
      {
        state: entry.state,
        commandId: entry.commandId,
        deliveryCommandId: entry.deliveryCommandId,
      },
    ]),
  );

describe("a queued follow-up keeps its message's trace", () => {
  it("logs its release and delivery under the trace that queued it, and runs its delivery there", async () => {
    const { records, undo } = captureRoot();
    try {
      const queued = state([{ id: "m1", state: "queued" }]);
      withTrace(C, { operation: "session.command" }, () =>
        logQueueChanges("s-1", new Map(), queued),
      );
      expect(commandTrace("follow-up:s-1:queue-m1")).toBe(C.traceId);
      // Released when another message's turn ends, on that message's chain.
      const releasing = state([{ id: "m1", state: "releasing" }]);
      withTrace(B, {}, () => logQueueChanges("s-1", rows(queued), releasing));
      withTrace(B, {}, () => logQueueChanges("s-1", rows(releasing), state([], true)));
      // Untraced background release too.
      withRootLogContext({}, () => logQueueChanges("s-1", rows(queued), releasing));
      expect(records.map(({ msg, traceId }) => [msg, traceId])).toEqual([
        ["follow-up queued", C.traceId],
        ["follow-up release claimed", C.traceId],
        ["follow-up delivered", C.traceId],
        ["follow-up release claimed", C.traceId],
      ]);
      // The delivery command's dispatch runs under the follow-up's trace, not B's.
      let dispatchedUnder: unknown;
      const handle = await correlatedExecutor({
        id: "fake",
        durableIdNamespace: "fake",
        adapterVersion: "1",
        runtime: { path: "/x", version: "1", fingerprint: "sha256:x" },
        attach: async () => {
          dispatchedUnder = logContext();
          return {
            native: { id: "n", detail: null },
            extra: "kept",
            dispatch: async (command: HarnessCommand) => {
              dispatchedUnder = logContext();
              return {
                commandId: command.commandId,
                status: "accepted",
                acceptedAt: 1,
                native: null,
              };
            },
            reconcile: async () => ({ cursor: null, observations: [], receipts: [] }),
            release: async () => {},
          } as BindingHandle;
        },
      }).attach(
        { sessionId: "s-1", attachmentId: "att-1" } as Parameters<
          NativeHarnessAdapter["attach"]
        >[0],
        { emit: async () => {} },
      );
      expect(dispatchedUnder).toEqual({ sessionId: "s-1", attachmentId: "att-1" });
      expect((handle as unknown as { extra: string }).extra).toBe("kept");
      await expect(handle.reconcile(null)).resolves.toMatchObject({ receipts: [] });
      await withTrace(B, { operation: "session.command" }, () =>
        handle.dispatch({
          kind: "message.submit",
          commandId: "follow-up:s-1:queue-m1",
          sessionId: "s-1",
          attachmentId: "att-1",
        } as HarnessCommand),
      );
      expect(dispatchedUnder).toEqual({
        traceId: C.traceId,
        sessionId: "s-1",
        attachmentId: "att-1",
        commandId: "follow-up:s-1:queue-m1",
      });
      // A command recorded on this request runs on the request's own chain.
      rememberCommandTrace("direct", B.traceId);
      await withTrace(B, { operation: "session.command" }, () =>
        handle.dispatch({
          kind: "message.submit",
          commandId: "direct",
          sessionId: "s-1",
          attachmentId: "att-1",
        } as HarnessCommand),
      );
      expect(dispatchedUnder).toMatchObject({
        traceId: B.traceId,
        spanId: B.spanId,
        operation: "session.command",
        commandId: "direct",
      });
    } finally {
      undo();
    }
  });

  it("logs a withdrawal and a returned claim under the queuing trace too", () => {
    const { records, undo } = captureRoot();
    try {
      const queued = state([{ id: "m1", state: "queued" }]);
      withTrace(C, {}, () => logQueueChanges("s-1", new Map(), queued));
      const releasing = state([{ id: "m1", state: "releasing" }]);
      logQueueChanges("s-1", rows(releasing), queued);
      logQueueChanges("s-1", rows(queued), state([]));
      expect(records.slice(1).map(({ msg, traceId, reason }) => [msg, traceId, reason])).toEqual([
        ["follow-up claim returned", C.traceId, "not-sent"],
        ["follow-up withdrawn", C.traceId, "cancelled"],
      ]);
    } finally {
      undo();
    }
  });
});
