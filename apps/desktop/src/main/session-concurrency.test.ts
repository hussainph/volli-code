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
import type { SessionConcurrencyPorts } from "./session-concurrency";

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
    authorityDenials: 0,
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

describe("workingSessionCount", () => {
  it("counts live terminal Sessions and structured Sessions mid-turn", () => {
    expect(
      workingSessionCount({
        projections: [liveTerminal("a"), workingChat("b"), liveTerminal("c")],
      }),
    ).toBe(3);
  });

  it("ignores a terminal Session whose shell has exited", () => {
    expect(
      workingSessionCount({ projections: [projectionWith("a", [terminalAttachment("closed")])] }),
    ).toBe(0);
  });

  it("ignores a structured Session that is idle, waiting or stopped", () => {
    expect(
      workingSessionCount({
        projections: [
          projectionWith("idle", [structuredAttachment()]),
          projectionWith("stopped", [structuredAttachment()], {
            turnActive: true,
            stopped: { at: 3, reason: null, by: { kind: "user" } },
          }),
        ],
      }),
    ).toBe(0);
  });

  // The Session being started has a record before its environment is
  // assembled; counting it would make a Session alone on the machine share
  // the cores with itself.
  it("excludes the Session whose start this is", () => {
    expect(
      workingSessionCount({
        projections: [liveTerminal("mine"), liveTerminal("theirs")],
        excludeSessionId: "mine",
      }),
    ).toBe(1);
  });
});

