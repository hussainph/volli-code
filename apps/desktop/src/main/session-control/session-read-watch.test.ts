import { describe, expect, it, vi } from "vite-plus/test";
import { EMPTY_SESSION_USAGE_SUMMARY } from "@volli/shared";
import type { SessionProjection, SessionTurnOutcome } from "@volli/shared";

import { createSessionReadWatch, type SessionReadWatchPorts } from "./session-read-watch";

function projection(overrides: Partial<SessionProjection> = {}): SessionProjection {
  return {
    session: {
      id: "session-1",
      projectId: "project-1",
      ticketId: "ticket-1",
      role: "ticket",
      parentSessionId: null,
      title: "Plan the migration",
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
    attachments: [],
    liveExecutor: null,
    attention: { active: [], primary: null },
    interactions: { active: [], resolved: [] },
    signal: null,
    stopped: null,
    turnActive: false,
    lastTurnOutcome: null,
    authorityDenials: 0,
    usage: EMPTY_SESSION_USAGE_SUMMARY,
    lastActivityAt: 1,
    bornTicketless: false,
    modelSelection: null,
    modelTier: null,
    ...overrides,
  };
}

/** A Session mid-turn, and the same Session once that turn has landed. */
function working(sessionId = "session-1"): SessionProjection {
  return projection({
    session: { ...projection().session, id: sessionId },
    turnActive: true,
    lastActivityAt: 100,
  });
}

function finished(
  outcome: SessionTurnOutcome = "completed",
  sessionId = "session-1",
  at = 200,
): SessionProjection {
  return projection({
    session: { ...projection().session, id: sessionId },
    turnActive: false,
    lastTurnOutcome: outcome,
    lastActivityAt: at,
  });
}

function watchWith(overrides: Partial<SessionReadWatchPorts> = {}) {
  const markUnread = vi.fn<(sessionId: string, at: number) => void>();
  const markRead = vi.fn<(sessionId: string) => void>();
  const focused = new Set<string>();
  const watch = createSessionReadWatch({
    focusedSessionIds: () => focused,
    markUnread,
    markRead,
    ...overrides,
  });
  return { watch, markUnread, markRead, focused };
}

describe("createSessionReadWatch — the unread edge", () => {
  it("seeds silently on the first sighting of a Session it did not mint", () => {
    const { watch, markUnread } = watchWith();

    // A relaunch's first fold of a Session that finished yesterday. Nothing
    // about it is an edge this process watched.
    watch.observe(finished());

    expect(markUnread).not.toHaveBeenCalled();
  });

  it("marks a turn that ended while the Session was not in front", () => {
    const { watch, markUnread } = watchWith();

    watch.observe(working());
    watch.observe(finished());

    // The Session's own clock, not the fold's.
    expect(markUnread).toHaveBeenCalledExactlyOnceWith("session-1", 200);
  });

  it("says nothing when the Session is in front of a focused window", () => {
    const { watch, markUnread, focused } = watchWith();
    focused.add("session-1");

    watch.observe(working());
    watch.observe(finished());

    expect(markUnread).not.toHaveBeenCalled();
  });

  it("does not fire while a turn is still running", () => {
    const { watch, markUnread } = watchWith();

    watch.observe(working());
    watch.observe(working());

    expect(markUnread).not.toHaveBeenCalled();
  });

  it("counts an interrupted turn as an end", () => {
    const { watch, markUnread } = watchWith();

    watch.observe(working());
    watch.observe(finished("interrupted"));

    expect(markUnread).toHaveBeenCalledExactlyOnceWith("session-1", 200);
  });

  it("fires once per turn, not once per fold", () => {
    const { watch, markUnread } = watchWith();
    watch.observe(working());
    watch.observe(finished());

    // A later fold that changes nothing about the turn phase — a retitle, a
    // usage record — must not re-mark.
    watch.observe(finished());

    expect(markUnread).toHaveBeenCalledOnce();
  });

  it("fires again for the next turn", () => {
    const { watch, markUnread } = watchWith();
    watch.observe(working());
    watch.observe(finished("completed", "session-1", 200));

    watch.observe(working());
    watch.observe(finished("completed", "session-1", 400));

    expect(markUnread).toHaveBeenNthCalledWith(2, "session-1", 400);
    // Restamping is refused by the repo, not here: this watch reports the edge
    // it saw and `markSessionUnread` keeps the first stamp.
    expect(markUnread).toHaveBeenCalledTimes(2);
  });

  it("never marks a terminal companion, which has no turns to end", () => {
    const { watch, markUnread } = watchWith();
    // Output, a rename, an exit: a PTY's whole life leaves `turnActive` false
    // and `lastTurnOutcome` null, so no fold of it can be an edge.
    watch.observe(projection({ lastActivityAt: 100 }));
    watch.observe(projection({ lastActivityAt: 200 }));

    expect(markUnread).not.toHaveBeenCalled();
  });

  it("treats a Session it minted as a watched baseline", () => {
    const { watch, markUnread } = watchWith();

    watch.observeBirth("session-1");
    // The create and the failing turn landed inside one coalescing window, so
    // the first FOLD already shows a finished turn. It is still a real edge,
    // because a Session that did not exist a moment ago had no turn.
    watch.observe(finished("failed"));

    expect(markUnread).toHaveBeenCalledExactlyOnceWith("session-1", 200);
  });

  it("never lets a replayed birth rewrite a live phase", () => {
    const { watch, markUnread } = watchWith();
    watch.observe(working());

    watch.observeBirth("session-1");
    watch.observe(finished());

    expect(markUnread).toHaveBeenCalledExactlyOnceWith("session-1", 200);
  });

  it("keeps one phase per Session", () => {
    const { watch, markUnread } = watchWith();

    watch.observe(working("a"));
    watch.observe(working("b"));
    watch.observe(finished("completed", "b", 300));

    expect(markUnread).toHaveBeenCalledExactlyOnceWith("b", 300);
  });

  it("swallows a port failure through the diagnostics seam", () => {
    const onError = vi.fn();
    const { watch } = watchWith({
      markUnread: () => {
        throw new Error("receipt refused");
      },
      onError,
    });

    watch.observe(working());
    expect(() => watch.observe(finished())).not.toThrow();

    expect(onError).toHaveBeenCalledOnce();
  });

  it("reports a failure through console.warn when given no seam", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { watch } = watchWith({
      markUnread: () => {
        throw new Error("receipt refused");
      },
    });

    watch.observe(working());
    watch.observe(finished());

    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe("createSessionReadWatch — viewing clears unread (A1)", () => {
  it("reads every Session that came into view", () => {
    const { watch, markRead } = watchWith();

    watch.observeFocused(new Set(["a", "b"]));

    expect(markRead).toHaveBeenNthCalledWith(1, "a");
    expect(markRead).toHaveBeenNthCalledWith(2, "b");
  });

  it("does nothing when no focused window is showing a Session", () => {
    const { watch, markRead } = watchWith();

    watch.observeFocused(new Set());

    expect(markRead).not.toHaveBeenCalled();
  });

  it("swallows a failure while reading", () => {
    const onError = vi.fn();
    const { watch } = watchWith({
      markRead: () => {
        throw new Error("publish refused");
      },
      onError,
    });

    expect(() => watch.observeFocused(new Set(["a"]))).not.toThrow();

    expect(onError).toHaveBeenCalledOnce();
  });

  it("keeps reading the rest when one Session's receipt throws", () => {
    const onError = vi.fn();
    const read: string[] = [];
    const { watch } = watchWith({
      markRead: (sessionId: string) => {
        if (sessionId === "b") throw new Error("publish refused");
        read.push(sessionId);
      },
      onError,
    });

    watch.observeFocused(new Set(["a", "b", "c"]));

    // "c" is the point: a throw for "b" used to abandon the loop, leaving a
    // Session the person is looking at marked unread.
    expect(read).toEqual(["a", "c"]);
    expect(onError).toHaveBeenCalledOnce();
  });
});
