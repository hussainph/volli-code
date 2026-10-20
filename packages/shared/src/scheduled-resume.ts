/**
 * A resume a person scheduled for the moment a provider's allowance comes
 * back, and what the host owes it when that moment arrives.
 *
 * The intent is three Session Commands and nothing else: `resume.schedule` (a
 * person's choice), `resume.cancel` (their withdrawal) and `resume.settle` (the
 * host's account of the outcome). Their receipts are the acceptance facts, the
 * way `pendingExecutorStart` is read from commands and receipts rather than a
 * dedicated event — so the whole state lives in the Session's own ledger,
 * survives a relaunch with it, and is folded here by the SAME function the
 * renderer's presentation, the engine's acceptance check and the host's timer
 * all call. Nothing keeps a second copy that could disagree.
 *
 * **Why the skip rules exist.** A resume fires hours after it was chosen, into
 * whatever the person did in the meantime. Running a stale Session's cached
 * context is the worst outcome available — it spends the allowance that just
 * came back on work the person has already moved past, possibly while another
 * Session on the same Ticket is the one they care about. So at fire time, and
 * only then, {@link scheduledResumeVerdict} checks that the Session is still
 * the one to continue; anything that says otherwise skips it, durably and with
 * a reason, rather than guessing.
 */
import type {
  CommandReceipt,
  ScheduledResumeOutcome,
  SessionCommand,
  SessionCommandIntent,
  SessionProjection,
} from "./session-ledger";

/** A pending scheduled resume, as read out of its Session's commands. */
export interface ScheduledResume {
  /** The `resume.schedule` command id — the schedule's identity. */
  id: string;
  attentionId: string;
  /** The attachment the failed run belongs to, and the one the retry addresses. */
  attachmentId: string;
  /** When to resume, epoch ms: the reset the Attention stated. */
  resumeAt: number;
  /** When the person chose it — the schedule command's own stamp. */
  scheduledAt: number;
  /** The retry this schedule resumes through; see {@link scheduledResumeRetryCommandId}. */
  retryCommandId: string;
  /** Whether that retry has already been issued (its settle may not be recorded yet). */
  fired: boolean;
  /**
   * Whether the Session was continued by hand after the schedule was made. A
   * command the engine refused continued nothing and is not counted; one still
   * awaiting its receipt is, because it may yet start work.
   */
  continued: boolean;
}

/**
 * The retry command a schedule resumes through.
 *
 * **FROZEN** (CLAUDE.md: a durable id derivation is frozen the moment it
 * ships). This string is a durable command id, and it is what makes a resume
 * idempotent: a second fire — a timer racing a relaunch, a pass repeated after
 * a crash — names the SAME command, which the engine replays instead of
 * starting a second turn. Scoped by the schedule's own command id (a UUID), so
 * it satisfies docs/BOUNDARIES.md rule 1. Changing the suffix would not error;
 * it would make a relaunch fire every in-flight resume a second time.
 */
export function scheduledResumeRetryCommandId(scheduleId: string): string {
  return `${scheduleId}:resume`;
}

/**
 * How long after the stated reset a resume fires. A provider states its reset
 * to the second and this machine's clock is not the provider's: a retry that
 * lands a few seconds early is refused on the same spent allowance. The durable
 * `resumeAt` stays the stated reset; only the fire waits this out.
 */
export const SCHEDULED_RESUME_GRACE_MS = 60_000;

/** When the host fires a schedule stated for `resumeAt`. */
export function scheduledResumeFireAt(resumeAt: number): number {
  return resumeAt + SCHEDULED_RESUME_GRACE_MS;
}

/**
 * The settle command for a schedule. **FROZEN** for the reason above: one
 * schedule is settled once, however many passes reach it.
 */
export function scheduledResumeSettleCommandId(scheduleId: string): string {
  return `${scheduleId}:settle`;
}

/**
 * Commands that mean a person (or an agent acting for one) picked this Session
 * up again after the schedule. Any of them makes the scheduled resume stale.
 * A total record so a new intent must say whether it continues the Session.
 */
const CONTINUES_SESSION: Readonly<Record<SessionCommandIntent["kind"], boolean>> = {
  "message.submit": true,
  "executor.retry": true,
  "executor.interrupt": true,
  "executor.start": true,
  "context.compact": true,
  "interaction.resolve": true,
  // Ending is read from the projection's own state (see `ended` below), not
  // from the command that asked for it: a stop request can be refused.
  "executor.stop": false,
  "session.stop": false,
  "session.archive": false,
  // Bookkeeping, and the model the retry will run on — neither continues it.
  "session.create": false,
  "session.retitle": false,
  "session.signal": false,
  "model.select": false,
  "resume.schedule": false,
  "resume.cancel": false,
  "resume.settle": false,
};

