import { describe, expect, test } from "vite-plus/test";

import type { Actor } from "./actor";
import {
  ATTENTION_CLEARED_REASONS,
  ATTENTION_SOURCES,
  notifySourceId,
  quarantineSourceId,
  SESSION_BLOCKED_SOURCE_ID,
  reviewAttentionId,
  reviewFactsAfter,
  reviewRequestee,
  reviewTicketIds,
  runnerAlertAttentionId,
  sessionAttentionId,
  type ReviewTicketFacts,
} from "./attention";
import type { BoardEventDraft } from "./board-rules";
import type { RunnerId, SessionId, TicketId, UserId } from "./ids";

const TICKET = "00000000-0000-4000-8000-000000000001" as TicketId;
const OTHER = "00000000-0000-4000-8000-000000000002" as TicketId;
const ALICE = "00000000-0000-4000-8000-0000000000a1" as UserId;
const BOB = "00000000-0000-4000-8000-0000000000b0" as UserId;
const SESSION = "00000000-0000-4000-8000-0000000000c0" as SessionId;
const RUNNER = "00000000-0000-4000-8000-0000000000d0" as RunnerId;

const alice: Actor = { kind: "person", userId: ALICE };
const bob: Actor = { kind: "person", userId: BOB };
const bobsAgent: Actor = { kind: "agent", userId: BOB, sessionId: SESSION };

const inReview: ReviewTicketFacts = {
  status: "needs_review",
  assigneeUserId: BOB,
  archived: false,
};

describe("frozen ids", () => {
  test("keep the shapes stored rows were written under", () => {
    expect(sessionAttentionId(SESSION, "interaction-1")).toBe(`s:${SESSION}:interaction-1`);
    expect(sessionAttentionId(SESSION, notifySourceId("n-1"))).toBe(
      `s:${SESSION}:volli:notify:n-1`,
    );
    expect(sessionAttentionId(SESSION, SESSION_BLOCKED_SOURCE_ID)).toBe(
      `s:${SESSION}:volli:blocked`,
    );
    expect(quarantineSourceId(7)).toBe("volli:quarantine:7");
    expect(reviewAttentionId(TICKET, BOB)).toBe(`t:${TICKET}:review:${BOB}`);
    expect(runnerAlertAttentionId(RUNNER, "credential_reuse")).toBe(`r:${RUNNER}:credential_reuse`);
  });

  test("the stored vocabularies only grow", () => {
    expect(ATTENTION_SOURCES).toContain("notify");
    expect(ATTENTION_CLEARED_REASONS).toEqual(["resolved", "access_lost", "superseded", "deleted"]);
  });
});

describe("review requests", () => {
  test("names the tickets whose status, assignee or archive a write changed, once each", () => {
    const events: BoardEventDraft[] = [
      { ticketId: TICKET, payload: { kind: "retitled", from: "a", to: "b" } },
      { ticketId: null, payload: { kind: "project_renamed", from: "a", to: "b" } },
      { ticketId: TICKET, payload: { kind: "status_changed", from: "doing", to: "needs_review" } },
      { ticketId: OTHER, payload: { kind: "assigned", from: null, to: BOB } },
      { ticketId: TICKET, payload: { kind: "archived" } },
      { ticketId: OTHER, payload: { kind: "unarchived" } },
    ];
    expect(reviewTicketIds(events)).toEqual([TICKET, OTHER]);
    expect(reviewTicketIds([{ ticketId: TICKET, payload: { kind: "body_edited" } }])).toEqual([]);
  });

  test("lays the write's events over the stored ticket, in order, for that ticket only", () => {
    const stored: ReviewTicketFacts = { status: "doing", assigneeUserId: null, archived: false };
    expect(
      reviewFactsAfter(stored, TICKET, [
        {
          ticketId: TICKET,
          payload: { kind: "status_changed", from: "doing", to: "needs_review" },
        },
        { ticketId: TICKET, payload: { kind: "assigned", from: null, to: ALICE } },
        { ticketId: OTHER, payload: { kind: "assigned", from: null, to: BOB } },
        { ticketId: TICKET, payload: { kind: "archived" } },
        { ticketId: TICKET, payload: { kind: "unarchived" } },
        { ticketId: TICKET, payload: { kind: "body_edited" } },
      ]),
    ).toEqual({ status: "needs_review", assigneeUserId: ALICE, archived: false });
    expect(
      reviewFactsAfter({ ...stored, archived: false }, TICKET, [
        { ticketId: TICKET, payload: { kind: "archived" } },
      ]),
    ).toEqual({ ...stored, archived: true });
    // The stored facts are not changed.
    expect(stored).toEqual({ status: "doing", assigneeUserId: null, archived: false });
  });

  test("asks the assignee of a ticket in Needs Review, unless they made the change themselves", () => {
    expect(reviewRequestee(inReview, alice)).toBe(BOB);
    expect(reviewRequestee(inReview, bob)).toBeNull();
    // Their agent bringing work back to them does ask.
    expect(reviewRequestee(inReview, bobsAgent)).toBe(BOB);
    expect(
      reviewRequestee(inReview, {
        kind: "automation",
        userId: BOB,
        automationId: "auto",
        runId: "run",
      }),
    ).toBe(BOB);
  });

  test("asks nobody off the column, off the board, or without an assignee", () => {
    expect(reviewRequestee({ ...inReview, status: "doing" }, alice)).toBeNull();
    expect(reviewRequestee({ ...inReview, archived: true }, alice)).toBeNull();
    expect(reviewRequestee({ ...inReview, assigneeUserId: null }, alice)).toBeNull();
  });
});
