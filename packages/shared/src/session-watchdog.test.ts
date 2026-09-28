import { describe, expect, it } from "vite-plus/test";
import { EMPTY_SESSION_USAGE_SUMMARY } from "./session-usage";
import type { SessionAttention, SessionInteraction, SessionProjection } from "./session-ledger";

import type { RuntimeActivityValue, RuntimeObservation } from "./agent-runtime";
import {
  DEFAULT_SESSION_WATCHDOG_SILENCE_MS,
  EMPTY_SUSPEND_LEDGER,
  MAX_SUSPEND_LEDGER_INTERVALS,
  SESSION_WATCHDOG_IN_FLIGHT_CEILING_MS,
  SESSION_WATCHDOG_TOOL_TIMEOUT_MARGIN_MS,
  SESSION_WATCHDOG_WAITING_TOOLS,
  declaredToolTimeoutMs,
  inFlightToolAllowanceMs,
  nextInFlightTools,
  sessionWedge,
  suspendLedgerResumed,
  suspendLedgerSuspended,
  suspendedMsWithin,
} from "./session-watchdog";
import type { SessionInFlightTool } from "./session-watchdog";

function projection(overrides: Partial<SessionProjection> = {}): SessionProjection {
  return {
    session: {
      id: "session-1",
      projectId: "project-1",
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: "Implementer",
      createdAt: 0,
    },
    status: "open",
    commands: [],
    receipts: [],
    pendingExecutorStart: null,
    attachments: [],
    liveExecutor: null,
    attention: { active: [], primary: null },
    interactions: { active: [], resolved: [] },
    signal: null,
    stopped: null,
    modelSelection: null,
    modelTier: null,
    turnActive: true,
    lastTurnOutcome: null,
    authorityDenials: 0,
    usage: EMPTY_SESSION_USAGE_SUMMARY,
    lastActivityAt: 0,
    bornTicketless: true,
    ...overrides,
  };
}

const T = DEFAULT_SESSION_WATCHDOG_SILENCE_MS;

describe("sessionWedge", () => {
  it("calls a live turn silent past the threshold wedged, and says for how long", () => {
    expect(sessionWedge(projection(), T + 5_000, T, 0)).toEqual({
      wedged: true,
      silentForMs: T + 5_000,
      overdueTool: null,
    });
  });

  it("keeps watching a live turn still inside the threshold", () => {
    expect(sessionWedge(projection(), T - 1, T, 0)).toEqual({ wedged: false, reason: "active" });
    // The boundary itself trips: N minutes of silence IS the claim.
    expect(sessionWedge(projection(), T, T, 0)).toEqual({
      wedged: true,
      silentForMs: T,
      overdueTool: null,
    });
  });

  it("never calls a Session with no open turn wedged, however silent", () => {
    expect(sessionWedge(projection({ turnActive: false }), T * 10, T, 0)).toEqual({
      wedged: false,
      reason: "no-turn",
    });
  });

  it("never calls a stopped Session wedged — its work was ended, not lost", () => {
    expect(
      sessionWedge(
        projection({ stopped: { at: 1, reason: null, by: { kind: "user" } } }),
        T * 10,
        T,
        0,
      ),
    ).toEqual({ wedged: false, reason: "stopped" });
  });

  // Attention doctrine: silence alone never becomes a lifecycle fact ABOUT THE
  // AGENT when a human is the blocker. A permission prompt can sit for an hour
  // legitimately, and it already self-reports through Attention.
  it("never calls a Session waiting on a person wedged", () => {
    const interaction: SessionInteraction = {
      id: "interaction-1",
      attachmentId: "attachment-1",
      kind: "permission",
      title: "Allow?",
      detail: null,
      options: [],
      multiple: false,
      native: { id: null, detail: null },
    };
    expect(
      sessionWedge(
        projection({ interactions: { active: [interaction], resolved: [] } }),
        T * 10,
        T,
        0,
      ),
    ).toEqual({ wedged: false, reason: "awaiting-user" });

    const attention = {
      id: "attention-1",
      kind: "permission_required",
      attachmentId: null,
      detail: null,
      diagnostic: null,
    } as SessionAttention;
    expect(
      sessionWedge(
        projection({ attention: { active: [attention], primary: attention } }),
        T * 10,
        T,
        0,
      ),
    ).toEqual({ wedged: false, reason: "awaiting-user" });
  });

  it("measures silence from runtime progress rather than durable recency", () => {
    // A durable fact can be old while streamed tokens are fresh.
    expect(sessionWedge(projection({ lastActivityAt: 0 }), T + 500, T, 500)).toEqual({
      wedged: true,
      silentForMs: T,
      overdueTool: null,
    });
    expect(sessionWedge(projection({ lastActivityAt: 0 }), T + 500, T, 501)).toEqual({
      wedged: false,
      reason: "active",
    });
    // A clock that reads earlier than the last progress is active, not negative silence.
    expect(sessionWedge(projection(), 800, T, 900)).toEqual({ wedged: false, reason: "active" });
  });

  it("defaults to ten minutes — one app-wide threshold, the compaction precedent", () => {
    expect(DEFAULT_SESSION_WATCHDOG_SILENCE_MS).toBe(10 * 60_000);
  });
});

