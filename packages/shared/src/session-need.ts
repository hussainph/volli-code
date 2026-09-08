/**
 * When a Session needs a PERSON (VC-112, "Notification rule"; VC-133).
 *
 * VC-112 states the rule in two words and mints no concept for it: **notify an
 * unattended Run when its Session enters `waiting` or `error`.** Both are
 * existing `StatusDotState` values, so this module's whole job is to say which
 * durable projection facts put a Session in one of them — not to invent a third
 * vocabulary that a surface would then have to reconcile with the dot.
 *
 * ── WHY IT LIVES HERE, BESIDE `sessionAwaitsUser` ─────────────────────────
 * The `waiting` half already exists and is already shared: `sessionAwaitsUser`
 * is read by the chat listing row and by the sidebar's Active band, and its own
 * doc comment says why it is written once ("two hand-copies of this rule is how
 * one of them comes to show a question the other has already stopped believing
 * in"). A notification that decided `waiting` for itself would be exactly that
 * third copy, and it would be the copy nobody sees drift — a dot on screen is
 * checked by whoever looks at it, while a notification that failed to fire is
 * silent by construction. So this composes the existing predicate rather than
 * restating it, and only the `error` half is new here.
 *
 * ── WHAT `error` IS, IN DURABLE TERMS ─────────────────────────────────────
 * "The Session's plumbing failed" is an ACTIVE Attention of a failure kind. The
 * Attention vocabulary already sorts itself into three groups, and only one of
 * them is a failure:
 *
 *  - The three {@link SESSION_USER_BLOCKING_ATTENTION_KINDS} — a person is
 *    being asked something. That is `waiting`, not `error`.
 *  - The three {@link SESSION_FAILURE_ATTENTION_KINDS} below — the transport or
 *    the configuration is broken and no turn can run until it is fixed.
 *  - Everything else (`rate_limited`, `quota_exhausted`, `context_limit_reached`,
 *    `transport_retrying`, `partial_turn_interrupted`) — the WORLD pushing
 *    back, or one turn ending badly. Deliberately not `error`: these clear on
 *    their own or on the next turn, nobody can act on them, and a notification
 *    for a rate limit is how a person learns to switch notifications off.
 *
 * This is what makes VC-112's model clause true without a second failure
 * surface: a Run whose pinned model has become unavailable fails its ATTACH
 * with `configuration_invalid` (`session-runtime/pi-adapter.ts`), which is one
 * of the three below, so it lands in `error` and rides this same rule. VC-112
 * rejected "a dedicated Run failed to start surface" for precisely that reason.
 *
 * The attach is where that failure lands only because the Run door declines to
 * pre-empt it: `automations/run.ts` records its Runtime
 * (`SessionModelOverride.whenUnavailable`) instead of asking Model Access to
 * validate it, so the Session exists to be in `error` at all. A door-time
 * refusal would have left nothing for this predicate to answer about — which
 * is exactly the gap that shipped first and had to be closed.
 *
 * The model was only ever one way for an attach to fail, and it was the only
 * one that said so (VC-220). An unpreparable worktree and an adapter that threw
 * without naming a kind each wrote `attachment.failed` and raised nothing, so
 * this predicate answered `null` for a Session that could not run at all — an
 * Automation Run that met one was an empty chat and a silence. Every attach
 * failure now raises one of the kinds below (`session-runtime.ts`'s
 * `#failAttach`), so "the Session's plumbing failed" is a question this can
 * always answer.
 *
 * Pure and transport-free like its neighbours: the host reads a projection it
 * already holds and asks this one question of it.
 */

import {
  sessionAwaitsUser,
  SESSION_USER_BLOCKING_ATTENTION_KINDS,
  type SessionAttentionKind,
  type SessionProjection,
} from "./session-ledger";
import { NO_SESSION_NOTIFICATION_ITEM, type SessionNotificationItem } from "./notification-catalog";

