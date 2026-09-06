import { afterEach, describe, expect, it } from "vite-plus/test";

import type Database from "better-sqlite3";

import { insertProject } from "../db/projects-repo";
import { deleteTicket, insertTicket } from "../db/tickets-repo";
import { insertSession } from "../session-control/test-support";
import { openTestDb, testProject, testSession, testTicket } from "../db/test-helpers";
import type { TestDb } from "../db/test-helpers";

import { DEFAULT_TICKET_SESSION_DELEGATION } from "./delegation-policy";
import { createTicketSessionDelegationStore } from "./delegation-store";
import { sessionCreateCommandId } from "./sessions";

let ctx: TestDb | undefined;

afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

/** The id the tool door would hand the ledger for one call, spelled once. */
function createCommandFor(parentSessionId: string, toolCallId: string): string {
  return sessionCreateCommandId(`${parentSessionId}:${toolCallId}`);
}

function claim(parentSessionId: string, ticketId: string, toolCallId: string) {
  return {
    parentSessionId,
    ticketId,
    toolCallId,
    createCommandId: createCommandFor(parentSessionId, toolCallId),
  };
}

/** Stands in for the Session Engine landing a create command durably. */
function landCreateCommand(db: Database.Database, sessionId: string, commandId: string): void {
  db.prepare(
    `INSERT INTO session_commands (id, session_id, created_at, intent)
     VALUES (?, ?, 0, '{"kind":"session.create"}')`,
  ).run(commandId, sessionId);
}

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

  /**
   * `ticketId !== null` IS the Ticket Role on start, so the two disagreeing is
   * a caller that has lost track of which Session it is minting — refused
   * before anything durable exists rather than recorded as a grant with no
   * Ticket to be scoped to.
   */
  it("refuses to resolve a Ticket Role birth with no Ticket, and a Project birth with ancestry", () => {
    const h = harness();

    expect(() => h.store.resolveBirth({ role: "ticket", ticketId: null })).toThrow(
      "needs a Ticket before grants can resolve",
    );
    expect(() =>
      h.store.resolveBirth({
        role: "project",
        ticketId: null,
        delegation: {
          parentSessionId: h.root.id,
          depth: 1,
          maxDepth: 1,
          maxChildren: 3,
          claimToolCallId: "call-1",
        },
      }),
    ).toThrow("cannot inherit Ticket delegation ancestry");
  });

  it("gives a Project Session no ancestry and no grant", () => {
    const h = harness();

    const birth = h.store.resolveBirth({ role: "project", ticketId: null });
    h.store.recordBirth(h.root.id, birth);

    expect(birth).toEqual({ grants: [], delegation: null });
    expect(h.db.prepare("SELECT COUNT(*) AS count FROM session_delegations").get()).toEqual({
      count: 0,
    });
    expect(h.store.startGrantScope(h.root.id)).toBeNull();
  });

  /**
   * A start is replayed by operation id, so the birth half has to be replayable
   * too: the same answer recorded twice is one row, and a DIFFERENT answer over
   * an existing Session is a caller bug loud enough to fail the start rather
   * than quietly re-grant it.
   */
  it("records the same birth twice as one row, and refuses to overwrite a recorded one", () => {
    const h = harness();
    const birth = h.store.resolveBirth({ role: "ticket", ticketId: h.ticket.id });

    h.store.recordBirth(h.root.id, birth);
    h.store.recordBirth(h.root.id, birth);

    expect(h.db.prepare("SELECT COUNT(*) AS count FROM session_delegations").get()).toEqual({
      count: 1,
    });
    expect(h.db.prepare("SELECT COUNT(*) AS count FROM session_verb_grants").get()).toEqual({
      count: 1,
    });
    expect(() =>
      h.store.recordBirth(h.root.id, {
        grants: ["session.start"],
        delegation: {
          parentSessionId: null,
          depth: 0,
          maxDepth: 1,
          maxChildren: 2,
          claimToolCallId: null,
        },
      }),
    ).toThrow("already has a different start grant");
  });

  it("refuses to record a grant with no ancestry, or ancestry for a Session that is not a Ticket's", () => {
    const h = harness();

    expect(() =>
      h.store.recordBirth(h.root.id, { grants: ["session.start"], delegation: null }),
    ).toThrow("cannot receive a verb grant");
    expect(() =>
      h.store.recordBirth(
        "no-such-session",
        h.store.resolveBirth({ role: "ticket", ticketId: h.ticket.id }),
      ),
    ).toThrow("can only be recorded for an existing Ticket Session");
  });

  it("claims one bounded start per tool-call identity and never spends the same call twice", () => {
    const h = harness();
    h.store.recordBirth(h.root.id, h.store.resolveBirth({ role: "ticket", ticketId: h.ticket.id }));

    const first = h.store.claimStart(claim(h.root.id, h.ticket.id, "call-1"));
    const replay = h.store.claimStart(claim(h.root.id, h.ticket.id, "call-1"));
    const second = h.store.claimStart(claim(h.root.id, h.ticket.id, "call-2"));
    const third = h.store.claimStart(claim(h.root.id, h.ticket.id, "call-3"));
    const overLimit = h.store.claimStart(claim(h.root.id, h.ticket.id, "call-4"));

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
    // The whole current allowance travels with the refusal so the door can
    // name the number rather than telling a model it hit "a limit" it has no
    // way to size — and the number stays honest after extensions widen it.
    expect(overLimit).toEqual({ ok: false, reason: "limit", allowed: 3 });
  });

  /**
   * VC-204: the allowance is a soft cap. A person's "once" is one extension
   * row, and the claims ledger — not the door — stays the judge of whether the
   * next claim fits under grant-plus-extensions.
   */
  it("widens the allowance by exactly one per recorded extension", () => {
    const h = harness();
    h.store.recordBirth(h.root.id, h.store.resolveBirth({ role: "ticket", ticketId: h.ticket.id }));
    for (const toolCallId of ["call-1", "call-2", "call-3"]) {
      expect(h.store.claimStart(claim(h.root.id, h.ticket.id, toolCallId))).toMatchObject({
        ok: true,
      });
    }
    expect(h.store.claimStart(claim(h.root.id, h.ticket.id, "call-4"))).toEqual({
      ok: false,
      reason: "limit",
      allowed: 3,
    });

    h.store.recordExtension({ parentSessionId: h.root.id, toolCallId: "call-4" });
    // Idempotent per asking call: a replayed call finds its extension rather
    // than earning a second slot.
    h.store.recordExtension({ parentSessionId: h.root.id, toolCallId: "call-4" });

    expect(h.store.claimStart(claim(h.root.id, h.ticket.id, "call-4"))).toMatchObject({ ok: true });
    // One "once" was one slot: the fifth start is refused, and the refusal
    // names the widened allowance rather than the born one.
    expect(h.store.claimStart(claim(h.root.id, h.ticket.id, "call-5"))).toEqual({
      ok: false,
      reason: "limit",
      allowed: 4,
    });
  });

  it("refuses an extension for a Session never born with a start grant", () => {
    const h = harness();

    expect(() =>
      h.store.recordExtension({ parentSessionId: h.root.id, toolCallId: "call-1" }),
    ).toThrow("born with a start grant");
    expect(() => h.store.recordExtension({ parentSessionId: h.root.id, toolCallId: "" })).toThrow(
      "tool call id",
    );
  });

  /**
   * The slot belongs to the parent, not the asking call: an extension whose
   * start never became durable stays spendable, because the person granted one
   * more Session and one more Session is what they get.
   */
  it("keeps an extension spendable after its own start was released", () => {
    const h = harness();
    h.store.recordBirth(h.root.id, h.store.resolveBirth({ role: "ticket", ticketId: h.ticket.id }));
    for (const toolCallId of ["call-1", "call-2", "call-3"]) {
      expect(h.store.claimStart(claim(h.root.id, h.ticket.id, toolCallId))).toMatchObject({
        ok: true,
      });
    }
    h.store.recordExtension({ parentSessionId: h.root.id, toolCallId: "call-4" });
    expect(h.store.claimStart(claim(h.root.id, h.ticket.id, "call-4"))).toMatchObject({ ok: true });

    h.store.releaseIfUnstarted({ parentSessionId: h.root.id, toolCallId: "call-4" });

    expect(h.store.claimStart(claim(h.root.id, h.ticket.id, "call-5"))).toMatchObject({ ok: true });
  });

  it("reclaims a failed start claim without letting a replay spend a second slot", () => {
    const h = harness();
    h.store.recordBirth(h.root.id, h.store.resolveBirth({ role: "ticket", ticketId: h.ticket.id }));
    for (const toolCallId of ["call-1", "call-2", "call-3"]) {
      expect(h.store.claimStart(claim(h.root.id, h.ticket.id, toolCallId))).toMatchObject({
        ok: true,
      });
    }
    expect(h.store.claimStart(claim(h.root.id, h.ticket.id, "call-4"))).toEqual({
      ok: false,
      reason: "limit",
      allowed: 3,
    });

    h.store.releaseIfUnstarted({ parentSessionId: h.root.id, toolCallId: "call-1" });
    // Releasing a slot nobody holds is a no-op, not a crash: the door asks on
    // every failed start, including ones that failed before claiming.
    h.store.releaseIfUnstarted({ parentSessionId: h.root.id, toolCallId: "call-1" });

    expect(h.store.claimStart(claim(h.root.id, h.ticket.id, "call-4"))).toMatchObject({ ok: true });
  });

  /**
   * The grant is the Ticket bound, not just the door's own-ticket check: even a
   * caller that reached the ledger naming a sibling Ticket is refused, and a
   * replayed call cannot swap the Ticket its slot was opened for.
   */
  it("refuses any Ticket but the one the ancestry row names", () => {
    const h = harness();
    h.store.recordBirth(h.root.id, h.store.resolveBirth({ role: "ticket", ticketId: h.ticket.id }));
    h.store.claimStart(claim(h.root.id, h.ticket.id, "call-1"));

    expect(h.store.claimStart(claim(h.root.id, h.otherTicket.id, "call-2"))).toEqual({
      ok: false,
      reason: "not-granted",
    });
    expect(
      h.store.claimStart({
        ...claim(h.root.id, h.ticket.id, "call-1"),
        ticketId: h.otherTicket.id,
      }),
    ).toEqual({ ok: false, reason: "not-granted" });
    expect(
      h.db
        .prepare("SELECT ticket_id FROM session_delegation_claims WHERE tool_call_id = 'call-1'")
        .get(),
    ).toEqual({ ticket_id: h.ticket.id });
  });

  /**
   * The other half of the release rule, and the one that makes the cap durable
   * rather than merely tidy: once the create command exists the start may still
   * be replayed, so the slot it already spent must survive the failure that
   * asked for it back.
   */
  it("keeps a claim whose Session create command is already durable", () => {
    const h = harness();
    h.store.recordBirth(h.root.id, h.store.resolveBirth({ role: "ticket", ticketId: h.ticket.id }));
    h.store.claimStart(claim(h.root.id, h.ticket.id, "call-1"));
    landCreateCommand(h.db, h.root.id, createCommandFor(h.root.id, "call-1"));

    h.store.releaseIfUnstarted({ parentSessionId: h.root.id, toolCallId: "call-1" });

    expect(
      h.db
        .prepare(
          "SELECT COUNT(*) AS count FROM session_delegation_claims WHERE parent_session_id = ?",
        )
        .get(h.root.id),
    ).toEqual({ count: 1 });
  });

  /**
   * A crash lands between the claim and the create command, or between the
   * create command and the birth grant. The next process has no in-flight call
   * to protect either claim, so it must tell them apart by durable evidence
   * alone — which is exactly why the claim stores the create id rather than
   * re-deriving the tool door's operation-id convention.
   */
  it("sweeps only the claims a previous process abandoned before any Session existed", () => {
    const h = harness();
    h.store.recordBirth(h.root.id, h.store.resolveBirth({ role: "ticket", ticketId: h.ticket.id }));
    h.store.claimStart(claim(h.root.id, h.ticket.id, "started"));
    h.store.claimStart(claim(h.root.id, h.ticket.id, "abandoned"));
    landCreateCommand(h.db, h.root.id, createCommandFor(h.root.id, "started"));

    // A second store over the same database is the next process: same rows, no
    // memory of which calls were in flight.
    const nextProcess = createTicketSessionDelegationStore(h.db);
    expect(nextProcess.claimStart(claim(h.root.id, h.ticket.id, "fresh"))).toMatchObject({
      ok: true,
    });

    expect(
      h.db
        .prepare(
          "SELECT tool_call_id FROM session_delegation_claims WHERE parent_session_id = ? ORDER BY tool_call_id",
        )
        .all(h.root.id),
    ).toEqual([{ tool_call_id: "fresh" }, { tool_call_id: "started" }]);
  });

  it("does not hand a child at the depth bound another start tool", () => {
    const h = harness();
    h.store.recordBirth(h.root.id, h.store.resolveBirth({ role: "ticket", ticketId: h.ticket.id }));
    const claimed = h.store.claimStart(claim(h.root.id, h.ticket.id, "call-1"));
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
    expect(h.store.startGrantScope(child.id)).toBeNull();
    expect(h.store.claimStart(claim(child.id, h.ticket.id, "grandchild"))).toEqual({
      ok: false,
      reason: "not-granted",
    });
  });

  /**
   * A Session that predates migration 030 has no birth record at all. Applying
   * today's Role default to it on attach would be a hot privilege edit to a
   * Session whose tool surface was already frozen without it, so the honest
   * answer is that it holds nothing and can claim nothing.
   */
  it("gives a Session with no birth record no grant and no claim", () => {
    const h = harness();
    const legacy = testSession("project-1", h.ticket.id, { id: "legacy-session" });
    insertSession(h.db, legacy);

    expect(h.store.readStartGrant(legacy.id)).toBeNull();
    expect(h.store.startGrantScope(legacy.id)).toBeNull();
    expect(h.store.claimStart(claim(legacy.id, h.ticket.id, "call-1"))).toEqual({
      ok: false,
      reason: "not-granted",
    });
  });

  /**
   * `sessions.ticket_id` detaches when a Ticket is deleted, so a Ticket Session
   * can later attach as a ticketless one while its frozen tool surface still
   * names `session.start`. The grant has to outlive the Ticket for the door to
   * recognise that caller as born-scoped instead of reading a bare `project`
   * Role and applying the project-wide bound.
   */
  it("keeps a deleted Ticket's grant readable, and refuses every start under it", () => {
    const h = harness();
    h.store.recordBirth(h.root.id, h.store.resolveBirth({ role: "ticket", ticketId: h.ticket.id }));

    deleteTicket(h.db, h.ticket.id);

    expect(h.db.prepare("SELECT ticket_id FROM sessions WHERE id = ?").get(h.root.id)).toEqual({
      ticket_id: null,
    });
    expect(h.store.startGrantScope(h.root.id)).toBe("own-ticket");
    expect(h.store.claimStart(claim(h.root.id, h.otherTicket.id, "call-1"))).toEqual({
      ok: false,
      reason: "not-granted",
    });
  });
});
