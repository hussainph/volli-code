/**
 * The one command that continues a turn a lost process cut short (VC-450).
 *
 * When the process running a turn ends — a crash, a quit with work in flight,
 * an update's restart, a runner that went away — the next launch recovers the
 * turn as interrupted. If its last durable point was a settled one and the
 * Session is still the one to continue, the host continues it through the
 * same `executor.retry` door a person's Retry uses: the executor resumes from
 * the user message or tool results the turn was answering, and nothing the
 * person said is sent again. The decision itself lives in
 * `@volli/session-engine` (`restartResumeVerdict`); this module only names the
 * command, because every reader that has to tell an automatic resume from a
 * person's act — the stale-session rules beside a scheduled resume, the
 * engine's own re-judgement at record time — needs the same answer.
 */

/**
 * The detail of the `partial_turn_interrupted` Attention an executor's own
 * recovery raises for a turn its lost process left open — the turn a restart
 * resume continues.
 *
 * **FROZEN**: durable Attentions carry it, and the engine (acknowledging the
 * warning on the person's next act) and surfaces (drawing the turn resumed
 * after the restart) recognise the recovery warning by it, apart from a
 * genuine partial-turn diagnostic.
 */
export const RECOVERED_TURN_INTERRUPTED_DETAIL =
  "A recovered Pi turn ended before its completion marker was committed.";

/**
 * Whether an Attention is the plain process-loss warning an executor's own
 * recovery raised on `attachmentId` — the one turn state a restart resume (or
 * the person's Resume) continues. A genuine partial-turn diagnostic, such as
 * withheld history, is not it. One rule for the host's verdict and every
 * surface that draws the row.
 */
export function isProcessLossWarning(
  attention: { kind: string; attachmentId: string | null; detail: string | null },
  attachmentId: string | null,
): boolean {
  return (
    attachmentId !== null &&
    attention.kind === "partial_turn_interrupted" &&
    attention.attachmentId === attachmentId &&
    attention.detail === RECOVERED_TURN_INTERRUPTED_DETAIL
  );
}

/**
 * The frozen suffix every restart-resume command id ends with.
 *
 * **FROZEN** (CLAUDE.md: a durable id derivation is frozen the moment it
 * ships). Readers recognise an automatic resume by this suffix in durable
 * history, so changing it would make every resume an older build recorded
 * read as a person's retry.
 */
const RESTART_RESUME_SUFFIX = ":restart-resume";

/**
 * The command that resumes `turnId` on `attachmentId` after a process loss.
 *
 * **FROZEN**, and it is what makes the resume happen at most once per lost
 * turn: a second pass over the same interruption names the SAME command,
 * which the engine replays rather than running a second time. Scoped by the
 * attachment id (a UUID), so it satisfies docs/BOUNDARIES.md rule 1.
 */
export function restartResumeCommandId(attachmentId: string, turnId: string): string {
  return `${attachmentId}:${turnId}${RESTART_RESUME_SUFFIX}`;
}

/** Whether a command is a host's automatic resume after a process loss. */
export function isRestartResumeCommandId(commandId: string): boolean {
  return commandId.endsWith(RESTART_RESUME_SUFFIX);
}
