import { afterEach, describe, expect, it } from "vite-plus/test";

import { insertProject } from "../db/projects-repo";
import { insertTicket } from "../db/tickets-repo";
import { insertSession } from "../session-control/test-support";
import { openTestDb, testProject, testSession, testTicket } from "../db/test-helpers";
import type { TestDb } from "../db/test-helpers";

import {
  DEFAULT_TICKET_SESSION_DELEGATION,
  createTicketSessionDelegationStore,
} from "./delegation-store";

let ctx: TestDb | undefined;

afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

function harness() {
  ctx = openTestDb();
  const project = testProject({ id: "project-1" });
  const ticket = testTicket(project.id, { id: "ticket-1", ticketNumber: 1 });
  const otherTicket = testTicket(project.id, { id: "ticket-2", ticketNumber: 2 });
  const root = testSession(project.id, ticket.id, { id: "root-session" });
  insertProject(ctx.db, project);
  insertTicket(ctx.db, ticket);
  insertTicket(ctx.db, otherTicket);
  insertSession(ctx.db, root);
  return {
    db: ctx.db,
    ticket,
    otherTicket,
    root,
    store: createTicketSessionDelegationStore(ctx.db),
  };
}

describe("Ticket Session delegation grants", () => {
  it("records a root Ticket Session's canonical own-ticket grant and frozen bounds at birth", () => {
    const h = harness();

    const birth = h.store.resolveBirth({ role: "ticket", ticketId: h.ticket.id });
    h.store.recordBirth(h.root.id, birth);

    expect(birth).toEqual({
      grants: ["session.start"],
      delegation: {
        parentSessionId: null,
        depth: 0,
        maxDepth: DEFAULT_TICKET_SESSION_DELEGATION.maxDepth,
        maxChildren: DEFAULT_TICKET_SESSION_DELEGATION.maxChildren,
        claimToolCallId: null,
      },
    });
    expect(h.store.readStartGrant(h.root.id)).toEqual({
      scope: "own-ticket",
      maxDepth: DEFAULT_TICKET_SESSION_DELEGATION.maxDepth,
      maxChildren: DEFAULT_TICKET_SESSION_DELEGATION.maxChildren,
    });
    expect(
      h.db
        .prepare(
          "SELECT verb, scope, max_depth, max_children FROM session_verb_grants WHERE session_id = ?",
        )
        .get(h.root.id),
    ).toEqual({
      verb: "session.start",
      scope: "own-ticket",
      max_depth: DEFAULT_TICKET_SESSION_DELEGATION.maxDepth,
      max_children: DEFAULT_TICKET_SESSION_DELEGATION.maxChildren,
    });
  });

  it("rejects delegation limits beyond the hard fork-bomb ceiling", () => {
    const h = harness();

    expect(() =>
      h.store.resolveBirth({
        role: "ticket",
        ticketId: h.ticket.id,
        delegation: {
          parentSessionId: null,
          depth: 0,
          maxDepth: 3,
          maxChildren: 4,
          claimToolCallId: null,
        },
      }),
    ).toThrow("hard ceiling");
  });

  it("claims one bounded start per tool-call identity and never spends the same call twice", () => {
    const h = harness();
    h.store.recordBirth(h.root.id, h.store.resolveBirth({ role: "ticket", ticketId: h.ticket.id }));

    const first = h.store.claimStart({
      parentSessionId: h.root.id,
      ticketId: h.ticket.id,
      toolCallId: "call-1",
    });
    const replay = h.store.claimStart({
      parentSessionId: h.root.id,
      ticketId: h.ticket.id,
      toolCallId: "call-1",
    });
    const second = h.store.claimStart({
      parentSessionId: h.root.id,
      ticketId: h.ticket.id,
      toolCallId: "call-2",
    });
    const third = h.store.claimStart({
      parentSessionId: h.root.id,
      ticketId: h.ticket.id,
      toolCallId: "call-3",
    });
    const overLimit = h.store.claimStart({
      parentSessionId: h.root.id,
      ticketId: h.ticket.id,
      toolCallId: "call-4",
    });

    expect(first).toEqual({
      ok: true,
      delegation: {
        parentSessionId: h.root.id,
        depth: 1,
        maxDepth: DEFAULT_TICKET_SESSION_DELEGATION.maxDepth,
        maxChildren: DEFAULT_TICKET_SESSION_DELEGATION.maxChildren,
        claimToolCallId: "call-1",
      },
    });
    expect(replay).toEqual(first);
    expect(second).toMatchObject({ ok: true });
    expect(third).toMatchObject({ ok: true });
    expect(overLimit).toEqual({ ok: false, reason: "limit" });
  });

  it("reclaims a failed start claim without letting a replay spend a second slot", () => {
    const h = harness();
    h.store.recordBirth(h.root.id, h.store.resolveBirth({ role: "ticket", ticketId: h.ticket.id }));
    for (const toolCallId of ["call-1", "call-2", "call-3"]) {
      expect(
        h.store.claimStart({ parentSessionId: h.root.id, ticketId: h.ticket.id, toolCallId }),
      ).toMatchObject({ ok: true });
    }
    expect(
      h.store.claimStart({
        parentSessionId: h.root.id,
        ticketId: h.ticket.id,
        toolCallId: "call-4",
      }),
    ).toEqual({ ok: false, reason: "limit" });

    h.store.releaseIfUnstarted({
      parentSessionId: h.root.id,
      toolCallId: "call-1",
      createCommandId: `${h.root.id}:call-1:create`,
    });

    expect(
      h.store.claimStart({
        parentSessionId: h.root.id,
        ticketId: h.ticket.id,
        toolCallId: "call-4",
      }),
    ).toMatchObject({ ok: true });
  });

  it("does not hand a child at the depth bound another start tool", () => {
    const h = harness();
    h.store.recordBirth(h.root.id, h.store.resolveBirth({ role: "ticket", ticketId: h.ticket.id }));
    const claimed = h.store.claimStart({
      parentSessionId: h.root.id,
      ticketId: h.ticket.id,
      toolCallId: "call-1",
    });
    if (!claimed.ok) throw new Error("Expected the root grant to claim one child");

    const child = testSession("project-1", h.ticket.id, { id: "child-session" });
    insertSession(h.db, child);
    const childBirth = h.store.resolveBirth({
      role: "ticket",
      ticketId: h.ticket.id,
      delegation: claimed.delegation,
    });
    h.store.recordBirth(child.id, childBirth);

    expect(childBirth.grants).toEqual([]);
    expect(
      h.store.claimStart({
        parentSessionId: child.id,
        ticketId: h.ticket.id,
        toolCallId: "grandchild",
      }),
    ).toEqual({ ok: false, reason: "not-granted" });
  });
});
