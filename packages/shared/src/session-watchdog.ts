/**
 * The wedge verdict (VC-86): whether one Session's open turn has been silent
 * long enough to self-report, decided from durable projection facts alone.
 *
 * This is the pure half of the session watchdog. The timer, the scan, and the
 * acts (a durable blocked signal, a notification, an optional self-stop) live
 * in the host beside the runtime that owns the executors; what lives here is
 * the one sentence they act on, kept pure so ten minutes of policy is testable
 * with a number instead of a clock.
 *
 * ## What counts as wedged
 *
 * A turn is OPEN and nothing durable has happened for the threshold. Every
 * durable fact moves `lastActivityAt` — streamed transcript, tool outcomes,
 * compactions — so "no tool call and no token for N minutes" is exactly
 * "lastActivityAt is N minutes old under an open turn".
 *
 * ## What deliberately does not count
 *
 * - **No open turn** — a quiet Session between turns is idle, and idleness is
 *   the orchestrator's business (`ticket.await` timeouts), not a malfunction.
 * - **Stopped** — its work was ended on purpose; there is nothing to rescue.
 * - **Awaiting a person** — a permission prompt or question can sit for an
 *   hour legitimately, and it already self-reports through Attention. Calling
 *   it wedged would turn the human's own pace into an agent malfunction,
 *   which is the exact inference the Attention doctrine forbids.
 */

import { sessionAwaitsUser } from "./session-ledger";
import type { SessionProjection } from "./session-ledger";

/**
 * How long an open turn may be silent before the watchdog speaks: one
 * app-wide threshold, the compaction precedent — a single switch, never
 * per-model knobs. Ten minutes is far beyond any healthy model call and far
 * under the three hours the rc-0.1.0 wedges cost to detect by hand.
 */
export const DEFAULT_SESSION_WATCHDOG_SILENCE_MS = 10 * 60_000;

/** Why a Session is not wedged; `active` means a turn is open and recent. */
export type SessionWedgeCalm = "no-turn" | "stopped" | "awaiting-user" | "active";

export type SessionWedgeVerdict =
  | { wedged: false; reason: SessionWedgeCalm }
  | { wedged: true; silentForMs: number };

/** The wedge verdict for one Session, from its durable projection alone. */
export function sessionWedge(
  projection: Pick<
    SessionProjection,
    "turnActive" | "stopped" | "interactions" | "attention" | "lastActivityAt"
  >,
  now: number,
  thresholdMs: number,
): SessionWedgeVerdict {
  if (!projection.turnActive) return { wedged: false, reason: "no-turn" };
  if (projection.stopped !== null) return { wedged: false, reason: "stopped" };
  if (sessionAwaitsUser(projection)) return { wedged: false, reason: "awaiting-user" };
  const silentForMs = Math.max(0, now - projection.lastActivityAt);
  return silentForMs >= thresholdMs
    ? { wedged: true, silentForMs }
    : { wedged: false, reason: "active" };
}
