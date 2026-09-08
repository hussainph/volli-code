/**
 * Which native alert comes from where, which switch governs it, and where a
 * click on it lands (VC-295).
 *
 * ── WHY A CATALOG AND NOT A CATEGORY ARGUMENT ─────────────────────────────
 * The preferences shipped before their producers did: four switches were drawn,
 * one of them (`needs-you`) was read by exactly one call site, and the other
 * three governed nothing while main went on constructing `new Notification`
 * directly in six places. Two failures come out of that, and they are opposite
 * shapes of the same missing table:
 *
 *  - a SWITCH WITH NO PRODUCER — `finished` promised "a session finishes" and
 *    no code anywhere consulted it. A control that does nothing is worse than
 *    an absent one, because the person believes they have turned something off;
 *  - a PRODUCER WITH NO POLICY — a direct alert nobody decided about, which is
 *    every alert that is not muteable and not documented as unmuteable.
 *
 * So the mapping is data, checked exhaustively by its own test: every producer
 * this build has names its policy here, and every preference event must have at
 * least one producer. Adding a `new Notification` without an entry here does not
 * compile, because the one delivery path (`main/notifications/dispatch.ts`)
 * takes a {@link NotificationProducer} rather than a title and a body.
 *
 * ── PREFERENCE OR OPERATIONAL ─────────────────────────────────────────────
 * Two policies, and the split is about whose decision the alert is:
 *
 *  - `preference` — an alert about the WORK. A person may reasonably not want
 *    to be told that a Run is waiting or a PR merged; nothing is lost but the
 *    telling, because the durable fact stays on the board and in the Session.
 *  - `operational` — an alert about VOLLI, or one a person's own agent was
 *    explicitly told to send. A failed CLI socket, a durable write that did not
 *    land, an unattended ticket pushed into Doing, and `volli notify` are not
 *    tastes: three are faults with no other voice (CLAUDE.md's never-swallow
 *    rule; the last is a guardrail VC-92 §3 asked for), and the fourth is an
 *    instruction. A notifications preference that could silence them would be a
 *    mute button on the smoke alarm.
 *
 * Operational does NOT mean "no target": the ticket-move alert points at a real
 * ticket. What it means is that no preference is consulted. What is forbidden is
 * an INVENTED target — a free-form `volli notify` names nothing, so it opens
 * nothing.
 */

import {
  notificationAllowed,
  type NotificationEvent,
  type NotificationPreferences,
} from "./notification-preferences";

/**
 * Every source of a native alert in this build.
 *
 * The ids name the PRODUCER, not the category, because that is the axis that
 * changes: two producers can share a switch (three do), and a producer that is
 * retired has to be removed from one table rather than hunted for.
 */
export const NOTIFICATION_PRODUCERS = [
  /** An unattended Automation Run entered `waiting` or `error` (VC-112, VC-133). */
  "run-attention",
  /** The watchdog found an open turn with no runtime progress (VC-86). */
  "session-watchdog",
  /** A verified harness hook reported that its agent is blocked on a human. */
  "harness-input-needed",
  /** The retention watch saw a ticket's pull request merge. */
  "pull-request-merged",
  /** The retention watch reclaimed a stale worktree directory (VC-113). */
  "worktree-reclaimed",
  /** A downloaded update is staged and installs on quit (VC-24, VC-59). */
  "update-ready",
  /** A ticket entered Doing over the agent socket rather than at the keyboard. */
  "ticket-moved-to-doing",
  /** `volli notify` — an agent asked for these exact words. */
  "agent-notify",
  /** The retention watch could not record a discovered PR url. */
  "worktree-record-failed",
  /** The agent socket failed to start; the bundled CLI is dead this launch. */
  "cli-socket-failed",
] as const;

export type NotificationProducer = (typeof NOTIFICATION_PRODUCERS)[number];

/**
 * What governs one producer: a switch a person owns, or nothing at all with the
 * reason stated. The reason is a field rather than a comment so the exhaustive
 * test can assert that every operational alert HAS one — "we forgot" and "we
 * decided" look identical otherwise.
 */
export type NotificationPolicy =
  | { kind: "preference"; event: NotificationEvent }
  | { kind: "operational"; reason: string };