/**
 * The Attention kinds that mean the Session's own plumbing failed — VC-112's
 * `error`, as opposed to its `waiting`.
 *
 * Three, and each is a break rather than a delay:
 *
 *  - `configuration_invalid` — the Session cannot be attached as configured.
 *    A pinned model that has since become unavailable arrives here.
 *  - `adapter_disconnected` — the transport went away under a live attachment.
 *  - `adapter_unrecoverable` — the adapter failed in a way a retry cannot fix.
 *
 * Declared as a list rather than tested inline so the split is stated once and
 * can be read against {@link SESSION_USER_BLOCKING_ATTENTION_KINDS} — the two
 * together are the whole of what a person is ever told about, and the kinds in
 * neither list are the ones deliberately kept quiet.
 */
export const SESSION_FAILURE_ATTENTION_KINDS = [
  "configuration_invalid",
  "adapter_disconnected",
  "adapter_unrecoverable",
] as const satisfies readonly SessionAttentionKind[];

/**
 * The two states a person is needed in, spelled exactly as `StatusDotState`
 * spells them.
 *
 * The names are load-bearing: `status-dot.tsx` owns the union these two are
 * drawn from, and `session-need.pin.test.ts` in the renderer asserts at the type
 * level that both of these are assignable to `StatusDotState`. That pin is what
 * keeps VC-112's "this needs no new concept" true as code rather than as a
 * comment — rename a dot state and the pin fails to compile.
 */
export const SESSION_PERSON_NEEDS = ["waiting", "error"] as const;

export type SessionPersonNeed = (typeof SESSION_PERSON_NEEDS)[number];

/**
 * Whether this Session needs a person right now, and in which of the two ways.
 *
 * ── PRECEDENCE, AND WHY IT IS THIS ORDER ──────────────────────────────────
 *
 * 1. **A stopped Session needs nobody.** Its work was ended on purpose — by a
 *    supervisor, the person, or the watchdog (VC-86) — so there is nothing to
 *    rescue and nothing to answer. This is the same first clause `chatActivity`
 *    uses for the listing row, kept in the same position so a row that reads
 *    "Stopped" can never be the row that raised a notification.
 *
 * 2. **A failure outranks a question.** The renderer already settles this for
 *    the tab dot (`ticket-chat-tab.ts`): "if the stream is gone, the request we
 *    are holding is a memory", and telling someone to go answer a question over
 *    a dead transport sends them to a card that cannot be answered. The same
 *    order here means the notification names the thing they can actually fix.
 *
 * 3. **Otherwise the shared waiting predicate**, unchanged and uncopied.
 *
 * `null` is the resting answer and covers every state VC-112 forbids notifying
 * on. `working`, `ready`, `starting`, `setup` and `idle` all reach it, which is
 * how "never on start, and never on finish" falls out of the rule rather than
 * needing a clause of its own: a Run that starts is `starting` then `working`,
 * and a Run that finishes is `idle`. Neither is a moment a person is needed, so
 * neither is representable here.
 */
export function sessionPersonNeed(
  projection: Pick<SessionProjection, "interactions" | "attention" | "stopped">,
): SessionPersonNeed | null {
  if (projection.stopped !== null) return null;
  const failing = projection.attention.active.some((attention) =>
    (SESSION_FAILURE_ATTENTION_KINDS as readonly SessionAttentionKind[]).includes(attention.kind),
  );
  if (failing) return "error";
  return sessionAwaitsUser(projection) ? "waiting" : null;
}

/**
 * WHICH thing in a Session needs the person right now (VC-295).
 *
 * ── ONE DERIVATION, THREE READERS ─────────────────────────────────────────
 * A notification names the item it is about so a click can land on it; a window
 * reports the item it is showing so an alert about that exact item is not
 * shouted twice; and the chat plane draws that item. All three have to agree,
 * or a click opens a Session and selects nothing while the window claims it was
 * already showing the thing.
 *
 * ── SO THE RULE IS THE SURFACE'S RULE ─────────────────────────────────────
 * Round 3's correction. This used to scan for the first qualifying attention,
 * while the blocker row draws `attention.primary` — which the ledger defines as
 * the NEWEST active attention. With two live attentions the two disagreed, and
 * both failures follow from that: a deep link to a card nothing draws, and a
 * window reporting an attention nobody can see as "already visible", which
 * suppressed the alert for it.
 *
 * So the order below is the order the plane resolves in:
 *
 *  1. **A stopped Session names nothing.** Its work was ended on purpose.
 *  2. **The primary attention, when it is a failure** — `sessionBlocker`'s
 *     third source, and the one it never lets a card hide.
 *  3. **Otherwise the open question**, because an open card takes the place of
 *     the `input_required` / `permission_required` row it is the answer to.
 *  4. **Otherwise the primary attention, when a person is what it is blocked
 *     on** — the same row, with no card in front of it.
 *  5. **Otherwise nothing.** Including the case where a newer attention nobody
 *     can act on (a rate limit, a retry) has covered an older failure: that
 *     failure is not on screen anywhere, so naming it would send a click to a
 *     card the app is not drawing. The alert still fires — `sessionPersonNeed`
 *     still answers `error` — it simply opens the Session and no more.
 *
 * ── THE SHAPE IT ASKS FOR ─────────────────────────────────────────────────
 * Structural, and deliberately narrower than a whole `SessionProjection`: main
 * hands it the durable projection, while a window hands it the renderer's
 * presentation projection, which carries no `stopped` at all. Absent reads the
 * same as `null` — a shape that cannot express a stop is a shape that never
 * reports one, and the two callers must not answer differently about the same
 * Session merely because they hold different views of it. `primary` is READ
 * rather than recomputed, so this cannot drift from the fold that produced it.
 */
