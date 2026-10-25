import { describe, expect, test } from "vite-plus/test";

import {
  ACTIVITY_COALESCING,
  ActivityFold,
  MalformedBoardEventError,
  activityTicketIds,
  activityUserIds,
  decideSessionOutcomeEvents,
  readActivityEvent,
  type ActivityEvent,
  type ActivityItem,
  type SessionOutcomeFacts,
} from "./activity";
import type { Actor, UnknownActor } from "./actor";
import type { BoardEventPayload } from "./board-events";
import { newId, type BoardEventId, type ProjectId, type TicketId, type UserId } from "./ids";

const MINUTE = 60 * 1000;
const projectId = newId("project");
const ticketId = newId("ticket");
const ana = newId("user");
const bo = newId("user");
const person = (userId: UserId): Actor => ({ kind: "person", userId });

let seq = 0;
/** Events are built newest first, as the feed reads them; `at` is in minutes. */
function event(
  payload: BoardEventPayload,
  at: number,
  fields: { actor?: Actor | UnknownActor; ticketId?: TicketId | null; projectId?: ProjectId } = {},
): ActivityEvent {
  seq += 1;
  return {
    id: newId("boardEvent"),
    projectId: fields.projectId ?? projectId,
    ticketId: fields.ticketId === undefined ? ticketId : fields.ticketId,
    seq,
    occurredAt: at * MINUTE,
    actor: fields.actor ?? person(ana),
    payload,
  };
}

function fold(events: ActivityEvent[], rules = ACTIVITY_COALESCING): ActivityItem[] {
  const folded = new ActivityFold(rules);
  for (const next of events) folded.add(next);
  return folded.items;
}

describe("readActivityEvent", () => {
  const row = {
    id: newId("boardEvent"),
    projectId,
    ticketId,
    seq: 3,
    kind: "retitled",
    actor: { kind: "person", userId: ana },
    occurredAt: 5,
    payload: { kind: "retitled", from: "A", to: "B" },
  };

  test("reads a known kind with its actor", () => {
    expect(readActivityEvent(row)).toEqual({
      id: row.id,
      projectId,
      ticketId,
      seq: 3,
      occurredAt: 5,
      actor: { kind: "person", userId: ana },
      payload: { kind: "retitled", from: "A", to: "B" },
    });
  });

  test("drops a kind this build does not know and reads a newer actor arm as unknown", () => {
    expect(readActivityEvent({ ...row, kind: "teleported" })).toBeNull();
    expect(readActivityEvent({ ...row, actor: { kind: "robot", userId: ana } })?.actor).toEqual({
      kind: "unknown",
      storedKind: "robot",
      userId: ana,
    });
  });

  test("a payload that does not carry its kind is corruption", () => {
    expect(() => readActivityEvent({ ...row, payload: { kind: "archived" } })).toThrow(
      MalformedBoardEventError,
    );
    expect(() => readActivityEvent({ ...row, payload: null })).toThrow(
      /payload.kind does not match kind/,
    );
    expect(() => readActivityEvent({ ...row, payload: "retitled" })).toThrow(
      MalformedBoardEventError,
    );
  });
});