const MIN = 60_000;
const HOUR = 60 * MIN;

function tool(
  toolName: string,
  declaredTimeoutMs: number | null = null,
  activityId = `call-${toolName}`,
): SessionInFlightTool {
  return { activityId, toolName, declaredTimeoutMs };
}

describe("sessionWedge with a tool in flight", () => {
  it("never trips on a tool that waits on another Session or a person by design", () => {
    for (const name of ["ticket_await", "session_await", "ask_user"]) {
      expect(SESSION_WATCHDOG_WAITING_TOOLS.has(name)).toBe(true);
      expect(sessionWedge(projection(), 24 * HOUR, T, 0, { inFlightTools: [tool(name)] })).toEqual({
        wedged: false,
        reason: "tool-running",
      });
    }
  });

  it("trips a tool with a declared timeout only past that timeout plus the margin", () => {
    // `gh pr checks --watch` with a 45-minute bash timeout.
    const watch = tool("bash", 45 * MIN);
    const limit = 45 * MIN + SESSION_WATCHDOG_TOOL_TIMEOUT_MARGIN_MS;
    expect(sessionWedge(projection(), limit - 1, T, 0, { inFlightTools: [watch] })).toEqual({
      wedged: false,
      reason: "tool-running",
    });
    expect(sessionWedge(projection(), limit, T, 0, { inFlightTools: [watch] })).toEqual({
      wedged: true,
      silentForMs: limit,
      overdueTool: "bash",
    });
  });

  it("never lets a short declared timeout make the watchdog less patient than a bare turn", () => {
    const quick = tool("bash", 30_000);
    expect(sessionWedge(projection(), T - 1, T, 0, { inFlightTools: [quick] })).toEqual({
      wedged: false,
      reason: "active",
    });
    expect(sessionWedge(projection(), T, T, 0, { inFlightTools: [quick] })).toEqual({
      wedged: true,
      silentForMs: T,
      overdueTool: "bash",
    });
  });

  it("trips a tool with no declared limit only past the in-flight ceiling", () => {
    // A `sleep 900` poll loop, a coverage run: slow, not stuck.
    const sleeping = tool("bash");
    expect(sessionWedge(projection(), 20 * MIN, T, 0, { inFlightTools: [sleeping] })).toEqual({
      wedged: false,
      reason: "tool-running",
    });
    expect(
      sessionWedge(projection(), SESSION_WATCHDOG_IN_FLIGHT_CEILING_MS, T, 0, {
        inFlightTools: [tool("mcp__github__wait")],
      }),
    ).toEqual({
      wedged: true,
      silentForMs: SESSION_WATCHDOG_IN_FLIGHT_CEILING_MS,
      overdueTool: "mcp__github__wait",
    });
  });

  it("lets the tightest allowance decide, so a wait cannot shelter a hung sibling", () => {
    const tools = [tool("ticket_await"), tool("bash", 5 * MIN), tool("web_fetch")];
    const limit = T; // bash's 5m + margin is under the floor, so the floor decides.
    expect(sessionWedge(projection(), limit, T, 0, { inFlightTools: tools })).toEqual({
      wedged: true,
      silentForMs: limit,
      overdueTool: "bash",
    });
  });

  it("keeps a bare turn on the ten-minute rule when nothing is in flight", () => {
    expect(sessionWedge(projection(), T, T, 0, { inFlightTools: [] })).toEqual({
      wedged: true,
      silentForMs: T,
      overdueTool: null,
    });
  });
});

