/**
 * A start that failed preparing its worktree, told apart from a configuration
 * a person fixes in Settings (VC-1015).
 *
 * A worktree that cannot be prepared fails its attach as `location_unavailable`
 * and raises `configuration_invalid`, under the same Attention id every attach
 * failure of that kind uses. That kind is the one every N−1 build already
 * clears on its next successful attach, so it stays. What changes is the
 * wording: the Attention's detail starts with
 * {@link WORKTREE_PREPARATION_FAILED}, and a surface that reads this predicate
 * says "Worktree unavailable" and offers a Retry, instead of "Configuration
 * invalid" and Settings, which hold nothing that fixes a worktree.
 */
import type { SessionAttention } from "./session-ledger";

/**
 * How every host's worktree preparation begins the reason it refuses a start
 * (`session-runtime/location.ts`, `cloud-store/location.ts`).
 *
 * **Durable, not live**: it is written into Attention and receipt details, and
 * {@link isWorktreePreparationAttention} and the setup gate read it back from
 * history. Changing it would make every refusal already recorded read as a
 * Settings problem again.
 */
export const WORKTREE_PREPARATION_FAILED = "Couldn't prepare the worktree";

/** Whether an Attention reports a start whose worktree could not be prepared. */
export function isWorktreePreparationAttention(
  attention: Pick<SessionAttention, "kind" | "detail">,
): boolean {
  return (
    attention.kind === "configuration_invalid" &&
    attention.detail?.startsWith(WORKTREE_PREPARATION_FAILED) === true
  );
}
