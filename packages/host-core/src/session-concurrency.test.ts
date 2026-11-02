import { describe, expect, it, vi } from "vite-plus/test";
import { EMPTY_SESSION_USAGE_SUMMARY } from "@volli/shared";
import type {
  SessionAttachmentProjection,
  SessionInteraction,
  SessionProjection,
} from "@volli/shared";

import { terminalNativeReference } from "./session-control";
import {
  createSessionConcurrencyEnvReader,
  sessionConcurrencyEnv,
  workingSessionCount,
} from "./session-concurrency";
import type { LiveExecutors, SessionConcurrencyPorts } from "./session-concurrency";

function projectionWith(
  id: string,
  attachments: SessionAttachmentProjection[],
  overrides: Partial<SessionProjection> = {},
): SessionProjection {
  return {
    session: {
      id,
      projectId: "project",
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: "A Session",
      createdAt: 1,
    },
    status: "open",
    commands: [],
    resumptions: [],
    latestTurnId: null,
    latestTurnOrigin: null,
    resumedAfterStop: false,
    receipts: [],
    pendingExecutorStart: null,
    attachments,
    liveExecutor: null,
    attention: { active: [], primary: null },
    interactions: { active: [], resolved: [] },
    signal: null,
    stopped: null,
    modelSelection: null,
    modelTier: null,
    turnActive: false,
    lastTurnOutcome: null,
    usage: EMPTY_SESSION_USAGE_SUMMARY,
    lastActivityAt: 1,
    bornTicketless: true,
    ...overrides,
  };
}

function terminalAttachment(status: "open" | "closed"): SessionAttachmentProjection {
  return {
    id: `attachment-${status}`,
    sessionId: "session",
    adapterId: "terminal",
    venue: { id: "local", kind: "local" },
    continuity: "fresh",
    native: terminalNativeReference({
      kind: "volli.terminal.v1",
      cwd: "/repo",
      harnessId: "claude-code",
      activeHarnessId: null,
      harnessSessionId: null,
      launchKind: "agent",
      placement: "tab",
      exitCode: null,
    }),
    authority: null,
    status,
    openedAt: 1,
    closedAt: status === "open" ? null : 2,
    outcome: null,
    failure: null,
    exitCode: null,
  };
}

function structuredAttachment(): SessionAttachmentProjection {
  return {
    id: "structured",
    sessionId: "session",
    adapterId: "opencode",
    venue: { id: "local", kind: "local" },
    continuity: "fresh",
    native: null,
    authority: null,
    status: "open",
    openedAt: 1,
    closedAt: null,
    outcome: null,
    failure: null,
    exitCode: null,
  };
}

/** A live terminal Session — one shell, still open. */
function liveTerminal(id: string): SessionProjection {
  return projectionWith(id, [terminalAttachment("open")]);
}

/** A structured Session mid-turn: the chat listing's "working". */
function workingChat(id: string): SessionProjection {
  return projectionWith(id, [structuredAttachment()], { turnActive: true });
}

/** An open question, which makes a mid-turn chat "waiting" rather than working. */
function chatQuestion(): SessionInteraction {
  return {
    id: "interaction-1",
    attachmentId: "structured",
    kind: "question",
    title: "Which branch?",
    detail: null,
    options: [],
    multiple: false,
    native: { id: null, detail: null },
  };
}

/** Every given Session's executor held by this process — the ordinary case for a count. */
function allLive(projections: readonly SessionProjection[]): LiveExecutors {
  const ids = new Set(projections.map((projection) => projection.session.id));
  return {
    turnSessionIds: ids,
    terminalSessionIds: ids,
    boundAttachmentIds: new Set(
      projections.flatMap((projection) => projection.attachments.map(({ id }) => id)),
    ),
  };
}

/** A count over Sessions whose executors are all held, as the reader hands them over. */
function liveFleet(projections: SessionProjection[]) {
  return { projections, live: allLive(projections) };
}

const NOTHING_LIVE: LiveExecutors = {
  turnSessionIds: new Set(),
  terminalSessionIds: new Set(),
  boundAttachmentIds: new Set(),
};

