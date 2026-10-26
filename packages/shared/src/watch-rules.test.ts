import { describe, expect, test } from "vite-plus/test";

import type { SessionEventPayload } from "./session-ledger";
import {
  sessionWatchChanges,
  ticketEventWatchActor,
  ticketWatchChanges,
  ticketWatchHears,
  type SessionWatchState,
} from "./watch-rules";

const WATCHER = "aaaaaaaa-0000-4000-8000-000000000000";
const TARGET = "bbbbbbbb-0000-4000-8000-000000000000";
const CHILD = "dddddddd-0000-4000-8000-000000000000";

const watch: SessionWatchState = {
  targetSessionId: TARGET,
  title: "Fix",
  kinds: ["turn", "verdict", "stopped"],
  turnArmed: true,
};
const ctx = { watcherSessionId: WATCHER, pendingChildren: [] as string[] };
const completed: SessionEventPayload = { kind: "turn.completed", attachmentId: "a", turnId: "t" };
const interrupted = {
  kind: "turn.interrupted",
  attachmentId: "a",
  turnId: "t",
} as SessionEventPayload;

const signal = (s: "done" | "blocked", reason: string | null): SessionEventPayload => ({
  kind: "session.signaled",
  signal: s,
  reason,
});
const stop = (by: Extract<SessionEventPayload, { kind: "session.stopped" }>["by"]) =>
  ({ kind: "session.stopped", reason: "done here", by }) as SessionEventPayload;
describe("sessionWatchChanges", () => {
  test("the next turn end reports once, with its last message still unread", () => {
    const step = sessionWatchChanges(completed, watch, { ...ctx, occurredAt: 7 });
    expect(step).toEqual({
      change: {
        subject: "session",
        sessionId: TARGET,
        title: "Fix",
        occurredAt: 7,
        fact: "turn-completed",
        pendingSubagents: [],
        lastMessage: { state: "unread" },
      },
      turnArmed: false,
      ended: false,
    });
    expect(sessionWatchChanges(completed, { ...watch, turnArmed: false }, ctx)).toEqual({
      change: null,
      turnArmed: false,
      ended: false,
    });
    expect(
      sessionWatchChanges(completed, { ...watch, kinds: new Set(["verdict"]) }, ctx).change,
    ).toBeNull();
  });

  test("a turn end with subagents pending is deferred and keeps the arm; an interruption is not", () => {
    const pending = { ...ctx, pendingChildren: [CHILD] };
    expect(sessionWatchChanges(completed, watch, pending)).toEqual({
      change: null,
      turnArmed: true,
      ended: false,
    });
    const step = sessionWatchChanges(interrupted, watch, pending);
    expect(step.turnArmed).toBe(false);
    expect(step.change).toMatchObject({
      fact: "turn-interrupted",
      pendingSubagents: [CHILD],
      stopDetail: null,
      lastMessage: { state: "unread" },
      occurredAt: null,
    });
    const detail = {
      category: "network",
      message: null,
      providerType: null,
      httpStatus: null,
      retry: "not-retried",
      resetsAt: null,
    } as const;
    expect(
      sessionWatchChanges({ ...interrupted, stopDetail: detail } as SessionEventPayload, watch, ctx)
        .change,
    ).toMatchObject({ stopDetail: detail });
  });

  test("verdicts report whatever the arm, with their reason as cut prose", () => {
    expect(
      sessionWatchChanges(
        signal("done", "abcdef"),
        { ...watch, turnArmed: false },
        {
          ...ctx,
          proseLimit: 3,
        },
      ),
    ).toEqual({
      change: {
        subject: "session",
        sessionId: TARGET,
        title: "Fix",
        occurredAt: null,
        fact: "signaled-done",
        pendingSubagents: [],
        reason: { text: "abc", totalChars: 6 },
      },
      turnArmed: false,
      ended: false,
    });
    expect(sessionWatchChanges(signal("blocked", null), watch, ctx).change).toMatchObject({
      fact: "signaled-blocked",
      reason: null,
    });
    expect(
      sessionWatchChanges(signal("done", null), { ...watch, kinds: ["turn"] }, ctx).change,
    ).toBeNull();
  });

  test("a stop ends the watch; the watcher's own stop and an unwatched kind are silent", () => {
    expect(sessionWatchChanges(stop({ kind: "user" }), watch, ctx)).toEqual({
      change: {
        subject: "session",
        sessionId: TARGET,
        title: "Fix",
        occurredAt: null,
        fact: "stopped",
        by: { kind: "user" },
        reason: { text: "done here", totalChars: 9 },
      },
      turnArmed: true,
      ended: true,
    });
    expect(sessionWatchChanges(stop({ kind: "session", sessionId: WATCHER }), watch, ctx)).toEqual({
      change: null,
      turnArmed: true,
      ended: true,
    });
    expect(
      sessionWatchChanges(stop({ kind: "session", sessionId: CHILD }), watch, ctx).change,
    ).toMatchObject({ by: { kind: "session", sessionId: CHILD } });
    expect(
      sessionWatchChanges(
        { kind: "session.stopped", reason: null, by: { kind: "watchdog" } },
        {
          ...watch,
          kinds: ["turn"],
        },
        ctx,
      ),
    ).toEqual({ change: null, turnArmed: true, ended: true });
    expect(
      sessionWatchChanges(
        { kind: "session.stopped", reason: null, by: { kind: "watchdog" } },
        watch,
        ctx,
      ).change,
    ).toMatchObject({ reason: null });
  });

  test("bookkeeping facts report nothing", () => {
    expect(sessionWatchChanges({ kind: "session.archived" }, watch, ctx)).toEqual({
      change: null,
      turnArmed: true,
      ended: false,
    });
  });
});

