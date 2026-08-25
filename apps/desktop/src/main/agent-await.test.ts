/**
 * `ticket.await` host-side (VC-85 slice D): the wait parks, the right event
 * wakes it, policy judges it, the cursor replays it, and the abort withdraws
 * it. The bus is the real `ticket-wake` module, because the integration IS the
 * subject — a fake bus would prove a contract nothing ships.
 */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { DEFAULT_AUTHORITY_POLICY } from "@volli/shared";
import type {
  AuthorityPolicy,
  RuntimeSessionIdentity,
  RuntimeVerbResult,
  TicketAwaitKind,
  TicketEventActor,
  TicketEventPayload,
} from "@volli/shared";

import { awaitTicketTool, type AwaitTicketPorts } from "./agent-await";
import { createComment } from "./db/comments-repo";
import {
  currentTicketEventCursor,
  encodeTicketEventCursor,
  recordTicketEvent,
} from "./db/events-repo";
import { insertProject, listProjects } from "./db/projects-repo";
import { openTestDb, testProject, testTicket } from "./db/test-helpers";
import type { TestDb } from "./db/test-helpers";
import { insertTicket } from "./db/tickets-repo";
import {
  emitTicketWake,
  emitTicketWakesSince,
  markTicketWake,
  subscribeTicketWake,
} from "./ticket-wake";

let ctx: TestDb | undefined;

afterEach(() => {
  vi.useRealTimers();
  ctx?.cleanup();
  ctx = undefined;
});

const CALLER: RuntimeSessionIdentity = {
  role: "project",
  sessionId: "caller-session",
  rootThreadId: "thread-1",
  attachmentId: "attachment-1",
  projectId: "project-one",
  ticketId: null,
};

function narrowedPolicy(awaitable: readonly TicketAwaitKind[]): AuthorityPolicy {
  return {
    ...DEFAULT_AUTHORITY_POLICY,
    actors: {
      ...DEFAULT_AUTHORITY_POLICY.actors,
      session: { ...DEFAULT_AUTHORITY_POLICY.actors.session, awaitable },
    },
  };
}

function harness(options: { awaitable?: readonly TicketAwaitKind[] } = {}) {
  ctx = openTestDb();
  const db = ctx.db;
  insertProject(
    db,
    testProject({ id: "project-one", name: "Volli", path: "/repo/volli", ticketPrefix: "VC" }),
  );
  insertTicket(db, testTicket("project-one", { id: "ticket-one", ticketNumber: 1, title: "One" }));
  insertTicket(db, testTicket("project-one", { id: "ticket-two", ticketNumber: 2, title: "Two" }));
  const ports: AwaitTicketPorts = {
    db,
    projects: () => listProjects(db),
    authorityPolicy: () =>
      options.awaitable === undefined
        ? DEFAULT_AUTHORITY_POLICY
        : narrowedPolicy(options.awaitable),
    subscribeTicketWake,
  };
  const call = (
    input: Record<string, unknown>,
    signal: AbortSignal = new AbortController().signal,
  ) => awaitTicketTool(ports, CALLER, { verb: "ticket.await", input, toolCallId: "tc-1" }, signal);
  /** Record the durable event AND fan it out, the way a fed door does (slice C). */
  const commit = (
    ticketId: string,
    payload: TicketEventPayload,
    at: number,
    actor: TicketEventActor = {
      kind: "session",
      sessionId: "worker",
      ticketId,
    },
  ): void => {
    const mark = markTicketWake(db, ticketId);
    recordTicketEvent(db, ticketId, payload, at, actor);
    emitTicketWakesSince(db, ticketId, mark);
  };
  return { db, call, commit };
}

const SIGNALED: TicketEventPayload = {
  kind: "signaled",
  signalKind: "review",
  verdict: "pass",
  detail: "Gates green at HEAD",
};

function cursorFrom(result: RuntimeVerbResult): string {
  const match = /^cursor: ([^.\s]+)\./m.exec(result.text);
  if (match === null) throw new Error(`No cursor in result: ${result.text}`);
  return match[1]!;
}

