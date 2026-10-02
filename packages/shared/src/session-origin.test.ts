import { describe, expect, it } from "vite-plus/test";
import { formatSessionOrigin, readSessionOrigin, sessionOriginFromActor } from "./session-origin";

describe("sessionOriginFromActor", () => {
  it("defaults an absent door actor to the user and preserves a Session's identity", () => {
    expect(sessionOriginFromActor(undefined)).toEqual({ kind: "user" });
    expect(sessionOriginFromActor({ kind: "user" })).toEqual({ kind: "user" });
    expect(
      sessionOriginFromActor({ kind: "session", sessionId: "parent", ticketId: "ticket" }),
    ).toEqual({
      kind: "session",
      sessionId: "parent",
    });
  });
  it("does not invent a Run or credit unauthenticated callers to a person", () => {
    expect(sessionOriginFromActor({ kind: "automation" })).toBeUndefined();
    expect(
      sessionOriginFromActor({ kind: "automation", sessionId: "runner", ticketId: null }),
    ).toBeUndefined();
    expect(sessionOriginFromActor({ kind: "unauthenticated" })).toBeUndefined();
  });
});

describe("formatSessionOrigin", () => {
  it("never credits legacy unknown attribution to a person", () => {
    expect(formatSessionOrigin(null)).toBe("an unknown origin");
    expect(formatSessionOrigin({ kind: "user" })).toBe("the user");
  });
  it("names a Session with its short handle", () => {
    expect(formatSessionOrigin({ kind: "session", sessionId: "123456789" })).toBe(
      "Session 12345678",
    );
  });
  it("names a Run even for an unbound Automation, and quotes names on one line", () => {
    expect(
      formatSessionOrigin({
        kind: "automation",
        automationRunId: "123456789",
        automationName: null,
      }),
    ).toBe("Automation (run 12345678)");
    expect(
      formatSessionOrigin({
        kind: "automation",
        automationRunId: "123456789",
        automationName: 'Review\n"code"',
      }),
    ).toBe('Automation "Review\\n\\"code\\"" (run 12345678)');
  });
  it("names host work without impersonating a person", () => {
    expect(formatSessionOrigin({ kind: "volli", reason: "watch-notice" })).toBe(
      "Volli (watch-notice)",
    );
  });
});

describe("readSessionOrigin", () => {
  it("accepts only the shared vocabulary", () => {
    for (const origin of [
      { kind: "user" },
      { kind: "session", sessionId: "parent" },
      { kind: "automation", automationRunId: "run", automationName: "Review" },
      { kind: "automation", automationRunId: "run", automationName: null },
      { kind: "volli", reason: "watch-notice" },
    ])
      expect(readSessionOrigin(origin)).toEqual(origin);
    for (const bad of [
      null,
      undefined,
      "user",
      {},
      { kind: "session" },
      { kind: "automation" },
      { kind: "automation", automationRunId: "run" },
      { kind: "automation", automationRunId: "run", automationName: 12 },
      { kind: "volli", reason: "unknown" },
    ])
      expect(readSessionOrigin(bad)).toBeNull();
  });
});
