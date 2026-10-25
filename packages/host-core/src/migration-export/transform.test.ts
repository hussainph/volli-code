import { describe, expect, it } from "vite-plus/test";
import {
  MIGRATION_DERIVED_ID_NAMESPACE,
  configEntryId,
  derivedId,
  lastPathSegment,
  parseColumnActor,
  parseJsonColumn,
  parseLocalActor,
  primaryRepoId,
  pullRequestNumber,
  sequentialPositionKey,
  toActor,
  workingCopyId,
  type ActorContext,
} from "./transform";

const noRuns: ActorContext = { automationRunOf: () => undefined };
const withRun: ActorContext = {
  automationRunOf: (sessionId) =>
    sessionId === "s-auto" ? { automationId: "auto-1", runId: "run-1" } : undefined,
};

describe("parseLocalActor", () => {
  it("reads the bare tokens", () => {
    expect(parseLocalActor("user").kind).toBe("user");
    expect(parseLocalActor("automation").kind).toBe("automation");
    expect(parseLocalActor("session").kind).toBe("session");
    expect(parseLocalActor("unauthenticated").kind).toBe("unauthenticated");
  });

  it("reads the JSON forms with their context", () => {
    expect(parseLocalActor('{"kind":"session","sessionId":"s1","ticketId":"t1"}')).toEqual({
      kind: "session",
      sessionId: "s1",
      ticketId: "t1",
    });
    expect(parseLocalActor('{"kind":"automation","sessionId":"s1","ticketId":null}')).toEqual({
      kind: "automation",
      sessionId: "s1",
      ticketId: null,
    });
    expect(parseLocalActor('{"kind":"automation"}')).toEqual({
      kind: "automation",
      sessionId: null,
      ticketId: null,
    });
    expect(parseLocalActor('{"kind":"user"}').kind).toBe("user");
    expect(parseLocalActor('{"kind":"unauthenticated"}').kind).toBe("unauthenticated");
  });

  it("reads anything unrecognised as the user, as the app always has", () => {
    expect(parseLocalActor("agent:claude-code").kind).toBe("user");
    expect(parseLocalActor('{"kind":"robot"}').kind).toBe("user");
    expect(parseLocalActor("null").kind).toBe("user");
  });
});

describe("parseColumnActor", () => {
  it("carries the row's Session for session and harness authors", () => {
    expect(parseColumnActor("session", "s1")).toEqual({
      kind: "session",
      sessionId: "s1",
      ticketId: null,
    });
    expect(parseColumnActor("agent:claude-code", null)).toEqual({
      kind: "session",
      sessionId: null,
      ticketId: null,
    });
  });

  it("keeps automation and unauthenticated, and reads the rest as the user", () => {
    expect(parseColumnActor("automation", "s1").kind).toBe("automation");
    expect(parseColumnActor("unauthenticated", null).kind).toBe("unauthenticated");
    expect(parseColumnActor("user", "s1")).toEqual({
      kind: "user",
      sessionId: null,
      ticketId: null,
    });
    expect(parseColumnActor("something-else", null).kind).toBe("user");
  });
});

describe("toActor", () => {
  it("maps a person and an agent to the migrating person", () => {
    expect(toActor(parseLocalActor("user"), noRuns)).toEqual({
      kind: "person",
      userId: "$local-user",
    });
    expect(toActor({ kind: "session", sessionId: "s1", ticketId: "t1" }, noRuns)).toEqual({
      kind: "agent",
      userId: "$local-user",
      sessionId: "s1",
      ticketId: "t1",
    });
    expect(toActor({ kind: "session", sessionId: "s1", ticketId: null }, noRuns)).toEqual({
      kind: "agent",
      userId: "$local-user",
      sessionId: "s1",
    });
  });

  it("names an Automation when its Run started the Session", () => {
    expect(toActor({ kind: "automation", sessionId: "s-auto", ticketId: null }, withRun)).toEqual({
      kind: "automation",
      userId: "$local-user",
      automationId: "auto-1",
      runId: "run-1",
      sessionId: "s-auto",
    });
    expect(toActor({ kind: "automation", sessionId: "s-other", ticketId: null }, withRun)).toEqual({
      kind: "legacy",
      was: "automation",
      sessionId: "s-other",
    });
    const unbound: ActorContext = {
      automationRunOf: () => ({ automationId: null, runId: "run-2" }),
    };
    expect(toActor({ kind: "automation", sessionId: "s1", ticketId: null }, unbound)).toEqual({
      kind: "legacy",
      was: "automation",
      sessionId: "s1",
    });
  });

  it("attributes Volli's own machinery by event kind, and nothing else", () => {
    const system = { kind: "automation", sessionId: null, ticketId: null } as const;
    expect(toActor(system, { ...noRuns, eventKind: "pr_merged" })).toEqual({
      kind: "volli",
      reason: "merge_watch",
      onBehalfOf: "$local-user",
      runnerId: "$local-runner",
    });
    expect(toActor(system, { ...noRuns, eventKind: "worktree_reclaimed" })).toMatchObject({
      kind: "volli",
      reason: "retention",
    });
    expect(toActor(system, { ...noRuns, eventKind: "worktree_trimmed" })).toMatchObject({
      reason: "retention",
    });
    expect(toActor(system, { ...noRuns, eventKind: "worktree_changed" })).toEqual({
      kind: "legacy",
      was: "automation",
    });
    expect(toActor(system, noRuns)).toEqual({ kind: "legacy", was: "automation" });
  });

  it("keeps no-one-to-name actors legacy", () => {
    expect(toActor(parseLocalActor("unauthenticated"), noRuns)).toEqual({
      kind: "legacy",
      was: "unauthenticated",
    });
    expect(toActor(parseLocalActor("session"), noRuns)).toEqual({
      kind: "legacy",
      was: "session",
    });
  });
});

