import { describe, expect, test } from "vite-plus/test";

import {
  MalformedActorError,
  actorUserId,
  readActor,
  type Actor,
  type UnknownActor,
} from "./actor";
import type { UserId } from "./ids";

const USER = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const TICKET = "33333333-3333-4333-8333-333333333333";
const RUNNER = "44444444-4444-4444-8444-444444444444";

describe("readActor: known arms round-trip", () => {
  const actors: unknown[] = [
    { kind: "person", userId: USER },
    { kind: "person", userId: USER, via: "desktop" },
    { kind: "agent", userId: USER, sessionId: SESSION },
    { kind: "agent", userId: USER, sessionId: SESSION, ticketId: TICKET },
    { kind: "agent", userId: USER, sessionId: SESSION, ticketId: null },
    { kind: "automation", userId: USER, automationId: "auto-1", runId: "run-1" },
    {
      kind: "automation",
      userId: USER,
      automationId: "auto-1",
      runId: "run-1",
      sessionId: SESSION,
    },
    { kind: "volli", reason: "retention" },
    { kind: "volli", reason: "merge_watch", onBehalfOf: USER, runnerId: RUNNER },
    { kind: "legacy", was: "unauthenticated" },
    { kind: "legacy", was: "session", sessionId: "not-a-uuid-local-id" },
  ];
  test.each(actors)("%o", (actor) => {
    expect(readActor(actor)).toEqual(actor);
  });

  test("drops fields this build does not know", () => {
    expect(readActor({ kind: "person", userId: USER, futureField: 1 })).toEqual({
      kind: "person",
      userId: USER,
    });
  });
});

describe("readActor: open on read", () => {
  test("an unknown arm reads as Unknown", () => {
    expect(readActor({ kind: "robot", id: 1 })).toEqual({
      kind: "unknown",
      storedKind: "robot",
      userId: null,
    });
    expect(readActor({ kind: "robot", userId: USER })).toMatchObject({ userId: USER });
    expect(readActor({ kind: "robot", userId: "x", onBehalfOf: USER })).toMatchObject({
      userId: USER,
    });
  });

  test("an unknown Volli reason reads as Unknown rather than a guessed reason", () => {
    expect(readActor({ kind: "volli", reason: "new_machinery", onBehalfOf: USER })).toEqual({
      kind: "unknown",
      storedKind: "volli",
      userId: USER,
    });
  });

  test("an unknown client kind reads as an unnamed client", () => {
    expect(readActor({ kind: "person", userId: USER, via: "watch" })).toEqual({
      kind: "person",
      userId: USER,
    });
  });
});

describe("readActor: a malformed known arm is corruption", () => {
  const malformed: [string, unknown][] = [
    ["not an object", "person"],
    ["null", null],
    ["an array", [{ kind: "person" }]],
    ["no kind", {}],
    ["a non-string kind", { kind: 3 }],
    ["person without a user id", { kind: "person" }],
    ["person with a bad user id", { kind: "person", userId: "alice" }],
    ["person with a non-string via", { kind: "person", userId: USER, via: 1 }],
    ["agent without a session", { kind: "agent", userId: USER }],
    [
      "agent with a bad ticket",
      { kind: "agent", userId: USER, sessionId: SESSION, ticketId: "VC-1" },
    ],
    ["automation without a run", { kind: "automation", userId: USER, automationId: "a" }],
    [
      "automation with an empty id",
      { kind: "automation", userId: USER, automationId: "", runId: "r" },
    ],
    [
      "automation with a bad session",
      { kind: "automation", userId: USER, automationId: "a", runId: "r", sessionId: 1 },
    ],
    ["volli without a reason", { kind: "volli" }],
    ["volli with a bad runner", { kind: "volli", reason: "retention", runnerId: "hp-mac" }],
    ["legacy with an unknown token", { kind: "legacy", was: "robot" }],
    ["legacy with a non-string session", { kind: "legacy", was: "session", sessionId: 1 }],
  ];
  test.each(malformed)("%s", (_label, value) => {
    expect(() => readActor(value)).toThrow(MalformedActorError);
  });

  test("the error is typed", () => {
    expect(() => readActor({ kind: "person" })).toThrow(
      expect.objectContaining({ code: "malformed_actor", name: "MalformedActorError" }),
    );
  });
});

describe("actorUserId", () => {
  test("names the person a fact is attributed to, or nobody", () => {
    const cases: [Actor | UnknownActor, string | null][] = [
      [{ kind: "person", userId: USER } as Actor, USER],
      [{ kind: "agent", userId: USER, sessionId: SESSION } as Actor, USER],
      [{ kind: "automation", userId: USER, automationId: "a", runId: "r" } as Actor, USER],
      [{ kind: "volli", reason: "retention", onBehalfOf: USER } as Actor, USER],
      [{ kind: "volli", reason: "retention" }, null],
      [{ kind: "legacy", was: "user" }, null],
      [{ kind: "unknown", storedKind: "robot", userId: null }, null],
      [{ kind: "unknown", storedKind: "robot", userId: USER as UserId }, USER],
    ];
    for (const [actor, expected] of cases) expect(actorUserId(actor)).toBe(expected);
  });
});
