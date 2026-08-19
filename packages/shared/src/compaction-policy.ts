/**
 * When a Session compacts on its own, and how much of the window it keeps free.
 *
 * Compaction's mechanism belongs to the Agent Runtime; this is only the policy
 * that mechanism is run under. Nothing here decides how a context is
 * summarized, what is written down, or what the model is sent — a Session that
 * compacts under any policy in this file compacts the same way.
 *
 * Three reconciliations are worth stating, because each is a question a reader
 * will otherwise answer by guessing.
 *
 * **The switch and the reserves do not compete.** {@link
 * CompactionPolicy.autoCompaction} answers WHETHER a Session compacts before it
 * is asked to; a {@link ModelCompactionLimit} answers how much room it aims to
 * leave free, which is two things at once — where the threshold sits, and how
 * large a summary the executor budgets for. So a reserve is never overridden by
 * the switch and does not go inert under it: with the switch off the threshold
 * it sets is simply never asked about, while the size it sets still applies to
 * the compaction an overflow forces.
 *
 * **Off is not "let the Session die at the window".** The switch governs the
 * threshold path — the compaction nobody asked for, that spends a summary call
 * inside a wait. It does not govern the overflow path, which runs only after a
 * provider has already refused the turn: that Session is out of options, and
 * declining to recover it would trade a multi-second pause for a dead end.
 * Off means "do not interrupt me to make room", not "do not make room".
 *
 * **An unset per-model reserve means the executor's own, BY DEFINITION** — the
 * same shape of answer `resolveDefaultModel` gives for an unset ticket or
 * utility default, and unset for the same reason: it is a resolvable value, not
 * a missing one. This package cannot name that number, because it is Pi's, so
 * an unset model resolves to nothing here and the runtime substitutes the
 * reserve it is built on. A default restated here would be a second one.
 */

/**
 * One model's compaction limit: the room it aims to leave free.
 *
 * The identity pair is `HiddenModelRef`'s, and for the same reason — a
 * preference about a model is the two ids and whatever it configures, never a
 * copy of the catalog row. This one carries a reserve.
 */
export interface ModelCompactionLimit {
  providerId: string;
  modelId: string;
  /**
   * Tokens kept free for the next reply and for the summary that may have to
   * replace the context to make room for it — the executor's `reserveTokens`,
   * which is both halves of that sentence. The threshold is `used > window −
   * reserve`, never a percentage of the window; the summary is generated with an
   * output budget derived from the same number.
   */
  reserveTokens: number;
}

/** The profile-wide compaction policy every Session is run under. */
export interface CompactionPolicy {
  /**
   * Whether a Session compacts at the reserve threshold on its own.
   *
   * Off leaves the overflow path intact — see this module's header. This flag
   * is the executor's `enabled`, which is read by its threshold rule and by
   * nothing else, so switching it off removes the automatic decision rather
   * than disabling the machinery under it.
   */
  autoCompaction: boolean;
  /** The models given an explicit reserve. Unlisted means the executor's own. */
  modelLimits: readonly ModelCompactionLimit[];
}

/** Compaction on, no model limited: what a profile that has configured nothing means. */
export const DEFAULT_COMPACTION_POLICY: CompactionPolicy = {
  autoCompaction: true,
  modelLimits: [],
};

/**
 * The reserves a model may be limited to, smallest first.
 *
 * A ladder rather than a free number: a reserve is a rough allowance for one
 * reply plus its summary, nobody can tell 40,000 from 48,000 by feel, and a
 * picker cannot mint a value that does not fit the window. Binary steps because
 * the executor's own default (16,384) is one of them, so choosing it explicitly
 * pins today's behaviour instead of drifting with a dependency.
 */
export const COMPACTION_RESERVE_CHOICES = [8_192, 16_384, 32_768, 65_536, 131_072] as const;

/**
 * Whether a reserve is one this model could actually be run under.
 *
 * A reserve at or above the window puts the threshold — `used > window −
 * reserve` — at or below zero. That is not "compact eagerly"; it is "compact
 * after every single reply", each one paying for a summarization call. So such
 * a reserve is refused where it would be saved and ignored where it is somehow
 * read back, and both paths ask here.
 *
 * The window is the caller's to establish. The Agent Runtime's `contextWindowOf`
 * is the one sanitizer for it, and a second opinion here about what counts as a
 * usable window is exactly the drift that would let the two disagree.
 */
export function isUsableCompactionReserve(reserveTokens: number, contextWindow: number): boolean {
  return Number.isSafeInteger(reserveTokens) && reserveTokens > 0 && reserveTokens < contextWindow;
}

/** The explicit reserve configured for one model, or nothing when it has none. */
export function modelCompactionReserve(
  limits: readonly ModelCompactionLimit[],
  model: { providerId: string; modelId: string },
): number | undefined {
  return limits.find(
    (limit) => limit.providerId === model.providerId && limit.modelId === model.modelId,
  )?.reserveTokens;
}

/** `limits` with one model's reserve set, never listing the same model twice; null clears it. */
export function withModelCompactionReserve(
  limits: readonly ModelCompactionLimit[],
  model: { providerId: string; modelId: string },
  reserveTokens: number | null,
): readonly ModelCompactionLimit[] {
  const without = limits.filter(
    (limit) => !(limit.providerId === model.providerId && limit.modelId === model.modelId),
  );
  return reserveTokens === null
    ? without
    : [...without, { providerId: model.providerId, modelId: model.modelId, reserveTokens }];
}

/**
 * What a reserve picker may list for one model: the ladder that fits this
 * window, plus whatever is configured now even when it is not on the ladder —
 * a value a control holds and cannot name is a control that looks broken.
 *
 * A model whose catalog reports no usable window gets nothing to choose from,
 * which is the rule that keeps a configured limit from inventing a threshold
 * for a model there is nothing to measure against.
 */
export function compactionReserveChoices(
  contextWindow: number | undefined,
  configured: number | undefined,
): readonly number[] {
  if (contextWindow === undefined) return [];
  const offered = new Set<number>(
    COMPACTION_RESERVE_CHOICES.filter((reserve) =>
      isUsableCompactionReserve(reserve, contextWindow),
    ),
  );
  if (configured !== undefined && isUsableCompactionReserve(configured, contextWindow)) {
    offered.add(configured);
  }
  return [...offered].toSorted((a, b) => a - b);
}
