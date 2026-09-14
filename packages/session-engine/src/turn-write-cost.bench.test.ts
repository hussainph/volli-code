import { describe, expect, it } from "vite-plus/test";
import type {
  RuntimeObservation,
  SessionLedger,
  SessionLedgerIds,
  SessionLedgerTransaction,
} from "@volli/shared";
import { CHECKPOINT_REFRESH_EVENTS } from "./session-engine";
import {
  createInMemorySessionLedger,
  createInMemoryTranscriptArtifactStore,
  createSessionEngine,
  createSessionRuntime,
  type BindingHandle,
  type NativeHarnessAdapter,
  type ObservationSink,
  type SessionLocationResolver,
  type SessionRuntime,
} from "./index";

/**
 * What one streamed turn costs the durable ledger (VC-356, item 3).
 *
 * `stream-cost.bench.test.ts` prices the ARTIFACT side of a turn — how many
 * transcript artifacts a settle-count cadence writes, and what a subscriber
 * reads off the wire. It deliberately says nothing about what each durable
 * fact costs to RECORD, because at its fixture size the answer is invisible.
 *
 * This probe prices exactly that, and it is the half that scales with the
 * Session rather than with the answer. Every durable fact goes through
 * `SessionEngine.observe`, and the cost of one `observe` is not a property of
 * the observation: it is a property of how much history the Session already
 * has. So the fixture is parameterised on prior history and run at two sizes,
 * because a single size cannot tell a constant from a slope.
 *
 * Two numbers come out, and they mean opposite things:
 *
 *  - **events appended per turn** is the durable write amplification the
 *    ticket asks about. It must depend only on what the turn reported, never
 *    on how long the Session has been alive. That is the ceiling this probe
 *    guards.
 *  - **event rows read per turn** is what recording those writes costs. It is
 *    the number that has a slope, and the slope is the finding.
 *
 * The real profile's busiest Session holds 1,668 events, so the slope is not
 * theoretical. Row counts here are exact rather than timed: a row count is
 * deterministic and survives being run on a loaded machine, which a
 * microsecond figure at this size does not.
 */

const venue = { id: "machine-1", kind: "local" as const };

/**
 * Prior-history sizes the probe compares.
 *
 * Three points, not two. Two can show that something grew; only a third can
 * show that it stopped growing, which is the claim this probe now makes. The
 * last two deliberately differ by a factor of two.
 */
const HISTORY_SIZES = [0, 120, 240] as const;

function fixedLocation(directory: string): SessionLocationResolver {
  const at = async () => ({ directory, venue });
  return { resolve: at, prepare: at, reaffirm: async () => undefined };
}

function ids(): SessionLedgerIds {
  let sequence = 0;
  return { next: (kind) => `${kind}-${++sequence}` };
}

function runtimeIds(prefix = "") {
  let sequence = 0;
  return { next: (kind: string) => `${prefix}${kind}-${++sequence}` };
}

class FakeAdapter implements NativeHarnessAdapter {
  readonly id = "fake";
  readonly durableIdNamespace = "fake";
  readonly adapterVersion = "1.0.0";
  readonly runtime = { path: "/trusted/fake", version: "1.0.0", fingerprint: "sha256:fake" };
  sink: ObservationSink | null = null;

  async attach(
    _spec: Parameters<NativeHarnessAdapter["attach"]>[0],
    sink: ObservationSink,
  ): Promise<BindingHandle> {
    this.sink = sink;
    return {
      native: { id: "native-session-1", detail: { provider: "fake" } },
      dispatch: async (command) => ({
        commandId: command.commandId,
        status: "accepted" as const,
        acceptedAt: 200,
        native: { id: command.commandId, detail: null },
      }),
      reconcile: async () => ({ cursor: null, observations: [], receipts: [] }),
      release: async () => undefined,
    };
  }

  emit(observation: RuntimeObservation): Promise<void> {
    if (!this.sink) throw new Error("Fake adapter is not attached");
    return this.sink.emit(observation);
  }
}