describe("sessionConcurrencyEnv", () => {
  // The ticket's acceptance case, end to end: a Session started while four
  // others are working on an 8-core machine.
  it("gives a fifth Session on an 8-core machine a budget of two", () => {
    const env = sessionConcurrencyEnv({
      projections: ["a", "b", "c", "d"].map((id) => liveTerminal(id)),
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
    const env = sessionConcurrencyEnv({ projections: [], environment: {}, cores: 8 });
    expect(env["VOLLI_CONCURRENCY_HINT"]).toBe("8");
  });

  // The other half of the acceptance list: a user with MAKEFLAGS=-j16 in their
  // login shell keeps it, untouched and unmerged.
  it("never overwrites a variable the user's own environment defines", () => {
    const env = sessionConcurrencyEnv({
      projections: [liveTerminal("a"), liveTerminal("b")],
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
      projections: [liveTerminal("a")],
      environment: { VOLLI_CONCURRENCY_HINT: "7" },
      cores: 8,
    });
    expect(env["VOLLI_CONCURRENCY_HINT"]).toBe("8");
  });

  it("reads this host's core count when none is supplied", () => {
    const env = sessionConcurrencyEnv({ projections: [], environment: {} });
    expect(Number.parseInt(env["VOLLI_CONCURRENCY_HINT"] ?? "0", 10)).toBeGreaterThanOrEqual(1);
  });
});

/** A ports double whose one narrow read is scriptable per test. */
function fakePorts(
  listAttachedSessions: () => Promise<readonly SessionProjection[]>,
): SessionConcurrencyPorts {
  return { listAttachedSessions };
}

describe("createSessionConcurrencyEnvReader", () => {
  it("counts the Sessions of every project on the machine, from one read", async () => {
    // The narrow read is unscoped by design: load is a fact about the machine,
    // so Sessions from two projects arrive together and are counted together.
    const listAttachedSessions = vi.fn(async () => [
      liveTerminal("a"),
      liveTerminal("b"),
      workingChat("c"),
    ]);
    const reader = createSessionConcurrencyEnvReader(fakePorts(listAttachedSessions), {
      now: () => 0,
    });

    const env = await reader({ environment: {}, cores: 9 });

    expect(env["VOLLI_CONCURRENCY_HINT"]).toBe("3");
    expect(listAttachedSessions).toHaveBeenCalledTimes(1);
  });

  // The precedence the listing shows a person, held through the cached reader
  // and not only through the pure count: a terminal that has exited outranks
  // whatever its chat half would have said, and a waiting chat is not working.
  it("keeps the terminal/chat precedence the listing uses", async () => {
    const reader = createSessionConcurrencyEnvReader(
      fakePorts(async () => [
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
      ]),
      { now: () => 0 },
    );

    // Two of the four count as working — the live terminal and the mid-turn
    // chat — so an 8-core machine divides by two.
    expect((await reader({ environment: {}, cores: 8 }))["VOLLI_CONCURRENCY_HINT"]).toBe("4");
  });

  it("runs one read for two calls inside the TTL", async () => {
    let clock = 0;
    const listAttachedSessions = vi.fn(async () => [liveTerminal("a")]);
    const reader = createSessionConcurrencyEnvReader(fakePorts(listAttachedSessions), {
      ttlMs: 5_000,
      now: () => clock,
    });

    await reader({ environment: {}, cores: 8 });
    clock += 1_000;
    await reader({ environment: {}, cores: 8 });

    expect(listAttachedSessions).toHaveBeenCalledTimes(1);
  });

  it("runs a fresh read once the TTL has elapsed", async () => {
    let clock = 0;
    const listAttachedSessions = vi.fn(async () => [liveTerminal("a")]);
    const reader = createSessionConcurrencyEnvReader(fakePorts(listAttachedSessions), {
      ttlMs: 5_000,
      now: () => clock,
    });

    await reader({ environment: {}, cores: 8 });
    clock += 5_001;
    await reader({ environment: {}, cores: 8 });

    expect(listAttachedSessions).toHaveBeenCalledTimes(2);
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
    const reader = createSessionConcurrencyEnvReader(
      fakePorts(async () => [...fleet]),
      { ttlMs: 5_000, now: () => clock },
    );

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
    let resolveRead!: (value: readonly SessionProjection[]) => void;
    const pending = new Promise<readonly SessionProjection[]>((resolve) => {
      resolveRead = resolve;
    });
    const listAttachedSessions = vi.fn(() => pending);
    const reader = createSessionConcurrencyEnvReader(fakePorts(listAttachedSessions), {
      now: () => 0,
    });

    const calls = [
      reader({ environment: {}, cores: 8 }),
      reader({ environment: {}, cores: 8 }),
      reader({ environment: {}, cores: 8 }),
    ];
    // Nothing has settled yet — every caller above joined the one read rather
    // than starting its own.
    expect(listAttachedSessions).toHaveBeenCalledTimes(1);
    resolveRead([liveTerminal("a"), liveTerminal("b")]);
    const results = await Promise.all(calls);

    expect(listAttachedSessions).toHaveBeenCalledTimes(1);
    for (const env of results) expect(env["VOLLI_CONCURRENCY_HINT"]).toBe("4");
  });

  it("applies each caller's own exclusion against the one cached fleet", async () => {
    const listAttachedSessions = vi.fn(async () => [liveTerminal("a"), liveTerminal("b")]);
    const reader = createSessionConcurrencyEnvReader(fakePorts(listAttachedSessions), {
      now: () => 0,
    });

    // Same cached read, two different exclusions: one names a Session that is
    // actually in the fleet, the other names one that is not — so the counted
    // total differs even though nothing was read twice.
    const excludingA = await reader({ excludeSessionId: "a", environment: {}, cores: 8 });
    const excludingNobody = await reader({
      excludeSessionId: "not-in-the-fleet",
      environment: {},
      cores: 8,
    });

    expect(listAttachedSessions).toHaveBeenCalledTimes(1);
    expect(excludingA["VOLLI_CONCURRENCY_HINT"]).toBe("8");
    expect(excludingNobody["VOLLI_CONCURRENCY_HINT"]).toBe("4");
  });

  // A Session that cannot be budgeted still starts: an unbudgeted Session is a
  // loaded machine, a Session that fails to start is a person unable to work.
  it("yields no variables on a failed read, and does not poison the cache", async () => {
    let calls = 0;
    const listAttachedSessions = async (): Promise<readonly SessionProjection[]> => {
      calls += 1;
      if (calls === 1) throw new Error("ledger is closed");
      return [liveTerminal("a")];
    };
    const reader = createSessionConcurrencyEnvReader(fakePorts(listAttachedSessions), {
      now: () => 0,
    });

    expect(await reader({ environment: {}, cores: 8 })).toEqual({});
    // The failure was not cached as "no one is working": the next call
    // retries the read rather than serving a poisoned empty answer.
    const recovered = await reader({ environment: {}, cores: 8 });
    expect(recovered["VOLLI_CONCURRENCY_HINT"]).toBe("8");
    expect(calls).toBe(2);
  });
});