describe("ActivityFold", () => {
  test("one person's consecutive edits to a ticket fold into their net change", () => {
    const events = [
      event({ kind: "status_changed", from: "doing", to: "needs_review" }, 30),
      event({ kind: "labels_changed", added: ["UI"], removed: [] }, 28),
      event({ kind: "body_edited" }, 27),
      event({ kind: "retitled", from: "B", to: "C" }, 26),
      event({ kind: "body_edited" }, 25),
      event({ kind: "status_changed", from: "todo", to: "doing" }, 24),
      event({ kind: "retitled", from: "A", to: "B" }, 23),
      event({ kind: "priority_changed", from: "low", to: "high" }, 22),
      event({ kind: "assigned", from: null, to: bo }, 21),
      event({ kind: "harness_changed", from: "claude-code", to: "codex" }, 20),
      event({ kind: "checkout_mode_changed", from: "worktree", to: "main_checkout" }, 20),
    ];
    const items = fold(events);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      id: events.at(-1)!.id,
      projectId,
      ticketId,
      actor: person(ana),
      at: 30 * MINUTE,
      since: 20 * MINUTE,
      count: events.length,
      what: {
        kind: "changed",
        changes: [
          { field: "status", from: "todo", to: "needs_review" },
          { field: "labels", added: ["UI"], removed: [] },
          { field: "body" },
          { field: "title", from: "A", to: "C" },
          { field: "priority", from: "low", to: "high" },
          { field: "assignee", from: null, to: bo },
          { field: "harness", from: "claude-code", to: "codex" },
          { field: "checkout_mode", from: "worktree", to: "main_checkout" },
        ],
      },
    });
  });

  test("a status run that went there and back keeps from and to", () => {
    const [item] = fold([
      event({ kind: "status_changed", from: "doing", to: "todo" }, 2),
      event({ kind: "status_changed", from: "todo", to: "doing" }, 1),
    ]);
    expect(item!.what).toEqual({
      kind: "changed",
      changes: [{ field: "status", from: "todo", to: "todo" }],
    });
  });

  test("label runs net out: added then removed, removed then added", () => {
    const labels = (added: string[], removed: string[], at: number) =>
      event({ kind: "labels_changed", added, removed }, at);
    const [item] = fold([
      // Newest first: newer ops, then older ones.
      labels(["Gone", "Back"], ["Temp", "Kept"], 3),
      labels(["Temp", "New"], ["Back", "Old"], 2),
      labels(["Kept"], [], 1),
    ]);
    expect(item!.what).toEqual({
      kind: "changed",
      changes: [{ field: "labels", added: ["New", "Gone"], removed: ["Old"] }],
    });
  });

  test("a ticket's creation absorbs its creator's edits right after it", () => {
    const created = event({ kind: "created", status: "todo", title: "Fix it" }, 0);
    const items = fold([event({ kind: "labels_changed", added: ["UI"], removed: [] }, 1), created]);
    expect(items).toEqual([
      expect.objectContaining({
        id: created.id,
        count: 2,
        what: {
          kind: "created",
          title: "Fix it",
          status: "todo",
          changes: [{ field: "labels", added: ["UI"], removed: [] }],
        },
      }),
    ]);
    // A lone creation is a `created` item too, and nothing older joins it.
    const lone = fold([
      event({ kind: "created", status: "backlog", title: "Lone" }, 5),
      event({ kind: "body_edited" }, 4),
    ]);
    expect(lone.map((item) => item.what.kind)).toEqual(["created", "changed"]);
  });

  test("consecutive comments fold, newest first; comments and edits stay apart", () => {
    const one = newId("comment");
    const two = newId("comment");
    const items = fold([
      event({ kind: "commented", commentId: two }, 3),
      event({ kind: "commented", commentId: one }, 2),
      event({ kind: "body_edited" }, 1),
      event({ kind: "commented", commentId: newId("comment") }, 0),
    ]);
    expect(items.map((item) => [item.what.kind, item.count])).toEqual([
      ["commented", 2],
      ["changed", 1],
      ["commented", 1],
    ]);
    expect(items[0]!.what).toEqual({ kind: "commented", commentIds: [two, one] });
  });

  test("other events stand alone, verbatim", () => {
    const sessionId = newId("session");
    const items = fold([
      event({ kind: "session_signaled", sessionId, signal: "done", reason: null }, 2),
      event({ kind: "session_started", sessionId }, 1),
      event({ kind: "archived" }, 1),
    ]);
    expect(items.map((item) => item.what)).toEqual([
      {
        kind: "event",
        payload: { kind: "session_signaled", sessionId, signal: "done", reason: null },
      },
      { kind: "event", payload: { kind: "session_started", sessionId } },
      { kind: "event", payload: { kind: "archived" } },
    ]);
  });

  test("a run breaks on another actor, ticket, project, a project-level event, or a nameless actor", () => {
    const body = { kind: "body_edited" } as const;
    const kinds = (events: ActivityEvent[]) => fold(events).length;
    expect(kinds([event(body, 2), event(body, 1, { actor: person(bo) })])).toBe(2);
    expect(kinds([event(body, 2), event(body, 1, { ticketId: newId("ticket") })])).toBe(2);
    expect(kinds([event(body, 2), event(body, 1, { projectId: newId("project") })])).toBe(2);
    const renamed = { kind: "project_renamed", from: "A", to: "B" } as const;
    expect(
      kinds([event(renamed, 2, { ticketId: null }), event(renamed, 1, { ticketId: null })]),
    ).toBe(2);
    const legacy: Actor = { kind: "legacy", was: "user" };
    expect(kinds([event(body, 2, { actor: legacy }), event(body, 1, { actor: legacy })])).toBe(2);
  });

  test("agents, Automation runs and Volli fold per Session, run and reason", () => {
    const body = { kind: "body_edited" } as const;
    const sessionId = newId("session");
    const agent: Actor = { kind: "agent", userId: ana, sessionId };
    const otherAgent: Actor = { kind: "agent", userId: ana, sessionId: newId("session") };
    const run = (runId: string): Actor => ({
      kind: "automation",
      userId: ana,
      automationId: "a",
      runId,
    });
    const volli: Actor = { kind: "volli", reason: "merge_watch" };
    const runner: Actor = {
      kind: "volli",
      reason: "retention",
      runnerId: newId("runner"),
      onBehalfOf: ana,
    };
    const count = (a: Actor | UnknownActor, b: Actor | UnknownActor) =>
      fold([event(body, 2, { actor: a }), event(body, 1, { actor: b })]).length;
    expect(count(agent, agent)).toBe(1);
    expect(count(agent, otherAgent)).toBe(2);
    expect(count(agent, person(ana))).toBe(2);
    expect(count(run("r1"), run("r1"))).toBe(1);
    expect(count(run("r1"), run("r2"))).toBe(2);
    expect(count(volli, volli)).toBe(1);
    expect(count(runner, runner)).toBe(1);
    expect(count(volli, runner)).toBe(2);
    const unknown = { kind: "unknown", storedKind: "robot", userId: ana } as const;
    expect(count(unknown, unknown)).toBe(2);
  });

  test("a run breaks after a gap, a span, or its size", () => {
    const body = { kind: "body_edited" } as const;
    const { gapMs, spanMs } = ACTIVITY_COALESCING;
    const gap = gapMs / MINUTE;
    expect(fold([event(body, gap), event(body, 0)])).toHaveLength(1);
    expect(fold([event(body, gap + 1), event(body, 0)])).toHaveLength(2);
    // Every step within the gap, but the whole run past the span.
    const steps = Array.from({ length: spanMs / gapMs + 2 }, (_, i) => event(body, (10 - i) * gap));
    expect(fold(steps).map((item) => item.count)).toEqual([spanMs / gapMs + 1, 1]);
    const small = { ...ACTIVITY_COALESCING, maxEvents: 2 };
    expect(
      fold([event(body, 3), event(body, 2), event(body, 1)], small).map((i) => i.count),
    ).toEqual([2, 1]);
  });

  test("joins answers before an event is taken", () => {
    const folded = new ActivityFold();
    const first = event({ kind: "body_edited" }, 2);
    expect(folded.joins(first)).toBe(false);
    folded.add(first);
    expect(folded.joins(event({ kind: "body_edited" }, 1))).toBe(true);
    expect(folded.joins(event({ kind: "archived" }, 1))).toBe(false);
    expect(folded.items).toHaveLength(1);
  });
});