/**
 * The latest accepted schedule not yet cancelled or settled, or `null`.
 *
 * A rejected command never counts, whichever of the three it is. A later
 * schedule replaces an earlier pending one, so there is at most one.
 */
export function pendingScheduledResume(
  projection: Pick<SessionProjection, "commands" | "receipts">,
): ScheduledResume | null {
  const receipts = latestReceipts(projection.receipts);
  const accepted = (command: SessionCommand): boolean => {
    const status = receipts.get(command.id)?.status;
    return status === "completed" || status === "accepted";
  };
  let pending: {
    command: SessionCommand;
    intent: Extract<SessionCommandIntent, { kind: "resume.schedule" }>;
    index: number;
  } | null = null;
  for (const [index, command] of projection.commands.entries()) {
    const intent = command.intent;
    if (intent.kind === "resume.schedule") {
      if (accepted(command)) pending = { command, intent, index };
    } else if (
      (intent.kind === "resume.cancel" || intent.kind === "resume.settle") &&
      pending?.command.id === intent.scheduleId &&
      accepted(command)
    ) {
      pending = null;
    }
  }
  if (pending === null) return null;
  const { command, intent, index } = pending;
  const retryCommandId = scheduledResumeRetryCommandId(command.id);
  const later = projection.commands.slice(index + 1);
  return {
    id: command.id,
    attentionId: intent.attentionId,
    attachmentId: intent.attachmentId,
    resumeAt: intent.resumeAt,
    scheduledAt: command.createdAt,
    retryCommandId,
    fired: later.some((candidate) => candidate.id === retryCommandId),
    continued: later.some(
      (candidate) =>
        candidate.id !== retryCommandId &&
        CONTINUES_SESSION[candidate.intent.kind] &&
        receipts.get(candidate.id)?.status !== "rejected",
    ),
  };
}

/** Each command's latest receipt: a replay can answer an unreconciled one later. */
function latestReceipts(receipts: readonly CommandReceipt[]): Map<string, CommandReceipt> {
  const latest = new Map<string, CommandReceipt>();
  for (const receipt of receipts) latest.set(receipt.commandId, receipt);
  return latest;
}

/** What a surface draws for a schedule: only one that is still going to run. */
export interface PresentedScheduledResume {
  id: string;
  attentionId: string;
  resumeAt: number;
}

/**
 * The schedule a surface should show as waiting, or `null`.
 *
 * One the Session has already overtaken — continued by hand, stopped, archived,
 * or already fired — is going to be skipped or settled, and drawing it as
 * "Resumes at …" would promise a resume that will not happen. Whether ANOTHER
 * Session on the Ticket supersedes it is not known here and is left to the
 * fire-time check; a surface draws the one Session it has.
 */
export function presentedScheduledResume(
  projection: Pick<
    SessionProjection,
    "commands" | "receipts" | "status" | "stopped" | "liveExecutor"
  >,
): PresentedScheduledResume | null {
  const pending = pendingScheduledResume(projection);
  if (pending === null || pending.fired || pending.continued || ended(projection, pending)) {
    return null;
  }
  return { id: pending.id, attentionId: pending.attentionId, resumeAt: pending.resumeAt };
}

/** The Session state a resume cannot run into. */
function ended(
  projection: Pick<SessionProjection, "status" | "stopped" | "liveExecutor">,
  schedule: ScheduledResume,
): boolean {
  return (
    projection.status === "archived" ||
    projection.stopped !== null ||
    projection.liveExecutor?.id !== schedule.attachmentId
  );
}

/** Another Session on the same Ticket, as much of it as the rule reads. */
export type ScheduledResumeSibling = Pick<
  SessionProjection,
  "session" | "turnActive" | "commands" | "receipts"
>;

export interface ScheduledResumeVerdictInput {
  projection: Pick<
    SessionProjection,
    "session" | "commands" | "receipts" | "status" | "stopped" | "liveExecutor"
  >;
  /**
   * Every Session on this Session's Ticket (it may include this one). Empty for
   * a Session with no Ticket, which has no sibling to be superseded by.
   */
  ticketSessions: readonly ScheduledResumeSibling[];
  now: number;
}

/** What the host owes a pending schedule right now. */
export type ScheduledResumeVerdict =
  /** Not yet: look again at `at`. */
  | { kind: "wait"; at: number }
  /** Due and still wanted: issue the retry under this command id. */
  | { kind: "resume"; sessionId: string; attachmentId: string; retryCommandId: string }
  /** Record this outcome; a skip is also told to the person. */
  | { kind: "settle"; outcome: ScheduledResumeOutcome };

