/**
 * What a host announces to its clients, as domain vocabulary (VC-554).
 *
 * These payloads were the Electron IPC contract's. They moved here so the
 * host's event bus (`HostEventBus` in `@volli/host-core`) can name them
 * without importing the desktop's channel catalog: the payload is what the
 * host says, and which channel carries it is the transport's business. The
 * desktop contract re-exports every one of them, so its readers are unchanged.
 */
import type {
  AutomationCommandReceipt,
  AutomationRun,
  AutomationRunRefusalCode,
  PendingArmedRun,
} from "./automation";
import type { HarnessEvent } from "./harness/types";
import type { HarnessEventOrder, SessionListingRow } from "./session";
import type { HarnessId } from "./ticket";
import type { TicketEventActorKind } from "./ticket-events";

/**
 * A retitle main performed on its own (VC-81 auto-titling), pushed so live
 * surfaces can move their labels the same way a renderer rename does.
 */
export interface SessionRetitledEvent {
  sessionId: string;
  title: string;
}

/**
 * A run's answer: the durable Run (holding the fresh Session's id and the
 * RESOLVED model), or a coded refusal the caller classifies without string
 * matching. The Session boots detached — VC-16's optimistic open — so an ok
 * here means "durable and addressable", never "attached and delivered".
 */
export type AutomationRunStartResult =
  | { ok: true; run: AutomationRun; projectId: string; receipt: AutomationCommandReceipt }
  // `code` is absent only when the shared guard/throw envelope produced the
  // failure; every handler-authored refusal carries one.
  | {
      ok: false;
      error: string;
      code?: AutomationRunRefusalCode;
      receipt?: AutomationCommandReceipt;
    };

/** What main learned after removing an expired countdown from the pending projection. */
export type PendingArmedRunSettledNotice =
  | { kind: "attempted"; pending: PendingArmedRun; result: AutomationRunStartResult }
  | { kind: "failed"; pending: PendingArmedRun; error: string }
  | {
      kind: "abandoned";
      pending: PendingArmedRun;
      reason: "gone" | "left-column" | "disarmed" | "switched-off";
    };

/**
 * A coarse hint at WHAT a {@link DataChangedEvent} touched. Readers decide
 * whether to re-hydrate from `ticketId`, never from this. Kept a small closed
 * union so every producer names its change.
 *
 * One reader does act on it (VC-286): `worktree` is the kind that can move a
 * ticket's CHECKOUT — materialized, removed, recreated, scope switched — and
 * the renderer's venue boundary (`lib/boot.ts`) discards the ticket's cached
 * venue reading on it. So a producer whose change moves a checkout MUST name
 * `worktree`; one that omits `kind` re-hydrates the board but leaves the venue
 * where it was.
 */
export type DataChangeKind = "ticket" | "comment" | "session" | "worktree" | "retention";

/**
 * Main→renderer invalidation after a planning mutation that happened OUTSIDE the
 * renderer's own request/response cycle (a socket-originated agent command, a
 * session-lifecycle worktree boot, a worktree/retention side effect). The
 * renderer always re-hydrates the board wholesale on receipt (cheap SQLite reads
 * — the recovery guarantee); the optional scope only lets a per-ticket surface
 * skip a refetch when the change PROVABLY targets a different ticket.
 *
 * An UNTARGETED payload — one with no `ticketId` — means "anything may have
 * changed" and every reader must still react to it (the conservative arm). A
 * targeted payload carries the affected `ticketId` (and, when the producer knows
 * it, its `projectId`), so a reader watching that ticket refreshes promptly
 * while readers for other tickets stand down.
 */
export interface DataChangedEvent {
  entity: "tickets";
  /** The ticket the change targets; omitted for an untargeted (anything-changed) broadcast. */
  ticketId?: string;
  /** The project the change belongs to, when the producer knows it. */
  projectId?: string;
  /**
   * Hint at what changed. Never the basis of whether a reader re-hydrates — but
   * `worktree` is load-bearing for the venue boundary; see {@link DataChangeKind}.
   */
  kind?: DataChangeKind;
}

/**
 * Main→renderer announcement that a backward move interrupted live agent
 * sessions (issue #78, CONCEPT #20). Fired only when `sessionIds` is
 * non-empty — an empty interrupt announces nothing, mirroring the event log.
 */
export interface SessionsInterruptedEvent {
  ticketId: string;
  sessionIds: string[];
}

/**
 * One canonical harness event, as it reaches the renderer (harness-events). The
 * involuntary channel: a hook the wrapper configured fired, `volli hook`
 * forwarded it over the socket, and main resolved which session it belongs to.
 * Harness-native event names never get this far — the union is the whole
 * vocabulary.
 *
 * `sessionId` is the FULL session id (the same key terminal data/exit events
 * carry), not the short public handle, because this addresses the renderer's
 * live session state rather than a human reader.
 */
