import { describe, expect, it } from "vite-plus/test";

import {
  isTicketAwaitFor,
  parseTicketAwaitTargets,
  TICKET_AWAIT_EVENT_KINDS,
  TICKET_AWAIT_FOR,
  TICKET_AWAIT_KINDS,
  ticketAwaitKindsFor,
} from "./ticket-await";
import { TICKET_EVENT_KINDS } from "./ticket-events";

describe("the await vocabulary", () => {
  it("offers every await kind plus any, and nothing else", () => {
    expect(TICKET_AWAIT_FOR).toEqual([...TICKET_AWAIT_KINDS, "any"]);
  });

  it("maps every await kind onto a real Ticket Event kind", () => {
    for (const kind of TICKET_AWAIT_KINDS) {
      expect(TICKET_EVENT_KINDS).toContain(TICKET_AWAIT_EVENT_KINDS[kind]);
    }
  });

  it("wakes a signal wait on the signaled planner fact, which is slice B's seam", () => {
    expect(TICKET_AWAIT_EVENT_KINDS.signal).toBe("signaled");
    expect(TICKET_AWAIT_EVENT_KINDS.comment).toBe("commented");
    expect(TICKET_AWAIT_EVENT_KINDS.status).toBe("status_changed");
  });
});

describe("isTicketAwaitFor", () => {
  it("admits the whole for vocabulary", () => {
    for (const value of TICKET_AWAIT_FOR) {
      expect(isTicketAwaitFor(value)).toBe(true);
    }
  });

  it("refuses a word outside it, and anything that is not a string", () => {
    expect(isTicketAwaitFor("signaled")).toBe(false);
    expect(isTicketAwaitFor(42)).toBe(false);
    expect(isTicketAwaitFor(undefined)).toBe(false);
  });
});

describe("ticketAwaitKindsFor", () => {
  it("reads any as the union of the whole vocabulary, not as a fourth kind", () => {
    expect(ticketAwaitKindsFor("any")).toEqual([...TICKET_AWAIT_KINDS]);
  });

  it("reads one kind as itself", () => {
    expect(ticketAwaitKindsFor("comment")).toEqual(["comment"]);
  });
});

describe("parseTicketAwaitTargets", () => {
  it("splits on spaces, commas, and any mix of the two", () => {
    expect(parseTicketAwaitTargets("VC-12 VC-14")).toEqual(["VC-12", "VC-14"]);
    expect(parseTicketAwaitTargets("VC-12,VC-14")).toEqual(["VC-12", "VC-14"]);
    expect(parseTicketAwaitTargets("VC-12, VC-14 ,VC-15")).toEqual(["VC-12", "VC-14", "VC-15"]);
  });

  it("drops empty tokens and de-duplicates, so 'VC-12, VC-12' is one ticket", () => {
    expect(parseTicketAwaitTargets("  VC-12,, VC-12  ")).toEqual(["VC-12"]);
    expect(parseTicketAwaitTargets("   ")).toEqual([]);
  });
});
