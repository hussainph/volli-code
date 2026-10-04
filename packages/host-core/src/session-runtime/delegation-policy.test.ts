import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_TICKET_SESSION_DELEGATION,
  MAX_TICKET_SESSION_DELEGATION_CHILDREN,
  MAX_TICKET_SESSION_DELEGATION_DEPTH,
  assertDelegation,
  claimKey,
  claimedDelegation,
  cloneDelegationDefaults,
} from "./delegation-policy";
import type { TicketSessionDelegation } from "./delegation-policy";

const ROOT: TicketSessionDelegation = cloneDelegationDefaults();

const CHILD: TicketSessionDelegation = {
  parentSessionId: "parent",
  depth: 1,
  maxDepth: 1,
  maxChildren: 3,
  claimToolCallId: "call-1",
};

describe("delegation limits", () => {
  /**
   * The default is not merely "a" bound, it is the ceiling — a Ticket Session
   * cannot be born wider than the fork-bomb guard, so raising either number is
   * a migration rather than a caller's choice.
   */
  it("hands a new root the hard ceiling itself", () => {
    expect(DEFAULT_TICKET_SESSION_DELEGATION).toEqual({
      maxDepth: MAX_TICKET_SESSION_DELEGATION_DEPTH,
      maxChildren: MAX_TICKET_SESSION_DELEGATION_CHILDREN,
    });
    expect(MAX_TICKET_SESSION_DELEGATION_DEPTH).toBe(1);
    expect(MAX_TICKET_SESSION_DELEGATION_CHILDREN).toBe(3);
  });

  it("derives a child from its parent's frozen bounds and the call that opened it", () => {
    expect(
      claimedDelegation(
        { depth: 0, maxDepth: 1, maxChildren: 3 },
        { parentSessionId: "parent", toolCallId: "call-1" },
      ),
    ).toEqual(CHILD);
    expect(claimKey({ parentSessionId: "parent", toolCallId: "call-1" })).toBe("parent:call-1");
  });
});

describe("assertDelegation — every way ancestry can be incoherent", () => {
  it("accepts the two shapes that can exist", () => {
    expect(() => assertDelegation(ROOT)).not.toThrow();
    expect(() => assertDelegation(CHILD)).not.toThrow();
  });

  it.each([
    ["a fractional depth", { ...ROOT, depth: 1.5 }, "whole number"],
    ["a depth past the ceiling", { ...ROOT, maxDepth: 2 }, "max depth exceeds"],
    ["a fan-out past the ceiling", { ...ROOT, maxChildren: 4 }, "max children exceeds"],
    ["a root naming a parent", { ...ROOT, parentSessionId: "parent" }, "cannot name a parent"],
    ["a child with no parent", { ...CHILD, parentSessionId: null }, "must name its parent"],
    ["a depth past its own bound", { ...CHILD, depth: 2 }, "cannot exceed its frozen max depth"],
    ["a root naming a claim", { ...ROOT, claimToolCallId: "call-1" }, "cannot name a parent tool"],
    ["a child with no claim", { ...CHILD, claimToolCallId: null }, "must name the parent tool"],
    ["a child with an empty claim", { ...CHILD, claimToolCallId: "" }, "cannot be empty"],
  ])("refuses %s", (_label, value, message) => {
    expect(() => assertDelegation(value)).toThrow(message);
  });
});