interface LedgerCounts {
  /** Durable facts appended. The amplification the ticket asks about. */
  appended: number;
  /**
   * Event rows handed back, across BOTH event reads.
   *
   * `listEvents` is the audit read and `listProjectionEvents` the fold read
   * (VC-355). They are counted together on purpose: a fix that moved a
   * whole-log read from one to the other would have changed nothing, and
   * counting only one of them is how a probe reports a rename as a win.
   */
  rowsRead: number;
  /** Calls across both reads, so a large row count can be read as breadth or depth. */
  listCalls: number;
  /**
   * Rows returned by the single widest `listEvents` call.
   *
   * This is the one that separates "reads a lot in total" from "reads the whole
   * history each time". Only the second is the defect, and only this number can
   * tell them apart.
   */
  widestRead: number;
}

/**
 * Wraps a ledger and counts the two quantities above.
 *
 * It decorates the transaction rather than the store so the count is of what
 * the Engine actually asked for, not of what an adapter happened to cache.
 */
function countingLedger(inner: SessionLedger): {
  ledger: SessionLedger;
  counts: LedgerCounts;
  reset: () => void;
} {
  const counts: LedgerCounts = { appended: 0, rowsRead: 0, listCalls: 0, widestRead: 0 };
  const record = (rows: number): void => {
    counts.listCalls += 1;
    counts.rowsRead += rows;
    counts.widestRead = Math.max(counts.widestRead, rows);
  };
  const ledger: SessionLedger = {
    transaction: (work) =>
      inner.transaction((transaction) => {
        const counted: SessionLedgerTransaction = {
          ...transaction,
          appendEvent: (event) => {
            counts.appended += 1;
            transaction.appendEvent(event);
          },
          listEvents: (query) => {
            const events = transaction.listEvents(query);
            record(events.length);
            return events;
          },
          listProjectionEvents: (query) => {
            const events = transaction.listProjectionEvents(query);
            record(events.length);
            return events;
          },
        };
        return work(counted);
      }),
  };
  return {
    ledger,
    counts,
    reset: () => {
      counts.appended = 0;
      counts.rowsRead = 0;
      counts.listCalls = 0;
      counts.widestRead = 0;
    },
  };
}

function buildRuntime(): {
  runtime: SessionRuntime;
  adapter: FakeAdapter;
  counting: ReturnType<typeof countingLedger>;
} {
  let now = 100;
  const clock = { now: () => now++ };
  const counting = countingLedger(createInMemorySessionLedger());
  const engine = createSessionEngine({ ledger: counting.ledger, clock, ids: ids() });
  const adapter = new FakeAdapter();
  const runtime = createSessionRuntime({
    engine,
    executor: adapter,
    artifacts: createInMemoryTranscriptArtifactStore(),
    locations: fixedLocation("/projects/fake"),
    clock,
    ids: runtimeIds(),
  });
  return { runtime, adapter, counting };
}

async function createAndAttach(runtime: SessionRuntime): Promise<string> {
  const created = await runtime.command({
    commandId: "command-create",
    command: {
      kind: "session.create",
      projectId: "project-1",
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: "Turn write-cost probe",
    },
  });
  await runtime.command({
    commandId: "command-attach",
    sessionId: created.sessionId,
    command: { kind: "adapter.attach", continuity: "fresh" },
  });
  return created.sessionId;
}

/**
 * One turn as an executor really reports it: a boundary, streamed text, two
 * completed activities, a settled message, and the closing boundary.
 *
 * The deltas are here on purpose even though none of them is durable. A probe
 * that fed only the durable facts would price a turn the runtime never has,
 * and would hide any translation that started writing per chunk.
 */
const DELTA_COUNT = 39;

function turnObservations(turnId: string): RuntimeObservation[] {
  const observations: RuntimeObservation[] = [{ kind: "turn", state: "started", turnId }];
  for (let index = 0; index < DELTA_COUNT; index += 1) {
    observations.push({
      kind: "delta",
      turnId,
      channel: "text",
      text: `deterministic streamed piece ${index} `,
    });
  }
  for (const callId of ["call-read-1", "call-read-2"]) {
    observations.push({
      kind: "activity",
      state: "completed",
      turnId,
      activityId: `${turnId}-${callId}`,
      descriptor: {
        kind: "read-file",
        nativeToolName: "read",
        subject: { label: "src/example.ts", path: "src/example.ts", lineRange: null },
        outcome: null,
        startedAt: 10,
        endedAt: 20,
      },
      input: { path: "src/example.ts" },
      output: { content: "export const value = 1;" },
      occurredAt: 1234,
    });
  }
  observations.push({
    kind: "message-settled",
    turnId,
    message: {
      entryId: `entry-${turnId}`,
      role: "assistant",
      text: "The deterministic settled answer for this turn.",
    },
    occurredAt: 1234,
  });
  observations.push({ kind: "turn", state: "completed", turnId });
  return observations;
}