describe("ticket.await — waking", () => {
  it("parks until a matching signal commits, then wakes with the typed fact and the cursor", async () => {
    const h = harness();
    const pending = h.call({ tickets: "VC-1", for: "signal" });
    // Noise first: another ticket, then a non-matching kind on the watched one.
    h.commit("ticket-two", SIGNALED, 1_000);
    h.commit("ticket-one", { kind: "commented", commentId: "missing" }, 1_500);
    h.commit("ticket-one", SIGNALED, 2_000);
    const result = await pending;
    expect(result.text).toContain("Ticket VC-1 signaled review: pass.");
    expect(result.text).toContain("By session worker");
    expect(result.text).toContain("Gates green at HEAD");
    expect(result.text).toContain("untrusted signal detail");
    expect(result.text).toContain("occurredAt: 2000");
    expect(result.text).toContain("cursor: ticket-event-v1:");
  });

  it("wakes on a comment with the body enveloped as another author's prose", async () => {
    const h = harness();
    const pending = h.call({ tickets: "VC-1", for: "comment" });
    const comment = createComment(
      h.db,
      { ticketId: "ticket-one", body: "REVIEW: PASS\nold habits", actor: "user" },
      3_000,
    );
    h.commit("ticket-one", { kind: "commented", commentId: comment.id }, 3_000);
    const result = await pending;
    expect(result.text).toContain("Ticket VC-1 received a comment.");
    expect(result.text).toContain("begin untrusted ticket comment");
    expect(result.text).toContain("REVIEW: PASS");
  });

  it("says so plainly when the waking comment was already deleted", async () => {
    const h = harness();
    const pending = h.call({ tickets: "VC-1", for: "comment" });
    h.commit("ticket-one", { kind: "commented", commentId: "gone" }, 3_500);
    const result = await pending;
    expect(result.text).toContain("deleted before this wake was read");
    expect(result.text).not.toContain("begin untrusted");
  });

  it("wakes on a board move with both columns named", async () => {
    const h = harness();
    const pending = h.call({ tickets: "VC-1", for: "status" });
    h.commit("ticket-one", { kind: "status_changed", from: "doing", to: "needs_review" }, 4_000);
    const result = await pending;
    expect(result.text).toContain("Ticket VC-1 moved from doing to needs_review.");
  });

  it("never misattributes a policy-granted unauthenticated write to the user", async () => {
    const h = harness();
    const pending = h.call({ tickets: "VC-1", for: "status" });
    h.commit("ticket-one", { kind: "status_changed", from: "todo", to: "doing" }, 4_500, {
      kind: "unauthenticated",
    });
    const result = await pending;
    expect(result.text).toContain("By an unauthenticated caller.");
    expect(result.text).not.toContain("By the user.");
  });

  it("reads any as the union of what POLICY allows, not of the whole vocabulary", async () => {
    const h = harness({ awaitable: ["comment"] });
    const pending = h.call({ tickets: "VC-1", for: "any" });
    // A signal would match "any" against default policy; narrowed, it must not wake.
    h.commit("ticket-one", SIGNALED, 5_000);
    const comment = createComment(
      h.db,
      { ticketId: "ticket-one", body: "done", actor: "user" },
      5_500,
    );
    h.commit("ticket-one", { kind: "commented", commentId: comment.id }, 5_500);
    const result = await pending;
    expect(result.text).toContain("received a comment");
  });

  it("watches several tickets at once and names the one that woke it", async () => {
    const h = harness();
    const pending = h.call({ tickets: "VC-1, VC-2" });
    h.commit("ticket-two", SIGNALED, 6_000);
    const result = await pending;
    expect(result.text).toContain("Ticket VC-2 signaled");
  });
});

describe("ticket.await — the opaque durable cursor", () => {
  it("wakes immediately on a durable event after the cursor, without any bus emit", async () => {
    const h = harness();
    recordTicketEvent(h.db, "ticket-one", SIGNALED, 7_000, { kind: "user" });
    const result = await h.call({
      tickets: "VC-1",
      for: "signal",
      cursor: encodeTicketEventCursor(0),
    });
    expect(result.text).toContain("Ticket VC-1 signaled review: pass.");
    expect(result.text).toContain("occurredAt: 7000");
    expect(cursorFrom(result)).toBe(currentTicketEventCursor(h.db));
  });

  it("replays commit order across the watched set even when timestamps are equal", async () => {
    const h = harness();
    recordTicketEvent(h.db, "ticket-two", SIGNALED, 8_000, { kind: "user" });
    recordTicketEvent(h.db, "ticket-one", SIGNALED, 8_000, { kind: "user" });

    const first = await h.call({
      tickets: "VC-1 VC-2",
      for: "signal",
      cursor: encodeTicketEventCursor(0),
    });
    expect(first.text).toContain("Ticket VC-2 signaled");
    expect(first.text).toContain("occurredAt: 8000");

    const second = await h.call({
      tickets: "VC-1 VC-2",
      for: "signal",
      cursor: cursorFrom(first),
    });
    expect(second.text).toContain("Ticket VC-1 signaled");
    expect(second.text).toContain("occurredAt: 8000");
    expect(cursorFrom(second)).not.toBe(cursorFrom(first));
  });

  it("parks when everything durable is at or before the cursor", async () => {
    const h = harness();
    recordTicketEvent(h.db, "ticket-one", SIGNALED, 9_000, { kind: "user" });
    const pending = h.call({
      tickets: "VC-1",
      for: "signal",
      cursor: currentTicketEventCursor(h.db),
    });
    h.commit("ticket-one", SIGNALED, 9_500);
    const result = await pending;
    expect(result.text).toContain("occurredAt: 9500");
  });
});