/**
 * The fire-time decision for a Session's pending scheduled resume, or `null`
 * when it has none. In order:
 *
 * 1. **Already fired** — the retry command exists, so a pass after a crash
 *    settles it from its receipt: `resumed` when the engine accepted it,
 *    `refused` when it rejected it. A retry with no answer yet — recorded, and
 *    then the process died before delivery — is not proof of anything, so it
 *    falls through to the rules below and, if they still hold, is issued again
 *    under the same frozen id, which the engine replays rather than repeats.
 * 2. **Not due** — wait. Nothing below is judged early, because the person may
 *    still act before the time, and a skip decided now would be a guess.
 * 3. **Ended** — archived, stopped, or the failed attachment is no longer the
 *    live one: there is nothing to resume into.
 * 4. **Continued** — a message, a retry, an interrupt, an attach or a compaction
 *    on this Session after the schedule: the person already took it from here.
 * 5. **Superseded** — another Session on the Ticket is running a turn now, or
 *    was sent a message or retried after the schedule was made (and the engine
 *    did not refuse it). Resuming this one would spend the fresh allowance on
 *    the stale Session (compared by wall-clock stamp: cross-Session sequence
 *    order does not exist). A sibling's OWN scheduled resume is not it moving
 *    on: two Sessions stopped by one spent allowance and both scheduled for its
 *    reset are both what the person asked for, and whichever fires first must
 *    not talk the other out of it.
 * 6. Otherwise, resume.
 */
export function scheduledResumeVerdict(
  input: ScheduledResumeVerdictInput,
): ScheduledResumeVerdict | null {
  const { projection } = input;
  const pending = pendingScheduledResume(projection);
  if (pending === null) return null;
  if (pending.fired) {
    const receipt = projection.receipts.findLast(
      (candidate) => candidate.commandId === pending.retryCommandId,
    );
    if (receipt?.status === "rejected") {
      return { kind: "settle", outcome: skipped("refused", receipt.detail) };
    }
    if (receipt?.status === "accepted" || receipt?.status === "completed") {
      return {
        kind: "settle",
        outcome: { kind: "resumed", retryCommandId: pending.retryCommandId },
      };
    }
  }
  const fireAt = scheduledResumeFireAt(pending.resumeAt);
  if (input.now < fireAt) return { kind: "wait", at: fireAt };
  if (ended(projection, pending)) return { kind: "settle", outcome: skipped("ended", null) };
  if (pending.continued) return { kind: "settle", outcome: skipped("continued", null) };
  const superseded = input.ticketSessions.some(
    (sibling) =>
      sibling.session.id !== projection.session.id && movedOn(sibling, pending.scheduledAt),
  );
  if (superseded) return { kind: "settle", outcome: skipped("superseded", null) };
  return {
    kind: "resume",
    sessionId: projection.session.id,
    attachmentId: pending.attachmentId,
    retryCommandId: pending.retryCommandId,
  };
}

/** Whether a sibling was picked up by a person after `since`, or is running a turn they started. */
function movedOn(sibling: ScheduledResumeSibling, since: number): boolean {
  const receipts = latestReceipts(sibling.receipts);
  const scheduledRetries = new Set(
    sibling.commands.flatMap((command) =>
      command.intent.kind === "resume.schedule" ? [scheduledResumeRetryCommandId(command.id)] : [],
    ),
  );
  const starts = sibling.commands.filter(
    (command) =>
      (command.intent.kind === "message.submit" || command.intent.kind === "executor.retry") &&
      receipts.get(command.id)?.status !== "rejected",
  );
  // The turn running now is the one the latest start opened: a scheduled
  // resume's own turn is not a person's.
  const latest = starts.at(-1);
  if (sibling.turnActive && (latest === undefined || !scheduledRetries.has(latest.id))) {
    return true;
  }
  return starts.some((command) => command.createdAt > since && !scheduledRetries.has(command.id));
}

function skipped(
  reason: Extract<ScheduledResumeOutcome, { kind: "skipped" }>["reason"],
  detail: string | null,
): ScheduledResumeOutcome {
  return { kind: "skipped", reason, detail };
}

/**
 * The reset an Attention offers a resume at, or `null`: a run stopped on a
 * spent allowance with a stated reset still ahead. A reset already behind is
 * not offered — Retry is the whole answer to it — though the engine still
 * accepts a schedule made a moment too late and the host simply fires it.
 */
export function attentionResumeAt(
  attention: { kind: string; resetsAt?: number | null },
  now: number,
): number | null {
  if (attention.kind !== "adapter_unrecoverable") return null;
  const resetsAt = attention.resetsAt ?? null;
  return resetsAt !== null && resetsAt > now ? resetsAt : null;
}
