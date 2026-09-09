/**
 * The Session await vocabulary: what a Session may block on when it waits on
 * another SESSION, and how a request for it is read (VC-324 item 3).
 *
 * `ticket-await.ts`'s twin, one ledger over. `ticket_await` wakes on Ticket
 * Events only, so a Board Session supervising a fleet had to make every child
 * post a Ticket Signal at the end of every stage just to be waited on — and a
 * fact no child chose to publish (a host outage that interrupted four of them
 * mid-turn) could not be waited on at all. The facts were already durable in
 * each child's own Session ledger; nothing could park on them.
 *
 * ## Why a second vocabulary and not a widened one
 *
 * {@link TicketAwaitKind} names planner facts and this names Session Events:
 * two ledgers, two sequences, two cursors. Merging them would give one policy
 * list two meanings and one cursor two orders — so `AuthorityActorPolicy`
 * carries `awaitable` and `awaitableSessions` side by side, and the two tools
 * share field NAMES (`for`, `timeoutSeconds`, `cursor`) rather than a type.
 *
 * ## Narrow on purpose
 *
 * A Session writes durable facts constantly — every command, receipt, usage
 * record and attachment note is one. Waking on all of them would hand back a
 * turn per bookkeeping write, which is the polling cost this tool exists to
 * end, paid in wakes instead of polls. So the kinds below are the facts
 * another Session's work produces ON PURPOSE and that an orchestrator has a
 * decision to make about.
 *
 * One await kind maps to a LIST of Session Event kinds, where the ticket map
 * maps to one. `turn` is the reason: the ledger separates `turn.completed`
 * from `turn.interrupted` deliberately, and an orchestrator waiting for "the
 * child is done talking" wants both while still being told which it got.
 */

import type { SessionEventPayload } from "./session-ledger";

/** Every durable Session Event kind, as this module names them. */
type SessionEventKind = SessionEventPayload["kind"];

/**
 * What one wake may be waited on today: a turn ending, a verdict, or a stop.
 *
 * - `turn` — the target finished or was interrupted mid-turn. "A child
 *   answered" is this, not a fact of its own.
 * - `verdict` — the target signalled `done` or `blocked` on itself.
 * - `stopped` — a supervisor, a person, or the watchdog ended its work.
 */
export const SESSION_AWAIT_KINDS = ["turn", "verdict", "stopped"] as const;

export type SessionAwaitKind = (typeof SESSION_AWAIT_KINDS)[number];

/**
 * One parked turn may watch a fleet, not an unbounded request payload. The
 * same hundred {@link MAX_TICKET_AWAIT_TARGETS} allows, for the same reason
 * and deliberately the same number: the two tools are one discipline, and a
 * fleet that fits one wait must fit the other.
 */
export const MAX_SESSION_AWAIT_TARGETS = 100;

/** The `for` vocabulary the tool offers: every await kind, plus `any` for their union. */
export const SESSION_AWAIT_FOR = [...SESSION_AWAIT_KINDS, "any"] as const;

export type SessionAwaitFor = (typeof SESSION_AWAIT_FOR)[number];

export function isSessionAwaitFor(value: unknown): value is SessionAwaitFor {
  return typeof value === "string" && (SESSION_AWAIT_FOR as readonly string[]).includes(value);
}

/**
 * The Session Event kinds one await kind wakes on.
 *
 * A total map rather than a chain of conditionals, so adding an await kind
 * without deciding what it wakes on fails to compile — the discipline
 * {@link TICKET_AWAIT_EVENT_KINDS} holds. The values are typed as real
 * {@link SessionEventPayload} kinds, so a ledger kind that is renamed or
 * retired breaks here rather than producing a wait that silently never wakes.
 */
export const SESSION_AWAIT_EVENT_KINDS: Readonly<
  Record<SessionAwaitKind, readonly SessionEventKind[]>
> = Object.freeze({
  turn: Object.freeze(["turn.completed", "turn.interrupted"]) as readonly SessionEventKind[],
  verdict: Object.freeze(["session.signaled"]) as readonly SessionEventKind[],
  stopped: Object.freeze(["session.stopped"]) as readonly SessionEventKind[],
});

/**
 * The await kinds a `for` request asks for, before policy is consulted.
 *
 * `any` is the union of the whole vocabulary, not a fourth kind: policy lists
 * never contain it, and a caller asking for `any` is asking for every kind its
 * policy admits.
 */
export function sessionAwaitKindsFor(request: SessionAwaitFor): readonly SessionAwaitKind[] {
  return request === "any" ? SESSION_AWAIT_KINDS : [request];
}

/**
 * The Session Event kinds a set of await kinds resolves to, de-duplicated and
 * in vocabulary order.
 *
 * De-duplicated because the map is many-to-many in principle: two await kinds
 * that came to share an event kind must not put that kind in a query's `IN`
 * list twice, and the cursor repo's `LIMIT 1` scan should not have to care.
 */
export function sessionAwaitEventKinds(
  kinds: readonly SessionAwaitKind[],
): readonly SessionEventKind[] {
  return [...new Set(kinds.flatMap((kind) => SESSION_AWAIT_EVENT_KINDS[kind]))];
}

/**
 * One `sessions` field, read as short Session handles.
 *
 * The tool field is a single string because the registry's field vocabulary is
 * deliberately small; models write "a1b2c3d4 e5f6a7b8" or the same pair with a
 * comma and both mean the same two Sessions. Splitting is the whole parse —
 * whether a handle names a real Session the caller may await is the host's
 * judgement, made against the project the attachment is bound to.
 */
export function parseSessionAwaitTargets(raw: string): readonly string[] {
  const targets = raw
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  return [...new Set(targets)];
}