describe("sequentialPositionKey", () => {
  it("matches fractional-indexing's generateNKeysBetween(null, null, n)", () => {
    // Values produced by fractional-indexing 3.x for the same indices.
    expect(sequentialPositionKey(0)).toBe("a0");
    expect(sequentialPositionKey(1)).toBe("a1");
    expect(sequentialPositionKey(9)).toBe("a9");
    expect(sequentialPositionKey(10)).toBe("aA");
    expect(sequentialPositionKey(36)).toBe("aa");
    expect(sequentialPositionKey(61)).toBe("az");
    expect(sequentialPositionKey(62)).toBe("b00");
    expect(sequentialPositionKey(63)).toBe("b01");
    expect(sequentialPositionKey(62 + 3843)).toBe("bzz");
    expect(sequentialPositionKey(62 + 3844)).toBe("c000");
  });

  it("sorts in index order", () => {
    const keys = Array.from({ length: 5000 }, (_, index) => sequentialPositionKey(index));
    expect(keys.toSorted()).toEqual(keys);
  });

  it("refuses an index it cannot place", () => {
    expect(() => sequentialPositionKey(-1)).toThrow(RangeError);
    expect(() => sequentialPositionKey(1.5)).toThrow(RangeError);
    expect(() => sequentialPositionKey(2 ** 60)).toThrow(RangeError);
    expect(sequentialPositionKey(Number.MAX_SAFE_INTEGER)).toMatch(/^i[0-9A-Za-z]{9}$/);
  });
});

describe("derived ids", () => {
  it("are RFC 9562 UUIDv5 under the frozen namespace", () => {
    expect(MIGRATION_DERIVED_ID_NAMESPACE).toBe("5b0f6c0e-3c1f-4f7a-9c43-6f2a1d3e8b57");
    // Cross-checked against the `uuid` package's v5 for the same name.
    expect(primaryRepoId("proj-alpha")).toBe("1d88f805-4623-5a75-915f-a74fef4a6aa9");
    expect(derivedId("a")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("are stable per input and distinct across inputs", () => {
    expect(workingCopyId("t1")).toBe(workingCopyId("t1"));
    expect(workingCopyId("t1")).not.toBe(workingCopyId("t2"));
    expect(workingCopyId("t1")).not.toBe(primaryRepoId("t1"));
    expect(configEntryId("personal", "model_default", "defaults")).not.toBe(
      configEntryId("personal", "model_default", "default"),
    );
  });
});

describe("small helpers", () => {
  it("takes the last path segment", () => {
    expect(lastPathSegment("/Users/me/code/alpha")).toBe("alpha");
    expect(lastPathSegment("/Users/me/code/alpha/")).toBe("alpha");
    expect(lastPathSegment("C:\\code\\beta")).toBe("beta");
    expect(lastPathSegment("solo")).toBe("solo");
    expect(lastPathSegment("/")).toBe("/");
  });

  it("parses JSON columns leniently", () => {
    expect(parseJsonColumn('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonColumn("not json")).toBeUndefined();
  });

  it("reads a pull request number", () => {
    expect(pullRequestNumber("https://github.com/o/r/pull/9")).toBe(9);
    expect(pullRequestNumber("https://github.com/o/r/pull/12/files")).toBe(12);
    expect(pullRequestNumber("https://github.com/o/r/pull/12#x")).toBe(12);
    expect(pullRequestNumber("https://example.com/merge_requests/3")).toBeNull();
  });
});