describe("workingSessionCount", () => {
  it("counts live terminal Sessions and structured Sessions mid-turn", () => {
    expect(
      workingSessionCount(liveFleet([liveTerminal("a"), workingChat("b"), liveTerminal("c")])),
    ).toBe(3);
  });

  it("ignores a terminal Session whose shell has exited", () => {
    expect(
      workingSessionCount(liveFleet([projectionWith("a", [terminalAttachment("closed")])])),
    ).toBe(0);
  });

  it("ignores a structured Session that is idle, waiting or stopped", () => {
    expect(
      workingSessionCount(
        liveFleet([
          projectionWith("idle", [structuredAttachment()]),
          projectionWith("stopped", [structuredAttachment()], {
            turnActive: true,
            stopped: { at: 3, reason: null, by: { kind: "user" } },
          }),
        ]),
      ),
    ).toBe(0);
  });

  // The Session being started has a record before its environment is
  // assembled; counting it would make a Session alone on the machine share
  // the cores with itself.
  it("excludes the Session whose start this is", () => {
    expect(
      workingSessionCount({
        ...liveFleet([liveTerminal("mine"), liveTerminal("theirs")]),
        excludeSessionId: "mine",
      }),
    ).toBe(1);
  });

  // VC-1085: an open attachment is a resumable binding, not a running
  // executor. A chat whose turn the ledger still calls open, or a terminal
  // whose attachment was never closed, counts only while this process holds
  // its executor.
  it("counts nothing whose executor this process does not hold", () => {
    const projections = [liveTerminal("terminal"), workingChat("chat")];
    expect(workingSessionCount({ projections, live: NOTHING_LIVE })).toBe(0);
    // The chat's binding held, the terminal's PTY not running.
    expect(
      workingSessionCount({
        projections,
        live: { ...NOTHING_LIVE, boundAttachmentIds: new Set(["structured"]) },
      }),
    ).toBe(1);
    // The terminal's PTY running, the chat's binding not held.
    expect(
      workingSessionCount({
        projections,
        live: { ...NOTHING_LIVE, terminalSessionIds: new Set(["terminal"]) },
      }),
    ).toBe(1);
  });

  // Matched the way the listing rows match (`executorBound`): a binding held
  // for an attachment the Session has since moved past does not make its
  // newest attachment live.
  it("matches a chat on its latest structured attachment, not its Session id", () => {
    const superseded = { ...structuredAttachment(), id: "older", status: "closed" as const };
    const chat = projectionWith("chat", [superseded, structuredAttachment()], {
      turnActive: true,
    });
    expect(
      workingSessionCount({
        projections: [chat],
        live: { terminalSessionIds: new Set(["chat"]), boundAttachmentIds: new Set(["older"]) },
      }),
    ).toBe(0);
  });
});

describe("sessionConcurrencyEnv", () => {
  // The ticket's acceptance case, end to end: a Session started while four
  // others are working on an 8-core machine.
  it("gives a fifth Session on an 8-core machine a budget of two", () => {
    const env = sessionConcurrencyEnv({
      ...liveFleet(["a", "b", "c", "d"].map((id) => liveTerminal(id))),
      excludeSessionId: "mine",
      environment: {},
      cores: 8,
    });
    expect(env["VOLLI_CONCURRENCY_HINT"]).toBe("2");
    expect(env["CARGO_BUILD_JOBS"]).toBe("2");
    expect(env["VITEST_MAX_WORKERS"]).toBe("2");
    expect(env["MAKEFLAGS"]).toBe("-j2");
  });

  it("gives a Session alone on the machine every core", () => {
    const env = sessionConcurrencyEnv({ ...liveFleet([]), environment: {}, cores: 8 });
    expect(env["VOLLI_CONCURRENCY_HINT"]).toBe("8");
  });

  // The other half of the acceptance list: a user with MAKEFLAGS=-j16 in their
  // login shell keeps it, untouched and unmerged.
  it("never overwrites a variable the user's own environment defines", () => {
    const env = sessionConcurrencyEnv({
      ...liveFleet([liveTerminal("a"), liveTerminal("b")]),
      environment: { MAKEFLAGS: "-j16", GOFLAGS: "-mod=vendor" },
      cores: 8,
    });
    expect(env["MAKEFLAGS"]).toBeUndefined();
    expect(env["GOFLAGS"]).toBeUndefined();
    expect(env["CARGO_BUILD_JOBS"]).toBe("4");
  });

  // Volli's own previous answer is not a user value: the app is routinely
  // launched from a terminal inside another Volli Session.
  it("recomputes over an inherited hint instead of preserving it", () => {
    const env = sessionConcurrencyEnv({
      ...liveFleet([liveTerminal("a")]),
      environment: { VOLLI_CONCURRENCY_HINT: "7" },
      cores: 8,
    });
    expect(env["VOLLI_CONCURRENCY_HINT"]).toBe("8");
  });

  it("reads this host's core count when none is supplied", () => {
    const env = sessionConcurrencyEnv({ ...liveFleet([]), environment: {} });
    expect(Number.parseInt(env["VOLLI_CONCURRENCY_HINT"] ?? "0", 10)).toBeGreaterThanOrEqual(1);
  });
});