/**
 * The Attention a notification click asked to be shown, while it is still live
 * (VC-295 round 4).
 *
 * THE one answer to "which Attention is that row drawing", asked by the chat
 * plane's blocker and by the window reporting what it shows. Two derivations of
 * it is precisely how round 3 shipped a row displaying one problem while the
 * window told main a different one was visible — which suppressed the alert for
 * the problem that was NOT on screen.
 *
 * `null` for "no click named one" and for "the one it named has cleared" alike:
 * both mean the caller falls back to what it would have drawn anyway.
 */
export function revealedSessionAttention<T extends { id: string }>(
  active: readonly T[],
  revealedAttentionId: string | null,
): T | null {
  if (revealedAttentionId === null) return null;
  return active.find((attention) => attention.id === revealedAttentionId) ?? null;
}

/**
 * What a Session is showing right now, given a click that revealed an Attention.
 *
 * {@link sessionNotificationItem} answers for the resting case — the row draws
 * `primary`. This wraps it with the one override the plane has: a click can ask
 * for an older live Attention, and while that stands, that is the row.
 *
 * The override applies only where the ROW is the item. With a card open the
 * blocker stands down for the kind the card answers, so the question stays what
 * is on screen and a reveal changes nothing — which is why this defers to the
 * base answer whenever that answer is an interaction.
 */
export function shownSessionNotificationItem(
  projection: {
    interactions: { active: readonly { id: string }[] };
    attention: {
      active: readonly { id: string; kind: SessionAttentionKind }[];
      primary: { id: string; kind: SessionAttentionKind } | null;
    };
    stopped?: SessionProjection["stopped"];
  },
  revealedAttentionId: string | null,
): SessionNotificationItem {
  const base = sessionNotificationItem(projection);
  if (base.attentionId === null) return base;
  const revealed = revealedSessionAttention(projection.attention.active, revealedAttentionId);
  return revealed === null ? base : { interactionId: null, attentionId: revealed.id };
}

export function sessionNotificationItem(projection: {
  interactions: { active: readonly { id: string }[] };
  attention: {
    active: readonly { id: string; kind: SessionAttentionKind }[];
    primary: { id: string; kind: SessionAttentionKind } | null;
  };
  stopped?: SessionProjection["stopped"];
}): SessionNotificationItem {
  if (projection.stopped != null) return NO_SESSION_NOTIFICATION_ITEM;
  const primary = projection.attention.primary;
  const isFailure =
    primary !== null &&
    (SESSION_FAILURE_ATTENTION_KINDS as readonly SessionAttentionKind[]).includes(primary.kind);
  if (primary !== null && isFailure) return { interactionId: null, attentionId: primary.id };
  const question = projection.interactions.active[0];
  if (question !== undefined) return { interactionId: question.id, attentionId: null };
  const asking =
    primary !== null &&
    (SESSION_USER_BLOCKING_ATTENTION_KINDS as readonly SessionAttentionKind[]).includes(
      primary.kind,
    );
  return asking && primary !== null
    ? { interactionId: null, attentionId: primary.id }
    : NO_SESSION_NOTIFICATION_ITEM;
}