export interface HarnessEventNotice {
  sessionId: string;
  projectId: string;
  /** The ticket this session drives, or `null` for a Board Session. */
  ticketId: string | null;
  harnessId: HarnessId;
  event: HarnessEvent;
  /**
   * The harness's own session id when the event carried one — already persisted
   * on the session record by the time this fires. `null` on the events that
   * carry none, which is most of them.
   */
  harnessSessionId: string | null;
  /** Epoch ms the event was ingested (main's clock, never the harness's). */
  at: number;
  /**
   * Epoch ms the hook process that reported this event STARTED, off that
   * process's own wall clock — {@link HarnessEventOrder}, and the only field on
   * this notice that says anything about the order the harness fired things in.
   * `null` when the delivery carried none, which an older `volli` always will.
   *
   * `at` is deliberately not that field and cannot be made into it: each event
   * arrives on its own short-lived process over its own connection, so arrival
   * order is a property of the races between them rather than of the agent.
   */
  firedAt: HarnessEventOrder;
}

/**
 * Main→renderer: a different harness is now running in one session's terminal,
 * as announced by its own launch wrapper (`volli session harness <slug>`).
 *
 * A SIBLING of {@link HarnessEventNotice} rather than a member of it, because
 * it is not one: this is not a canonical harness event, it is not in
 * `HARNESS_EVENTS`, it comes from the PATH shim rather than from a hook, and it
 * carries no `firedAt` to be ordered by — the wrapper runs once per launch, so
 * the newest announce IS the running harness and there is no race to settle.
 * Folding it into the event union would have every reader of that union
 * pattern-matching around a member that answers none of its questions.
 *
 * Fired on every announce, INCLUDING the overwhelmingly common one that agrees
 * with what Volli already believes. An announce is a LAUNCH — the wrapper runs
 * once per invocation, from the harness's own process — and a launch is the
 * moment the reporting channel starts owing us an event. Firing only on a
 * changed slug meant quitting a harness and starting the same one again in one
 * terminal left the second launch wearing the first one's reputation.
 */
export interface SessionHarnessNotice {
  /** The FULL session id — this addresses live renderer state, not a human reader. */
  sessionId: string;
  projectId: string;
  /** The ticket this session drives, or `null` for a Board Session. */
  ticketId: string | null;
  /** The harness now running there. The session's LAUNCH harness is unchanged. */
  harnessId: HarnessId;
  /**
   * Whether this announce named a DIFFERENT harness than the session was
   * already believed to be running. Not a gate on the notice — every launch is
   * broadcast — but the durable record only has to be repointed when it moved.
   */
  changed: boolean;
  /** Epoch ms the announce was ingested (main's clock). */
  at: number;
}

/**
 * Main→renderer: a structured chat Session was started on a ticket through the
 * agent socket (`volli session start`, VC-13). The renderer toasts it —
 * "<actor> started a session on VC-4" — with an action that opens the
 * session's chat tab; without the click nothing moves. Board/sidebar surfaces
 * refresh through the ordinary `volli:data-changed` path, so this notice only
 * carries what the toast itself says and where its action goes.
 */
export interface SessionStartedNotice {
  /** The FULL session id — the action addresses live renderer state, not a human reader. */
  sessionId: string;
  projectId: string;
  ticketId: string;
  /** The started ticket's display id, precomputed so the toast never joins. */
  ticketDisplayId: string;
  /**
   * Who started it, as the door that started it derived them — never
   * self-declared.
   *
   * Two doors produce this since VC-163: the `session_start` tool, which binds
   * its caller from the attachment the call arrived on, and the app, which is
   * the person. The shell was a third until VC-163 closed it.
   */
  actor: TicketEventActorKind;
  /** Display id of the ticket the starting session was itself working, when known. */
  actorTicket: string | null;
  /** Epoch ms the start was ingested (main's clock). */
  at: number;
}

/**
 * Main→renderer: one Session's listing row, re-derived after its durable
 * history moved.
 *
 * It carries the WHOLE {@link SessionListingRow} rather than a compact
 * activity delta, and that is the point. Every renderer listing already holds
 * exactly these rows (`volli:session-list` returns them), so applying a notice
 * is an upsert keyed by Session id and never a second vocabulary that has to
 * be kept in step with the fetched one. A Session that has just been created
 * arrives complete, so a listing learns about it without refetching anything;
 * a retitle and a turn boundary travel the same way, so there is one channel to
 * reason about rather than one per fact.
 *
 * `projectId` rides at the top level even though both record shapes carry it,
 * because a window filters on it before it looks inside: a listing scoped to
 * one project must be able to drop another project's notice without
 * discriminating the union first.
 *
 * Broadcast to every window, like every other Session notice — a Session's rows
 * are visible wherever its project is open.
 */
export interface SessionActivityNotice {
  projectId: string;
  /** The ticket this Session drives, or `null` for a Board Session. */
  ticketId: string | null;
  row: SessionListingRow;
}

/**
 * The transient lifecycle of a worktree `ensure` pipeline. NEVER persisted —
 * on boot, truth is recomputed from disk — so a phase only exists while (or
 * just after) an ensure ran in this app session.
 */
export type WorktreePhase = "creating" | "copying" | "setting-up" | "ready" | "failed";

/** One `volli:worktree-phase` push: the ticket whose ensure moved, and where to. */
export interface WorktreePhaseEvent {
  ticketId: string;
  phase: WorktreePhase;
}

/** The best scope a caller can name; `entity` is stamped by the fan-out. */
export type DataChangeScope = Omit<DataChangedEvent, "entity">;
