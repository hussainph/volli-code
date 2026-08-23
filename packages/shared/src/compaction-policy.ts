/**
 * Whether a Session compacts on its own.
 *
 * Compaction's mechanism belongs to the Agent Runtime; this is only the policy
 * that mechanism is run under. Nothing here decides how a context is
 * summarized, what is written down, or what the model is sent — a Session that
 * compacts under any policy in this file compacts the same way.
 *
 * One switch is the whole policy, on purpose. Per-model reserve budgets used
 * to live beside it, and earned their retirement (VC-155): a reserve is a
 * rough allowance for one reply plus its summary, nobody can tell 40,000 from
 * 48,000 by feel, and a per-model ladder of them was a settings surface whose
 * every row restated a number the executor already defaults sensibly. The
 * executor's own reserve is the one every Session now runs under, and the only
 * question a person is asked is the one they can actually answer: whether a
 * Session may interrupt them to make room.
 *
 * **Off is not "let the Session die at the window".** The switch governs the
 * threshold path — the compaction nobody asked for, that spends a summary call
 * inside a wait. It does not govern the overflow path, which runs only after a
 * provider has already refused the turn: that Session is out of options, and
 * declining to recover it would trade a multi-second pause for a dead end.
 * Off means "do not interrupt me to make room", not "do not make room". A
 * manual `/compact` is likewise always answered.
 */

/** The profile-wide compaction policy every Session is run under. */
export interface CompactionPolicy {
  /**
   * Whether a Session compacts at the executor's reserve threshold on its own.
   *
   * Off leaves the overflow and manual paths intact — see this module's
   * header. This flag is the executor's `enabled`, which is read by its
   * threshold rule and by nothing else, so switching it off removes the
   * automatic decision rather than disabling the machinery under it.
   */
  autoCompaction: boolean;
}

/** Compaction on: what a profile that has configured nothing means. */
export const DEFAULT_COMPACTION_POLICY: CompactionPolicy = {
  autoCompaction: true,
};