describe("sessionWedge across machine sleep", () => {
  it("does not trip on wake after a three-hour sleep inside an open turn", () => {
    // Progress at 0, lid closed at 2m, opened at 3h2m, scanned at 3h3m.
    const ledger = suspendLedgerResumed(
      suspendLedgerSuspended(EMPTY_SUSPEND_LEDGER, 2 * MIN),
      3 * HOUR + 2 * MIN,
    );
    const now = 3 * HOUR + 3 * MIN;
    const suspendedMs = suspendedMsWithin(ledger, 0, now);
    expect(suspendedMs).toBe(3 * HOUR);
    expect(sessionWedge(projection(), now, T, 0, { suspendedMs })).toEqual({
      wedged: false,
      reason: "active",
    });
  });

  it("still trips once the awake silence alone passes the threshold", () => {
    const ledger = suspendLedgerResumed(
      suspendLedgerSuspended(EMPTY_SUSPEND_LEDGER, 2 * MIN),
      3 * HOUR + 2 * MIN,
    );
    const now = 3 * HOUR + T;
    expect(
      sessionWedge(projection(), now, T, 0, { suspendedMs: suspendedMsWithin(ledger, 0, now) }),
    ).toEqual({ wedged: true, silentForMs: T, overdueTool: null });
  });

  it("counts a sleep not yet announced as over up to the scan, so an early scan stays quiet", () => {
    // The first scan after wake can run before `resume` is delivered.
    const asleep = suspendLedgerSuspended(EMPTY_SUSPEND_LEDGER, 2 * MIN);
    const now = 3 * HOUR;
    const suspendedMs = suspendedMsWithin(asleep, 0, now);
    expect(suspendedMs).toBe(now - 2 * MIN);
    expect(sessionWedge(projection(), now, T, 0, { suspendedMs })).toEqual({
      wedged: false,
      reason: "active",
    });
  });
});

describe("the suspend ledger", () => {
  it("keeps the earliest announcement of one sleep and ignores a wake it never saw begin", () => {
    const once = suspendLedgerSuspended(EMPTY_SUSPEND_LEDGER, 100);
    expect(suspendLedgerSuspended(once, 200)).toBe(once);
    expect(suspendLedgerResumed(EMPTY_SUSPEND_LEDGER, 300)).toBe(EMPTY_SUSPEND_LEDGER);
    expect(suspendLedgerResumed(once, 300)).toEqual({
      intervals: [{ from: 100, to: 300 }],
      suspendedSince: null,
    });
    // A wake stamped before its sleep (a wall clock stepped back) is a zero-length sleep.
    expect(suspendLedgerResumed(once, 50).intervals).toEqual([{ from: 100, to: 100 }]);
  });

  it("counts only the part of each sleep inside the window", () => {
    let ledger = EMPTY_SUSPEND_LEDGER;
    for (const [from, to] of [
      [0, 100],
      [200, 300],
      [400, 500],
    ] as const) {
      ledger = suspendLedgerResumed(suspendLedgerSuspended(ledger, from), to);
    }
    expect(suspendedMsWithin(ledger, 250, 450)).toBe(100);
    expect(suspendedMsWithin(ledger, 600, 700)).toBe(0);
    // An open sleep that began after the window's end adds nothing.
    expect(suspendedMsWithin(suspendLedgerSuspended(ledger, 900), 600, 700)).toBe(0);
  });

  it("forgets the oldest sleeps past its bound", () => {
    let ledger = EMPTY_SUSPEND_LEDGER;
    for (let index = 0; index <= MAX_SUSPEND_LEDGER_INTERVALS; index += 1) {
      ledger = suspendLedgerResumed(suspendLedgerSuspended(ledger, index * 10), index * 10 + 1);
    }
    expect(ledger.intervals).toHaveLength(MAX_SUSPEND_LEDGER_INTERVALS);
    expect(ledger.intervals[0]).toEqual({ from: 10, to: 11 });
  });
});

