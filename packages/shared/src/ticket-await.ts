/**
 * The await vocabulary: what a Session may block on, and how a request for it
 * is read (VC-85).
 *
 * VC-92's ruling fixed the surface — watch/wake is control tier, a named tool
 * in both the `project` and `ticket` Role bundles, and *what may be awaited*
 * is per-actor policy data (`AuthorityActorPolicy.awaitable`) rather than a
 * bundle question. This module is the vocabulary both halves spell: the
 * policy list names {@link TicketAwaitKind}s, and the `ticket.await` tool's
 * `for` field offers the same words plus `any`.
 *
 * The kinds are deliberately narrower than {@link TICKET_EVENT_KINDS}. An
 * orchestrator waits for a verdict, a reply, or a board move — the three facts
 * another Session's work produces on purpose. Waking on every planner fact
 * (retitles, label edits, worktree plumbing) would hand back a turn per
 * bookkeeping write, which is the polling cost this tool exists to end, paid
 * in wakes instead of polls.
 */

import type { TicketEventKind } from "./ticket-events";

/** What one wake may be waited on: a verdict signal, a comment, or a board move. */
export const TICKET_AWAIT_KINDS = ["signal", "comment", "status"] as const;

/**
 * One parked turn may watch a fleet, not an unbounded request payload. A
 * hundred tickets covers the orchestration use case while keeping target
 * resolution, policy filtering, and a future distributed subscription
 * bounded by a contract every host can enforce.
 */
export const MAX_TICKET_AWAIT_TARGETS = 100;

export type TicketAwaitKind = (typeof TICKET_AWAIT_KINDS)[number];

/** The `for` vocabulary the tool offers: every await kind, plus `any` for their union. */
export const TICKET_AWAIT_FOR = [...TICKET_AWAIT_KINDS, "any"] as const;

export type TicketAwaitFor = (typeof TICKET_AWAIT_FOR)[number];

export function isTicketAwaitFor(value: unknown): value is TicketAwaitFor {
  return typeof value === "string" && (TICKET_AWAIT_FOR as readonly string[]).includes(value);
}

/**
 * The Ticket Event kind one await kind wakes on.
 *
 * A total map rather than three conditionals, so adding an await kind without
 * deciding what it wakes on fails to compile — the same discipline the Role
 * bundle map holds. `signal` names the `signaled` planner fact slice B mints;
 * this module deliberately knows the kind by name only, so the two slices
 * meet at the event vocabulary and nowhere else.
 */
export const TICKET_AWAIT_EVENT_KINDS: Readonly<Record<TicketAwaitKind, TicketEventKind>> =
  Object.freeze({
    signal: "signaled",
    comment: "commented",
    status: "status_changed",
  });

/**
 * The await kinds a `for` request asks for, before policy is consulted.
 *
 * `any` is the union of the whole vocabulary, not a fourth kind: policy lists
 * never contain it, and a caller asking for `any` is asking for every kind its
 * policy admits.
 */
export function ticketAwaitKindsFor(request: TicketAwaitFor): readonly TicketAwaitKind[] {
  return request === "any" ? TICKET_AWAIT_KINDS : [request];
}

/**
 * One `tickets` field, read as display ids.
 *
 * The tool field is a single string because the registry's field vocabulary is
 * deliberately small; models write "VC-12 VC-14" or "VC-12, VC-14" and both
 * mean the same two tickets. Splitting is the whole parse — whether an id
 * names a real Ticket in the caller's project is the host's judgement, made
 * against the project the attachment is bound to.
 */
export function parseTicketAwaitTargets(raw: string): readonly string[] {
  const targets = raw
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  return [...new Set(targets)];
}
