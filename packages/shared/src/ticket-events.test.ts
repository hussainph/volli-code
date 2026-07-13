import { describe, expect, it } from "vite-plus/test";

import { TICKET_EVENT_KINDS } from "./ticket-events";
import type { TicketEvent, TicketEventKind, TicketEventPayload } from "./ticket-events";

describe("TICKET_EVENT_KINDS", () => {
  it("lists every event kind", () => {
    expect(TICKET_EVENT_KINDS).toEqual([
      "created",
      "status_changed",
      "priority_changed",
      "retitled",
      "body_edited",
      "labels_changed",
    ]);
  });

  it("every member is assignable to TicketEventKind", () => {
    const kind: TicketEventKind = TICKET_EVENT_KINDS[0];
    expect(TICKET_EVENT_KINDS).toContain(kind);
  });
});

describe("TicketEventPayload", () => {
  it("has one payload shape per event kind, in TICKET_EVENT_KINDS order", () => {
    const payloads: TicketEventPayload[] = [
      { kind: "created", status: "backlog", title: "T" },
      { kind: "status_changed", from: "backlog", to: "todo" },
      { kind: "priority_changed", from: "low", to: "high" },
      { kind: "retitled", from: "Old", to: "New" },
      { kind: "body_edited" },
      { kind: "labels_changed", added: ["bug"], removed: ["chore"] },
    ];
    expect(payloads.map((p) => p.kind)).toEqual(TICKET_EVENT_KINDS);
  });
});

describe("TicketEvent", () => {
  it("builds a well-formed event envelope", () => {
    const event: TicketEvent = {
      id: "evt-1",
      ticketId: "ticket-1",
      actor: "user",
      createdAt: 123,
      payload: { kind: "body_edited" },
    };
    expect(event.actor).toBe("user");
    expect(event.payload).toEqual({ kind: "body_edited" });
  });
});