/**
 * The whole mapping, in one table.
 *
 * A total `Record`, so a producer added to {@link NOTIFICATION_PRODUCERS}
 * without a policy is a compile error rather than an alert that quietly escapes
 * the preferences.
 *
 * On the two renamings this table settles:
 *
 *  - **`finished` is a merged pull request**, not "a session finishes". No
 *    production source ever posted the latter, and inventing one to justify the
 *    switch would be building a feature to defend a label. A PR merging is the
 *    completion this app genuinely observes, so the switch keeps its stored id
 *    (a rename would silently reset everyone's choice) and the UI says what it
 *    actually governs.
 *  - **`swept` is worktree maintenance**, which today is the duration-gated
 *    reclaim. The failed-stamp alert beside it is NOT swept: it is a write that
 *    did not land.
 */
export const NOTIFICATION_PRODUCER_POLICY: Record<NotificationProducer, NotificationPolicy> = {
  "run-attention": { kind: "preference", event: "needs-you" },
  "session-watchdog": { kind: "preference", event: "needs-you" },
  "harness-input-needed": { kind: "preference", event: "needs-you" },
  "pull-request-merged": { kind: "preference", event: "finished" },
  "worktree-reclaimed": { kind: "preference", event: "swept" },
  "update-ready": { kind: "preference", event: "update" },
  "ticket-moved-to-doing": {
    kind: "operational",
    reason:
      "A guardrail: work pushed into the active column by a caller who is not at the keyboard (VC-92 §3). A preference must not be able to hide it.",
  },
  "agent-notify": {
    kind: "operational",
    reason:
      "`volli notify` — an agent was told to say exactly this. Volli is the messenger, so there is no Volli preference to consult.",
  },
  "worktree-record-failed": {
    kind: "operational",
    reason:
      "A durable write that did not land, in a background pass with no other user-visible surface. Never silently swallowed (CLAUDE.md).",
  },
  "cli-socket-failed": {
    kind: "operational",
    reason:
      "The bundled CLI is dead for this launch. A fault about Volli itself, with a console line as its only alternative.",
  },
};

/** One producer's policy. A lookup with a name, so call sites read as sentences. */
export function notificationProducerPolicy(producer: NotificationProducer): NotificationPolicy {
  return NOTIFICATION_PRODUCER_POLICY[producer];
}

/**
 * Every producer a category governs, in catalog order.
 *
 * Exists for the test that keeps Settings honest — a switch whose list is empty
 * is a control with nothing behind it — and for anything that later wants to
 * explain a category by what it actually sends.
 */
export function producersForNotificationEvent(
  event: NotificationEvent,
): readonly NotificationProducer[] {
  return NOTIFICATION_PRODUCERS.filter((producer) => {
    const policy = NOTIFICATION_PRODUCER_POLICY[producer];
    return policy.kind === "preference" && policy.event === event;
  });
}

/** Every alert that is outside the preferences, in catalog order. */
export function operationalNotificationProducers(): readonly NotificationProducer[] {
  return NOTIFICATION_PRODUCERS.filter(
    (producer) => NOTIFICATION_PRODUCER_POLICY[producer].kind === "operational",
  );
}

/**
 * Whether this machine's preferences permit this producer.
 *
 * The ONE place the catalog and {@link notificationAllowed} meet, which is what
 * makes "a call site cannot skip the preference" structural: the delivery path
 * asks this, and nothing else in the app is given a category to ask about.
 */
export function notificationProducerAllowed(
  preferences: NotificationPreferences,
  producer: NotificationProducer,
): boolean {
  const policy = NOTIFICATION_PRODUCER_POLICY[producer];
  return policy.kind === "operational" || notificationAllowed(preferences, policy.event);
}

/**
 * Where a click on an alert goes — and, read the other way, what a window is
 * currently showing.
 *
 * One union serving both directions on purpose: focused-target suppression is
 * the question "is this alert's target the thing already in front of the
 * person", and two vocabularies for the two halves is how that comparison comes
 * to be made between things that only look alike.
 *
 * JSON-safe by construction (docs/BOUNDARIES.md rule 3): plain objects, no
 * optional fields, `null` where a fact is absent — it crosses the IPC seam in
 * both directions.
 */
export interface SessionNotificationTarget {
  kind: "session";
  projectId: string;
  /** Null for a Board (project-level) Session, which has no ticket. */
  ticketId: string | null;
  sessionId: string;
  /** The open question this alert is about, when it named one. */
  interactionId: string | null;
  /** The blocking attention this alert is about, when it named one. */
  attentionId: string | null;
}