/** Runs `priorTurns` turns, then returns what one more turn alone cost the ledger. */
async function measureTurn(priorTurns: number): Promise<LedgerCounts> {
  const { runtime, adapter, counting } = buildRuntime();
  await createAndAttach(runtime);
  for (let turn = 0; turn < priorTurns; turn += 1) {
    for (const observation of turnObservations(`warm-${turn}`)) await adapter.emit(observation);
  }
  counting.reset();
  for (const observation of turnObservations("measured")) await adapter.emit(observation);
  return { ...counting.counts };
}

// The measured cost is quadratic in history by construction, and coverage
// instrumentation multiplies it again, so this needs more than the default
// per-test budget even at a deliberately small fixture.
const PROBE_TIMEOUT_MS = 120_000;

describe("session-engine turn write-cost probe", () => {
  it(
    "keeps durable writes per turn independent of history, and prices what recording them reads",
    async () => {
      // Each prior turn appends the same durable facts the measured turn does,
      // so history size is expressed in turns and reported in events.
      const measured = await Promise.all(
        HISTORY_SIZES.map(async (size) => ({ size, counts: await measureTurn(size) })),
      );
      const [cold, warm, warmer] = measured;
      if (!cold || !warm || !warmer) throw new Error("Every history size must be measured");

      const rows = measured.map(({ size, counts }) => ({
        priorTurns: size,
        priorEvents: size * cold.counts.appended,
        appended: counts.appended,
        listCalls: counts.listCalls,
        rowsRead: counts.rowsRead,
        widestRead: counts.widestRead,
      }));

      // eslint-disable-next-line no-console -- the probe's numbers ARE the deliverable
      console.log(
        [
          "",
          "[turn write-cost probe] one streamed turn, end to end",
          `  observations fed per turn:   ${turnObservations("x").length} (${DELTA_COUNT} deltas)`,
          ...rows.map(
            (row) =>
              `  prior events ${String(row.priorEvents).padStart(5)}: ` +
              `appended ${String(row.appended).padStart(3)}  ` +
              `listEvents calls ${String(row.listCalls).padStart(3)}  ` +
              `rows read ${String(row.rowsRead).padStart(7)}  ` +
              `widest single read ${String(row.widestRead).padStart(5)}`,
          ),
          "",
        ].join("\n"),
      );
      // The ceiling. A turn's durable cost is a property of what the turn
      // reported — one settled message, two activities, the boundaries — and
      // NOTHING about it may grow with the Session's age. Per-chunk durability
      // would put this past 40 immediately; a history-dependent write would make
      // the two arms differ at all.
      expect(cold.counts.appended).toBe(warm.counts.appended);
      expect(warm.counts.appended).toBe(warmer.counts.appended);
      expect(cold.counts.appended).toBeLessThanOrEqual(DELTA_COUNT);

      // The finding this probe was written for, and what VC-356 changed.
      // Recording one fact used to fold the Session's whole event list first,
      // so an identical turn cost more the longer the Session had run: at 600
      // prior events, 5 durable writes read 3,040 rows to land them.
      //
      // The cost is now bounded by how stale the derived checkpoint may get,
      // never by the Session's age.
      //
      // The arms are compared against that BOUND rather than against each
      // other, because they legitimately differ: where a Session sits inside
      // the refresh window when the measured turn begins is a function of its
      // total event count, so 600 and 1,200 prior events leave different
      // residues to fold. That is phase, not growth. What must hold for every
      // arm is the ceiling.
      const perTurnEvents = cold.counts.appended;
      const widestPermitted = CHECKPOINT_REFRESH_EVENTS + perTurnEvents;
      for (const { size, counts } of measured) {
        expect(counts.widestRead).toBeLessThanOrEqual(widestPermitted);
        expect(counts.rowsRead).toBeLessThanOrEqual(counts.listCalls * widestPermitted);
        // And the ceiling is worth having: at the larger arms it is a small
        // fraction of the whole-log read this path used to make.
        if (size > 0) expect(counts.rowsRead).toBeLessThan((size * perTurnEvents) / 2);
      }
    },
    PROBE_TIMEOUT_MS,
  );
});
