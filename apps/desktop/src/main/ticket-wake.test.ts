import { describe, expect, it, vi } from "vite-plus/test";

import type { TicketEvent } from "@volli/shared";

import { emitTicketWake, subscribeTicketWake, type TicketWake } from "./ticket-wake";

function wake(kind: "commented" | "archived" = "commented"): TicketWake {
  const event: TicketEvent = {
    id: "event-1",
    ticketId: "ticket-1",
    actor: "session",
    createdAt: 1_700_000_000_000,
    payload: kind === "commented" ? { kind, commentId: "comment-1" } : { kind },
  };
  return { event, projectId: "project-1" };
}

describe("the ticket wake bus", () => {
  it("fans one wake out to every subscriber, in subscription order", () => {
    const order: string[] = [];
    const offA = subscribeTicketWake(() => order.push("a"));
    const offB = subscribeTicketWake(() => order.push("b"));
    emitTicketWake(wake());
    offA();
    offB();
    expect(order).toEqual(["a", "b"]);
  });

  it("stops delivering after unsubscribe, so a settled wait holds nothing", () => {
    const seen: TicketWake[] = [];
    const off = subscribeTicketWake((one) => seen.push(one));
    emitTicketWake(wake());
    off();
    emitTicketWake(wake("archived"));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.event.payload.kind).toBe("commented");
  });

  it("isolates a throwing listener: the door is not unwound and the rest still wake", () => {
    const failures: unknown[] = [];
    const seen: string[] = [];
    const offA = subscribeTicketWake(() => {
      throw new Error("listener bug");
    });
    const offB = subscribeTicketWake(() => seen.push("b"));
    expect(() => emitTicketWake(wake(), (error) => failures.push(error))).not.toThrow();
    offA();
    offB();
    expect(seen).toEqual(["b"]);
    expect(failures).toHaveLength(1);
  });

  it("reports a listener failure to console by default, and still does not throw", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const off = subscribeTicketWake(() => {
      throw new Error("listener bug");
    });
    try {
      expect(() => emitTicketWake(wake())).not.toThrow();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      off();
      spy.mockRestore();
    }
  });
});