function activity(
  state: "started" | "progress" | "completed" | "failed",
  activityId: string,
  nativeToolName: string,
  input: RuntimeActivityValue = null,
): RuntimeObservation {
  return {
    kind: "activity",
    turnId: "turn-1",
    activityId,
    state,
    descriptor: {
      kind: "other",
      nativeToolName,
      subject: { label: null, path: null, lineRange: null },
      outcome: null,
      startedAt: null,
      endedAt: null,
    },
    input,
    output: null,
  } as RuntimeObservation;
}

describe("nextInFlightTools", () => {
  it("adds a call when it starts, keeps it through progress, and drops it when it ends", () => {
    const started = nextInFlightTools([], activity("started", "a", "bash", { timeout: 120 }));
    expect(started).toEqual([{ activityId: "a", toolName: "bash", declaredTimeoutMs: 120_000 }]);
    expect(nextInFlightTools(started, activity("progress", "a", "bash"))).toBe(started);
    // A progress for a call whose start was missed still counts it as in flight.
    expect(nextInFlightTools([], activity("progress", "b", "read"))).toEqual([
      { activityId: "b", toolName: "read", declaredTimeoutMs: null },
    ]);
    expect(nextInFlightTools(started, activity("completed", "a", "bash"))).toEqual([]);
    expect(nextInFlightTools(started, activity("failed", "a", "bash"))).toEqual([]);
    // An end for a call never seen starting changes nothing.
    expect(nextInFlightTools(started, activity("completed", "z", "bash"))).toBe(started);
  });

  it("empties at a turn boundary and when the attachment closes", () => {
    const one = nextInFlightTools([], activity("started", "a", "bash"));
    expect(nextInFlightTools(one, { kind: "turn", state: "completed", turnId: "turn-1" })).toEqual(
      [],
    );
    const none: readonly SessionInFlightTool[] = [];
    expect(nextInFlightTools(none, { kind: "turn", state: "started", turnId: "turn-2" })).toBe(
      none,
    );
    expect(nextInFlightTools(one, { kind: "attachment", state: "closed" })).toEqual([]);
    expect(nextInFlightTools(one, { kind: "attachment", state: "failed" })).toEqual([]);
    expect(nextInFlightTools(none, { kind: "attachment", state: "closed" })).toBe(none);
    expect(nextInFlightTools(one, { kind: "attachment", state: "started" })).toBe(one);
    expect(
      nextInFlightTools(one, {
        kind: "usage",
        entryId: "entry-1",
        turnId: "turn-1",
        usage: EMPTY_SESSION_USAGE_SUMMARY as never,
      }),
    ).toBe(one);
  });
});

describe("declaredToolTimeoutMs", () => {
  it("reads bash's timeout in seconds and nothing else", () => {
    expect(declaredToolTimeoutMs("bash", { command: "sleep 5", timeout: 90 })).toBe(90_000);
    expect(declaredToolTimeoutMs("bash", { command: "sleep 5" })).toBeNull();
    expect(declaredToolTimeoutMs("bash", { timeout: 0 })).toBeNull();
    expect(declaredToolTimeoutMs("bash", { timeout: "90" })).toBeNull();
    expect(declaredToolTimeoutMs("bash", null)).toBeNull();
    expect(declaredToolTimeoutMs("bash", "sleep 5")).toBeNull();
    expect(declaredToolTimeoutMs("bash", [90])).toBeNull();
    // Another tool's `timeout` could be in any unit: not trusted.
    expect(declaredToolTimeoutMs("mcp__ci__watch", { timeout: 90 })).toBeNull();
    // Prototype keys are not tool names.
    expect(declaredToolTimeoutMs("toString", { timeout: 90 })).toBeNull();
  });

  it("allows a declared-timeout tool its timeout plus margin, and others the ceiling", () => {
    expect(inFlightToolAllowanceMs(tool("bash", HOUR * 2), T)).toBe(
      HOUR * 2 + SESSION_WATCHDOG_TOOL_TIMEOUT_MARGIN_MS,
    );
    expect(inFlightToolAllowanceMs(tool("web_fetch"), T)).toBe(
      SESSION_WATCHDOG_IN_FLIGHT_CEILING_MS,
    );
    expect(inFlightToolAllowanceMs(tool("session_await"), T)).toBe(Number.POSITIVE_INFINITY);
  });
});
