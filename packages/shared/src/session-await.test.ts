import { describe, expect, it } from "vite-plus/test";

import {
  isSessionAwaitFor,
  MAX_SESSION_AWAIT_TARGETS,
  parseSessionAwaitTargets,
  SESSION_AWAIT_EVENT_KINDS,
  SESSION_AWAIT_FOR,
  SESSION_AWAIT_KINDS,
  SESSION_AWAIT_PLANNED_KINDS,
  sessionAwaitEventKinds,
  sessionAwaitKindsFor,
} from "./session-await";
import { MAX_TICKET_AWAIT_TARGETS } from "./ticket-await";

describe("the Session await vocabulary", () => {
  it("offers every await kind plus any, and nothing else", () => {
    expect(SESSION_AWAIT_FOR).toEqual([...SESSION_AWAIT_KINDS, "any"]);
  });

  it("wakes a turn wait on both turn endings, so an interruption is never silent", () => {
    // The whole point of the ticket that added this: four children were
    // interrupted by a host outage and the parent could only learn it from a
    // steered notice. `turn.interrupted` is a wake, not a missing wake.
    expect(SESSION_AWAIT_EVENT_KINDS.turn).toEqual(["turn.completed", "turn.interrupted"]);
    expect(SESSION_AWAIT_EVENT_KINDS.verdict).toEqual(["session.signaled"]);
    expect(SESSION_AWAIT_EVENT_KINDS.stopped).toEqual(["session.stopped"]);
  });

  it("gives every await kind at least one Session Event kind to wake on", () => {
    for (const kind of SESSION_AWAIT_KINDS) {
      expect(SESSION_AWAIT_EVENT_KINDS[kind].length).toBeGreaterThan(0);
    }
  });

  it("keeps Phase 2's kinds out of the vocabulary it declares them beside", () => {
    // Declared so they slot in, implemented nowhere: a `for` value the handler
    // cannot wake on would park a turn until its timeout with nothing to say.
    for (const planned of SESSION_AWAIT_PLANNED_KINDS) {
      expect(SESSION_AWAIT_FOR).not.toContain(planned);
      expect(isSessionAwaitFor(planned)).toBe(false);
    }
    expect(SESSION_AWAIT_PLANNED_KINDS).toEqual(["question", "trouble"]);
  });

  it("bounds one wait at the same fleet size a ticket wait allows", () => {
    expect(MAX_SESSION_AWAIT_TARGETS).toBe(MAX_TICKET_AWAIT_TARGETS);
  });
});

describe("isSessionAwaitFor", () => {
  it("admits the whole for vocabulary", () => {
    for (const value of SESSION_AWAIT_FOR) {
      expect(isSessionAwaitFor(value)).toBe(true);
    }
  });

  it("refuses a word outside it, and anything that is not a string", () => {
    expect(isSessionAwaitFor("turn.completed")).toBe(false);
    expect(isSessionAwaitFor("signal")).toBe(false);
    expect(isSessionAwaitFor(42)).toBe(false);
    expect(isSessionAwaitFor(undefined)).toBe(false);
  });
});

describe("sessionAwaitKindsFor", () => {
  it("reads any as the union of the whole vocabulary, not as a fourth kind", () => {
    expect(sessionAwaitKindsFor("any")).toEqual([...SESSION_AWAIT_KINDS]);
  });

  it("reads one kind as itself", () => {
    expect(sessionAwaitKindsFor("verdict")).toEqual(["verdict"]);
  });
});

describe("sessionAwaitEventKinds", () => {
  it("flattens the whole vocabulary into the kinds one query filters on", () => {
    expect(sessionAwaitEventKinds([...SESSION_AWAIT_KINDS])).toEqual([
      "turn.completed",
      "turn.interrupted",
      "session.signaled",
      "session.stopped",
    ]);
  });

  it("de-duplicates, so one event kind never enters a query twice", () => {
    expect(sessionAwaitEventKinds(["turn", "turn"])).toEqual([
      "turn.completed",
      "turn.interrupted",
    ]);
  });

  it("answers an empty ask with nothing to filter on", () => {
    expect(sessionAwaitEventKinds([])).toEqual([]);
  });
});

describe("parseSessionAwaitTargets", () => {
  it("splits on spaces, commas, and any mix of the two", () => {
    expect(parseSessionAwaitTargets("a1b2c3d4 e5f6a7b8")).toEqual(["a1b2c3d4", "e5f6a7b8"]);
    expect(parseSessionAwaitTargets("a1b2c3d4,e5f6a7b8")).toEqual(["a1b2c3d4", "e5f6a7b8"]);
    expect(parseSessionAwaitTargets("a1b2c3d4, e5f6a7b8 ,c9d0e1f2")).toEqual([
      "a1b2c3d4",
      "e5f6a7b8",
      "c9d0e1f2",
    ]);
  });

  it("drops empty tokens and de-duplicates, so one handle twice is one Session", () => {
    expect(parseSessionAwaitTargets("  a1b2c3d4,, a1b2c3d4  ")).toEqual(["a1b2c3d4"]);
    expect(parseSessionAwaitTargets("   ")).toEqual([]);
  });
});