describe("ticket watches", () => {
  const ticket = {
    ticketId: "t-1",
    display: "VC-12",
    kinds: ["status", "comment", "signal"] as const,
  };
  const tctx = { watcherSessionId: WATCHER, actorSessionId: null, by: { kind: "person" as const } };

  test("hear the watched kinds, never the watcher's own acts", () => {
    expect(ticketWatchHears(ticket, "status_changed", undefined, WATCHER)).toBe(true);
    expect(ticketWatchHears({ kinds: new Set(["comment"]) }, "commented", null, WATCHER)).toBe(
      true,
    );
    expect(ticketWatchHears({ kinds: new Set(["comment"]) }, "status_changed", null, WATCHER)).toBe(
      false,
    );
    expect(ticketWatchHears(ticket, "status_changed", WATCHER, WATCHER)).toBe(false);
    expect(ticketWatchHears(ticket, "retitled", null, WATCHER)).toBe(false);
  });

  test("each heard kind becomes its change", () => {
    expect(
      ticketWatchChanges({ kind: "status_changed", from: "todo", to: "doing" }, ticket, {
        ...tctx,
        occurredAt: 3,
      }),
    ).toEqual({
      subject: "ticket",
      ticketId: "t-1",
      display: "VC-12",
      by: { kind: "person" },
      occurredAt: 3,
      fact: "ticket-moved",
      from: "todo",
      to: "doing",
    });
    expect(
      ticketWatchChanges({ kind: "commented", commentId: "c1" }, ticket, {
        ...tctx,
        comment: "hello there",
        proseLimit: 5,
      }),
    ).toMatchObject({ fact: "ticket-commented", comment: { text: "hello", totalChars: 11 } });
    expect(ticketWatchChanges({ kind: "commented", commentId: "c1" }, ticket, tctx)).toMatchObject({
      comment: null,
    });
    expect(
      ticketWatchChanges(
        { kind: "signaled", signalKind: "review", verdict: "pass", detail: "ok" },
        ticket,
        tctx,
      ),
    ).toMatchObject({
      fact: "ticket-signaled",
      signalKind: "review",
      verdict: "pass",
      detail: { text: "ok", totalChars: 2 },
    });
    expect(
      ticketWatchChanges(
        { kind: "signaled", signalKind: "review", verdict: "fail", detail: null },
        ticket,
        tctx,
      ),
    ).toMatchObject({ detail: null });
    expect(ticketWatchChanges({ kind: "body_edited" }, ticket, tctx)).toBeNull();
    expect(
      ticketWatchChanges({ kind: "status_changed", from: "todo", to: "doing" }, ticket, {
        ...tctx,
        actorSessionId: WATCHER,
      }),
    ).toBeNull();
  });

  test("a local event's actor, as a notice names it", () => {
    expect(
      ticketEventWatchActor({
        actor: "session",
        actorContext: { sessionId: CHILD, ticketId: null },
      }),
    ).toEqual({
      kind: "session",
      sessionId: CHILD,
    });
    expect(ticketEventWatchActor({ actor: "session" })).toEqual({
      kind: "session",
      sessionId: null,
    });
    expect(
      ticketEventWatchActor({
        actor: "automation",
        actorContext: { sessionId: CHILD, ticketId: null },
      }),
    ).toEqual({ kind: "automation" });
    expect(ticketEventWatchActor({ actor: "unauthenticated" })).toEqual({
      kind: "unauthenticated",
    });
    expect(ticketEventWatchActor({ actor: "user", actorContext: null })).toEqual({
      kind: "person",
    });
  });
});