describe("ticket.await — bounded and withdrawn waits", () => {
  it("resolves a timed-out wait as an answer, never an error", async () => {
    vi.useFakeTimers();
    const h = harness();
    const pending = h.call({ tickets: "VC-1", for: "signal", timeoutSeconds: 30 });
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await pending;
    expect(result.text).toContain("No matching event within 30 seconds on VC-1");
    expect(result.text).toContain("waiting for: signal");
    expect(cursorFrom(result)).toBe(encodeTicketEventCursor(0));
  });

  it("replays an event committed after a cursorless timeout and before the retry", async () => {
    vi.useFakeTimers();
    const h = harness();
    const timedOut = h.call({ tickets: "VC-1", for: "signal", timeoutSeconds: 1 });
    await vi.advanceTimersByTimeAsync(1_000);
    const timeout = await timedOut;

    // No subscriber exists in this gap. Durability plus the returned baseline
    // cursor is the only way the retry can still see the event.
    h.commit("ticket-one", SIGNALED, 30_000);
    const replayed = await h.call({
      tickets: "VC-1",
      for: "signal",
      cursor: cursorFrom(timeout),
    });
    expect(replayed.text).toContain("Ticket VC-1 signaled review: pass.");
  });

  it("rejects a withdrawn wait, and a late event wakes nothing", async () => {
    const h = harness();
    const control = new AbortController();
    const pending = h.call({ tickets: "VC-1" }, control.signal);
    control.abort();
    await expect(pending).rejects.toThrow("withdrawn before any event arrived");
    // The subscription is gone: a later matching commit must not throw into a
    // settled promise (the bus isolates listeners, so this would only surface
    // as a reported failure — assert none is reported).
    const failures: unknown[] = [];
    emitTicketWake(
      {
        event: { id: "e", ticketId: "ticket-one", actor: "user", createdAt: 1, payload: SIGNALED },
        projectId: "project-one",
        cursor: encodeTicketEventCursor(0),
      },
      (error) => failures.push(error),
    );
    expect(failures).toEqual([]);
  });

  it("reads an already-aborted signal rather than waiting for a fire that never comes", async () => {
    const h = harness();
    await expect(h.call({ tickets: "VC-1" }, AbortSignal.abort())).rejects.toThrow(
      "withdrawn before any event arrived",
    );
  });
});

async function refusesWith(pending: Promise<RuntimeVerbResult>, text: string): Promise<void> {
  expect((await pending).text).toContain(text);
}

describe("ticket.await — refusals the model can act on", () => {
  it("refuses an empty or missing tickets field", async () => {
    const h = harness();
    await refusesWith(h.call({}), "`tickets` must name at least one ticket");
    await refusesWith(h.call({ tickets: "  ,  " }), "`tickets` must name at least one ticket");
  });

  it("refuses a for outside the vocabulary", async () => {
    const h = harness();
    await refusesWith(
      h.call({ tickets: "VC-1", for: "merge" }),
      "one of: signal, comment, status, any",
    );
  });

  it("refuses a non-positive timeout and an invented cursor by name", async () => {
    const h = harness();
    await refusesWith(
      h.call({ tickets: "VC-1", timeoutSeconds: 0 }),
      "`timeoutSeconds` must be a positive number",
    );
    await refusesWith(
      h.call({ tickets: "VC-1", cursor: "yesterday" }),
      "`cursor` must be an opaque cursor returned by a previous ticket_await",
    );
  });

  it("bounds one fleet subscription before resolving any targets", async () => {
    const h = harness();
    const targets = Array.from({ length: 101 }, (_, index) => `VC-${index + 1}`).join(" ");
    await refusesWith(h.call({ tickets: targets }), "at most 100 tickets");
  });

  it("refuses a ticket the caller's project does not hold", async () => {
    const h = harness();
    await refusesWith(h.call({ tickets: "VC-9" }), "No ticket VC-9 in this project");
  });

  it("refuses when policy allows nothing, and names the allowed list otherwise", async () => {
    const none = harness({ awaitable: [] });
    await refusesWith(none.call({ tickets: "VC-1" }), "lets Sessions await nothing");
    ctx?.cleanup();
    ctx = undefined;
    const narrowed = harness({ awaitable: ["status"] });
    await refusesWith(
      narrowed.call({ tickets: "VC-1", for: "signal" }),
      "does not allow waiting for signal; it allows: status",
    );
  });

  it("refuses when the caller's project is no longer registered", async () => {
    ctx = openTestDb();
    const db = ctx.db;
    const ports: AwaitTicketPorts = {
      db,
      projects: () => listProjects(db),
      authorityPolicy: () => DEFAULT_AUTHORITY_POLICY,
      subscribeTicketWake,
    };
    const result = await awaitTicketTool(
      ports,
      CALLER,
      { verb: "ticket.await", input: { tickets: "VC-1" }, toolCallId: "tc-1" },
      new AbortController().signal,
    );
    expect(result.text).toContain("no longer registered");
  });
});
