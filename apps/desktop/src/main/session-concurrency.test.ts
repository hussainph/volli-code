import { describe, expect, it } from "vite-plus/test";
import { EMPTY_SESSION_USAGE_SUMMARY } from "@volli/shared";
import type { SessionAttachmentProjection, SessionProjection } from "@volli/shared";

import { terminalNativeReference } from "./session-control";
import {
  readSessionConcurrencyEnv,
  sessionConcurrencyEnv,
  workingSessionCount,
} from "./session-concurrency";

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

describe("readSessionConcurrencyEnv", () => {
  it("counts the Sessions of every project on the machine", async () => {
    const asked: string[] = [];
    const env = await readSessionConcurrencyEnv(
      {
        listProjectIds: () => ["one", "two"],
        listSessions: async (projectId) => {
          asked.push(projectId);
          return projectId === "one" ? [liveTerminal("a")] : [liveTerminal("b"), workingChat("c")];
        },
      },
      { environment: {}, cores: 9 },
    );
    expect(asked).toEqual(["one", "two"]);
    expect(env["VOLLI_CONCURRENCY_HINT"]).toBe("3");
  });

  // A Session that cannot be budgeted still starts: an unbudgeted Session is a
  // loaded machine, a Session that fails to start is a person unable to work.
  it("yields no variables at all when the fleet cannot be counted", async () => {
    expect(
      await readSessionConcurrencyEnv(
        {
          listProjectIds: () => ["one"],
          listSessions: () => Promise.reject(new Error("ledger is closed")),
        },
        { environment: {}, cores: 8 },
      ),
    ).toEqual({});
  });
});