export interface TicketNotificationTarget {
  kind: "ticket";
  projectId: string;
  ticketId: string;
}

export interface UpdateNotificationTarget {
  kind: "update";
}

export type NotificationTarget =
  | SessionNotificationTarget
  | TicketNotificationTarget
  | UpdateNotificationTarget;

/**
 * The one thing in a Session a person is being sent to — the open question, or
 * the failure that stopped it.
 *
 * Computed by {@link sessionNotificationItem} on BOTH sides of the suppression
 * comparison: the producer names the item its alert is about, and the window
 * reports the item it is currently showing. Two different derivations of "which
 * item" would make the comparison meaningless — a window showing a question
 * would suppress an alert about the failure beside it, which is the exact bug a
 * session-id-only match had.
 */
export interface SessionNotificationItem {
  interactionId: string | null;
  attentionId: string | null;
}

/** Nothing in particular — a Session with no open question and no failure. */
export const NO_SESSION_NOTIFICATION_ITEM: SessionNotificationItem = Object.freeze({
  interactionId: null,
  attentionId: null,
});

/** A non-empty string id, or `null` for anything else — including `""`. */
function optionalId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * One target as it arrives from a client, or `null` when it is not one.
 *
 * The renderer reports what it is showing over IPC, so this crosses a trust
 * boundary in the direction that matters: a malformed or foreign payload must
 * become "no target" rather than an object that later compares equal to
 * something. Strict about the fields it keeps — an unknown kind, a missing id,
 * or a non-string id is refused outright — and it never carries extra keys
 * through, so what is stored is always exactly this vocabulary.
 */
export function parseNotificationTarget(raw: unknown): NotificationTarget | null {
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as Record<string, unknown>;
  switch (candidate["kind"]) {
    case "session": {
      const projectId = candidate["projectId"];
      const sessionId = candidate["sessionId"];
      if (typeof projectId !== "string" || typeof sessionId !== "string") return null;
      if (projectId.length === 0 || sessionId.length === 0) return null;
      return {
        kind: "session",
        projectId,
        ticketId: optionalId(candidate["ticketId"]),
        sessionId,
        interactionId: optionalId(candidate["interactionId"]),
        attentionId: optionalId(candidate["attentionId"]),
      };
    }
    case "ticket": {
      const projectId = candidate["projectId"];
      const ticketId = candidate["ticketId"];
      if (typeof projectId !== "string" || typeof ticketId !== "string") return null;
      if (projectId.length === 0 || ticketId.length === 0) return null;
      return { kind: "ticket", projectId, ticketId };
    }
    case "update":
      return { kind: "update" };
    default:
      return null;
  }
}

/**
 * Whether an alert's target is the target a window is already showing.
 *
 * Deliberately NARROW, which is the whole of VC-295's rule 5:
 *
 *  - **Identity, not containment.** A ticket open in front of you is not its
 *    Session, and a Session is not its ticket. Suppression means "the person is
 *    looking at exactly this", and anything looser silences an alert for work
 *    that is merely nearby.
 *  - **The ITEM is part of the identity.** A Session match compares the open
 *    question and the failure as well as the Session id. Round 1 of this ticket
 *    compared only the id, which meant a person reading one question in a
 *    Session was never told about the failure that had just stopped it — the
 *    window was "showing the target", and the thing they needed was not on it.
 *    Both sides derive the item with `sessionNotificationItem`, so this is a
 *    comparison between two answers to one question.
 *  - **`null` never matches.** An alert with no target has nowhere to be
 *    already-visible, so it is always delivered.
 *
 * Whether the window is FOCUSED is not asked here — that is Electron's fact and
 * belongs to main. This is only the identity half.
 */
export function notificationTargetMatches(
  target: NotificationTarget | null,
  active: NotificationTarget | null,
): boolean {
  if (target === null || active === null) return false;
  if (target.kind !== active.kind) return false;
  switch (target.kind) {
    case "session": {
      const shown = active as SessionNotificationTarget;
      return (
        target.sessionId === shown.sessionId &&
        target.interactionId === shown.interactionId &&
        target.attentionId === shown.attentionId
      );
    }
    case "ticket":
      return target.ticketId === (active as TicketNotificationTarget).ticketId;
    case "update":
      return true;
  }
}
