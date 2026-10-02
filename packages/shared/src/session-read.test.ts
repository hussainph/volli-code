import { describe, expect, it } from "vite-plus/test";

import {
  isSessionUnread,
  SESSION_READ,
  sessionReadStateOf,
  sessionTurnPhaseOf,
  turnJustEnded,
  type SessionTurnPhase,
} from "./session-read";

const WORKING: SessionTurnPhase = { turnActive: true, lastTurnOutcome: null };
const DONE: SessionTurnPhase = { turnActive: false, lastTurnOutcome: "completed" };
const NEVER_RAN: SessionTurnPhase = { turnActive: false, lastTurnOutcome: null };

describe("SESSION_READ", () => {
  it("is the resting state and carries no stamp", () => {
    expect(SESSION_READ).toEqual({ unreadSince: null });
  });
});

describe("sessionReadStateOf", () => {
  it("answers the resting state for a row no receipt reader filled", () => {
    expect(sessionReadStateOf(undefined)).toBe(SESSION_READ);
  });

  it("keeps a receipt it was given", () => {
    const read = { unreadSince: 1_000 };
    expect(sessionReadStateOf(read)).toBe(read);
  });
});

describe("isSessionUnread", () => {
  it("is false for a sparse row and for an explicit read one", () => {
    expect(isSessionUnread(undefined)).toBe(false);
    expect(isSessionUnread({ unreadSince: null })).toBe(false);
  });

  it("is true once a stamp says when the work arrived", () => {
    expect(isSessionUnread({ unreadSince: 1_000 })).toBe(true);
  });
});

describe("turnJustEnded", () => {
  it("seeds silently: a first sighting is never an edge", () => {
    expect(turnJustEnded(null, DONE)).toBe(false);
    expect(turnJustEnded(null, WORKING)).toBe(false);
  });

  it("fires on the falling edge of a live turn", () => {
    expect(turnJustEnded(WORKING, DONE)).toBe(true);
  });

  it("counts an interrupted turn as an end, like a failed one", () => {
    expect(turnJustEnded(WORKING, { turnActive: false, lastTurnOutcome: "interrupted" })).toBe(
      true,
    );
    expect(turnJustEnded(WORKING, { turnActive: false, lastTurnOutcome: "failed" })).toBe(true);
  });

  it("does not fire while the turn is still running", () => {
    expect(turnJustEnded(WORKING, WORKING)).toBe(false);
  });

  it("does not re-fire when a new turn starts after an end", () => {
    expect(turnJustEnded(DONE, { turnActive: true, lastTurnOutcome: null })).toBe(false);
  });

  it("does not fire twice for one finished turn", () => {
    expect(turnJustEnded(DONE, DONE)).toBe(false);
  });

  it("sees a turn that started and ended between two sightings, by its new outcome", () => {
    expect(turnJustEnded(NEVER_RAN, DONE)).toBe(true);
    expect(turnJustEnded(DONE, { turnActive: false, lastTurnOutcome: "interrupted" })).toBe(true);
  });

  it("reports nothing for a resting Session that has never run a turn", () => {
    expect(turnJustEnded(NEVER_RAN, NEVER_RAN)).toBe(false);
  });
});

describe("sessionTurnPhaseOf", () => {
  it("reads exactly the two facts the edge is decided from", () => {
    expect(sessionTurnPhaseOf({ turnActive: false, lastTurnOutcome: "completed" })).toEqual(DONE);
  });
});