describe("references", () => {
  const base: Omit<ActivityItem, "what"> = {
    id: newId("boardEvent") as BoardEventId,
    projectId,
    ticketId,
    actor: person(ana),
    at: 0,
    since: 0,
    count: 1,
  };

  test("an item names its ticket and a link's target", () => {
    const other = newId("ticket");
    expect(activityTicketIds({ ...base, what: { kind: "changed", changes: [] } })).toEqual([
      ticketId,
    ]);
    expect(
      activityTicketIds({
        ...base,
        what: { kind: "event", payload: { kind: "linked", toTicketId: other, linkKind: "blocks" } },
      }),
    ).toEqual([ticketId, other]);
    expect(
      activityTicketIds({
        ...base,
        ticketId: null,
        what: {
          kind: "event",
          payload: { kind: "unlinked", toTicketId: other, linkKind: "relates" },
        },
      }),
    ).toEqual([other]);
    expect(
      activityTicketIds({
        ...base,
        ticketId: null,
        what: { kind: "event", payload: { kind: "archived" } },
      }),
    ).toEqual([]);
  });

  test("an item names its actor and any assignee it set or cleared", () => {
    expect(
      activityUserIds({
        ...base,
        what: {
          kind: "changed",
          changes: [{ field: "body" }, { field: "assignee", from: bo, to: null }],
        },
      }),
    ).toEqual([ana, bo]);
    expect(
      activityUserIds({
        ...base,
        actor: { kind: "legacy", was: "user" },
        what: {
          kind: "created",
          title: "T",
          status: "todo",
          changes: [{ field: "assignee", from: null, to: bo }],
        },
      }),
    ).toEqual([bo]);
    expect(activityUserIds({ ...base, what: { kind: "commented", commentIds: [] } })).toEqual([
      ana,
    ]);
  });
});