/**
 * A ports double over a scriptable live fleet: every Session the script
 * currently returns is running here (a turn open on a held binding, or a PTY),
 * and `getSession` folds each to the projection it returned. Each read of the
 * live executors is one `reads` call.
 */
function fakePorts(fleet: () => readonly SessionProjection[]) {
  const reads = vi.fn(() => fleet());
  let folds = new Map<string, SessionProjection>();
  const getSession = vi.fn(
    async ({ sessionId }: { sessionId: string }) => folds.get(sessionId) ?? null,
  );
  const ports: SessionConcurrencyPorts = {
    liveExecutors: () => {
      const projections = reads();
      folds = new Map(projections.map((projection) => [projection.session.id, projection]));
      return allLive(projections);
    },
    getSession,
  };
  return { ports, reads, getSession };
}

/** Live executors naming these candidates as mid-turn chats, every attachment bound. */
function turnsOn(...sessionIds: string[]): LiveExecutors {
  return { ...NOTHING_LIVE, turnSessionIds: new Set(sessionIds) };
}

describe("createSessionConcurrencyEnvReader", () => {
  it("uses the host clock and default TTL when no options are supplied", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    try {
      const fake = fakePorts(() => [liveTerminal("a")]);
      const reader = createSessionConcurrencyEnvReader(fake.ports);
      await reader({ environment: {}, cores: 8 });
      clock.mockReturnValue(6001);
      await reader({ environment: {}, cores: 8 });
      expect(fake.reads).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });

  it("counts the live Sessions of every project on the machine, from one read", async () => {
    // Unscoped by design: load is a fact about the machine, so Sessions from
    // two projects arrive together and are counted together.
    const fake = fakePorts(() => [liveTerminal("a"), liveTerminal("b"), workingChat("c")]);
    const reader = createSessionConcurrencyEnvReader(fake.ports, { now: () => 0 });

    const env = await reader({ environment: {}, cores: 9 });

    expect(env["VOLLI_CONCURRENCY_HINT"]).toBe("3");
    expect(fake.reads).toHaveBeenCalledTimes(1);
  });

  // VC-1085: the read is the size of what is running. A profile with
  // thousands of resumable (open, unbound) attachments folds none of them, and
  // neither do the idle bindings this process has held since launch.
  it("folds only the Sessions running something, never idle held bindings", async () => {
    const working = workingChat("mid-turn");
    const getSession = vi.fn(async ({ sessionId }: { sessionId: string }) =>
      sessionId === working.session.id ? working : null,
    );
    const idleBindings = Array.from({ length: 200 }, (_, index) => `idle-${index}`);
    const reader = createSessionConcurrencyEnvReader(
      {
        liveExecutors: () => ({
          ...turnsOn("mid-turn"),
          boundAttachmentIds: new Set(["structured", ...idleBindings]),
        }),
        getSession,
      },
      { now: () => 0 },
    );

    expect((await reader({ environment: {}, cores: 8 }))["VOLLI_CONCURRENCY_HINT"]).toBe("8");
    expect(getSession.mock.calls).toEqual([[{ sessionId: "mid-turn" }]]);
  });

  it("folds nothing for any number of idle held bindings", async () => {
    const getSession = vi.fn(async () => null);
    const reader = createSessionConcurrencyEnvReader(
      {
        liveExecutors: () => ({
          ...NOTHING_LIVE,
          boundAttachmentIds: new Set(Array.from({ length: 500 }, (_, index) => `idle-${index}`)),
        }),
        getSession,
      },
      { now: () => 0 },
    );

    expect((await reader({ environment: {}, cores: 8 }))["VOLLI_CONCURRENCY_HINT"]).toBe("8");
    expect(getSession).not.toHaveBeenCalled();
  });

  it("asks for nothing when no executor is live", async () => {
    const fake = fakePorts(() => []);
    const reader = createSessionConcurrencyEnvReader(fake.ports, { now: () => 0 });

    expect((await reader({ environment: {}, cores: 8 }))["VOLLI_CONCURRENCY_HINT"]).toBe("8");
    expect(fake.getSession).not.toHaveBeenCalled();
  });

  // A binding released between the live read and its fold leaves nothing to fold.
  it("drops a live Session that is gone by the time it is folded", async () => {
    const reader = createSessionConcurrencyEnvReader(
      {
        liveExecutors: () => ({
          ...turnsOn("gone"),
          terminalSessionIds: new Set(["terminal"]),
        }),
        getSession: async ({ sessionId }) =>
          sessionId === "terminal" ? liveTerminal("terminal") : null,
      },
      { now: () => 0 },
    );

    expect((await reader({ environment: {}, cores: 8 }))["VOLLI_CONCURRENCY_HINT"]).toBe("8");
    expect(
      (await reader({ excludeSessionId: "other", environment: {}, cores: 8 }))[
        "VOLLI_CONCURRENCY_HINT"
      ],
    ).toBe("8");
  });

  // The precedence the listing shows a person, held through the cached reader
  // and not only through the pure count: a terminal that has exited outranks
  // whatever its chat half would have said, and a waiting chat is not working.
  it("keeps the terminal/chat precedence the listing uses", async () => {
    const fake = fakePorts(() => [
      liveTerminal("live-terminal"),
      // A terminal Session whose shell exited. It also carries a structured
      // attachment mid-turn, and the terminal half still decides.
      projectionWith("exited-terminal", [terminalAttachment("closed"), structuredAttachment()], {
        turnActive: true,
      }),
      workingChat("working-chat"),
      // Waiting outranks working: an agent that has asked a question is not
      // consuming the machine while it waits.
      projectionWith("waiting-chat", [structuredAttachment()], {
        turnActive: true,
        interactions: { active: [chatQuestion()], resolved: [] },
      }),
    ]);
    const reader = createSessionConcurrencyEnvReader(fake.ports, { now: () => 0 });

    // Two of the four count as working — the live terminal and the mid-turn
    // chat — so an 8-core machine divides by two.
    expect((await reader({ environment: {}, cores: 8 }))["VOLLI_CONCURRENCY_HINT"]).toBe("4");
  });

  it("runs one read for two calls inside the TTL", async () => {
    let clock = 0;
    const fake = fakePorts(() => [liveTerminal("a")]);
    const reader = createSessionConcurrencyEnvReader(fake.ports, {
      ttlMs: 5_000,
      now: () => clock,
    });

    await reader({ environment: {}, cores: 8 });
    clock += 1_000;
    await reader({ environment: {}, cores: 8 });

    expect(fake.reads).toHaveBeenCalledTimes(1);
    expect(fake.getSession).toHaveBeenCalledTimes(1);
  });

  it("runs a fresh read once the TTL has elapsed", async () => {
    let clock = 0;
    const fake = fakePorts(() => [liveTerminal("a")]);
    const reader = createSessionConcurrencyEnvReader(fake.ports, {
      ttlMs: 5_000,
      now: () => clock,
    });

    await reader({ environment: {}, cores: 8 });
    clock += 5_001;
    await reader({ environment: {}, cores: 8 });

    expect(fake.reads).toHaveBeenCalledTimes(2);
  });

  /**
   * The staleness the TTL buys, named rather than left to be discovered.
   *
   * A Session that started inside the window is not in the cached read, so the
   * next Session start does not count it. That is the deliberate trade the
   * module doc's "computed once, at Session start" already accepts — but it is
   * the direction that costs a machine rather than protects it, so it is
   * pinned here: if the window is ever widened, this test says what widening
   * it means.
   */
  it("does not count a Session that started inside the cache window", async () => {
    let clock = 0;
    const fleet: SessionProjection[] = [liveTerminal("first")];
    const reader = createSessionConcurrencyEnvReader(fakePorts(() => [...fleet]).ports, {
      ttlMs: 5_000,
      now: () => clock,
    });

    expect((await reader({ environment: {}, cores: 8 }))["VOLLI_CONCURRENCY_HINT"]).toBe("8");
    fleet.push(liveTerminal("second"));
    clock += 1_000;
    // Still 8: the second Session is working, but this start is answered from
    // the read taken before it existed.
    expect((await reader({ environment: {}, cores: 8 }))["VOLLI_CONCURRENCY_HINT"]).toBe("8");
    clock += 4_001;
    // Once the window closes, the machine is described as it is.
    expect((await reader({ environment: {}, cores: 8 }))["VOLLI_CONCURRENCY_HINT"]).toBe("4");
  });

  it("shares one in-flight read across concurrent callers instead of running N", async () => {
    let resolveFold!: (value: SessionProjection) => void;
    const pending = new Promise<SessionProjection>((resolve) => {
      resolveFold = resolve;
    });
    const liveExecutors = vi.fn(() => ({
      ...NOTHING_LIVE,
      terminalSessionIds: new Set(["a", "b"]),
    }));
    const getSession = vi.fn(async ({ sessionId }: { sessionId: string }) =>
      sessionId === "a" ? pending : liveTerminal("b"),
    );
    const reader = createSessionConcurrencyEnvReader(
      { liveExecutors, getSession },
      { now: () => 0 },
    );

    const calls = [
      reader({ environment: {}, cores: 8 }),
      reader({ environment: {}, cores: 8 }),
      reader({ environment: {}, cores: 8 }),
    ];
    // Nothing has settled yet — every caller above joined the one read rather
    // than starting its own.
    expect(liveExecutors).toHaveBeenCalledTimes(1);
    resolveFold(liveTerminal("a"));
    const results = await Promise.all(calls);

    expect(liveExecutors).toHaveBeenCalledTimes(1);
    expect(getSession).toHaveBeenCalledTimes(2);
    for (const env of results) expect(env["VOLLI_CONCURRENCY_HINT"]).toBe("4");
  });

  it("applies each caller's own exclusion against the one cached fleet", async () => {
    const fake = fakePorts(() => [liveTerminal("a"), liveTerminal("b")]);
    const reader = createSessionConcurrencyEnvReader(fake.ports, { now: () => 0 });

    // Same cached read, two different exclusions: one names a Session that is
    // actually in the fleet, the other names one that is not — so the counted
    // total differs even though nothing was read twice.
    const excludingA = await reader({ excludeSessionId: "a", environment: {}, cores: 8 });
    const excludingNobody = await reader({
      excludeSessionId: "not-in-the-fleet",
      environment: {},
      cores: 8,
    });

    expect(fake.reads).toHaveBeenCalledTimes(1);
    expect(excludingA["VOLLI_CONCURRENCY_HINT"]).toBe("8");
    expect(excludingNobody["VOLLI_CONCURRENCY_HINT"]).toBe("4");
  });

  // A Session that cannot be budgeted still starts: an unbudgeted Session is a
  // loaded machine, a Session that fails to start is a person unable to work.
  it("yields no variables on a failed read, and does not poison the cache", async () => {
    let calls = 0;
    const reader = createSessionConcurrencyEnvReader(
      {
        liveExecutors: () => ({ ...NOTHING_LIVE, terminalSessionIds: new Set(["a"]) }),
        getSession: async () => {
          calls += 1;
          if (calls === 1) throw new Error("ledger is closed");
          return liveTerminal("a");
        },
      },
      { now: () => 0 },
    );

    expect(await reader({ environment: {}, cores: 8 })).toEqual({});
    // The failure was not cached as "no one is working": the next call
    // retries the read rather than serving a poisoned empty answer.
    const recovered = await reader({ excludeSessionId: "mine", environment: {}, cores: 8 });
    expect(recovered["VOLLI_CONCURRENCY_HINT"]).toBe("8");
    expect(calls).toBe(2);
  });
});
