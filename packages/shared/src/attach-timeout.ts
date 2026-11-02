/**
 * An attach that did not finish in time, told apart from a runtime that stopped
 * (VC-1072).
 *
 * A direct door's attach that runs out of time is persisted as
 * `adapter_unrecoverable`, under the same Attention id every attach failure
 * uses. That kind is the one every N−1 build already clears on its next
 * successful attach, and the one the follow-up queue already reads. A new kind
 * would leave an older build with an Attention nothing clears, and a queue held
 * behind it for good. What changes is the wording: the Attention's detail
 * starts with {@link ATTACH_TIMEOUT_CODE}, and a surface that reads this
 * predicate says "Start timed out" instead of "Runtime stopped".
 */
import type { SessionAttention } from "./session-ledger";

/**
 * The code, and the detail prefix, of an attach stage that ran out of time.
 *
 * **Durable, not live**: it is written into Attention and receipt details, and
 * {@link isAttachTimeoutAttention} reads it back from history. Changing it
 * would make every timeout already recorded read as a stopped runtime again.
 */
export const ATTACH_TIMEOUT_CODE = "attach_timeout";

const PREFIX = `${ATTACH_TIMEOUT_CODE}:`;

/**
 * Whether an Attention reports an attach that did not finish in time: the
 * failed attach's own, or the queue's report of a message held behind it,
 * which quotes the attach's detail after the kind it names.
 */
export function isAttachTimeoutAttention(
  attention: Pick<SessionAttention, "kind" | "detail">,
): boolean {
  if (attention.kind !== "adapter_unrecoverable" || attention.detail === null) return false;
  return attention.detail.startsWith(PREFIX) || attention.detail.includes(`: ${PREFIX}`);
}
