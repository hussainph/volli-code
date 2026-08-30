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
 * Pure and transport-free like its neighbours: the host reads a projection it
 * already holds and asks this one question of it.
 */

import {
  sessionAwaitsUser,
  type SessionAttentionKind,
  type SessionProjection,
} from "./session-ledger";

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