describe("decideSessionOutcomeEvents", () => {
  const sessionId = newId("session");
  const listing: SessionOutcomeFacts = {
    id: sessionId,
    ticketId,
    origin: null,
    latestTurnId: null,
    lastTurnOutcome: null,
    signal: null,
    stopped: null,
  };

  test("a new Session's listing records its start, with its origin when known", () => {
    expect(decideSessionOutcomeEvents(null, listing)).toEqual([
      { ticketId, payload: { kind: "session_started", sessionId } },
    ]);
    expect(decideSessionOutcomeEvents(null, { ...listing, origin: { kind: "user" } })).toEqual([
      { ticketId, payload: { kind: "session_started", sessionId, origin: { kind: "user" } } },
    ]);
  });

  test("a new signal, a stop and a failed turn each record once", () => {
    const after: SessionOutcomeFacts = {
      ...listing,
      latestTurnId: "t1",
      lastTurnOutcome: "failed",
      signal: { signal: "blocked", reason: "needs a key", at: 5 },
      stopped: { at: 6, reason: null },
    };
    expect(decideSessionOutcomeEvents(listing, after).map((draft) => draft.payload)).toEqual([
      { kind: "session_signaled", sessionId, signal: "blocked", reason: "needs a key" },
      { kind: "session_stopped", sessionId, reason: null },
      { kind: "session_failed", sessionId, turnId: "t1", code: null },
    ]);
    // The same listing again records nothing.
    expect(decideSessionOutcomeEvents(after, after)).toEqual([]);
    // A later signal and a later failed turn record again.
    expect(
      decideSessionOutcomeEvents(after, {
        ...after,
        latestTurnId: "t2",
        signal: { signal: "done", reason: null, at: 9 },
      }).map((draft) => draft.payload.kind),
    ).toEqual(["session_signaled", "session_failed"]);
    // A turn that completed records nothing.
    expect(
      decideSessionOutcomeEvents(listing, {
        ...listing,
        latestTurnId: "t1",
        lastTurnOutcome: "completed",
      }),
    ).toEqual([]);
  });
});
