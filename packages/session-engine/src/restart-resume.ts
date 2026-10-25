/**
 * Whether a turn a lost process cut short should be continued on its own
 * (VC-450) — the decision every host that recovers a Session shares: the
 * desktop today, and a runner that restarts or wakes tomorrow.
 *
 * ── WHAT IT CONTINUES ─────────────────────────────────────────────────────
 * A turn recovery found open and closed as interrupted, on the attachment the
 * recovery rebuilt. It continues through `executor.retry` — the door a
 * person's Retry and the transport retry use — under a frozen command id
 * (`restartResumeCommandId`), so the executor resumes from the point the turn
 * was answering and the person's message is never sent again.
 *
 * ── ONLY WHEN IT IS SAFE ──────────────────────────────────────────────────
 * The executor says where its conversation stands. A user message, or tool
 * results that answered every call, is a settled point: asking the model
 * again repeats nothing that ran. A tool call with no result — a bash command,
 * a write, a browser action the process died inside — has side effects nobody
 * can know from here, so the turn waits for the person, whose Resume answers
 * the call as interrupted and lets the model decide.
 *
 * ── ONLY WHEN IT IS STILL WANTED ──────────────────────────────────────────
 * The stale-session rules a scheduled resume applies (`@volli/shared`), read
 * from the moment the process was last known alive: a person who picked this
 * Session up, or another Session on the Ticket, since then has moved past it,
 * and an old Session must not wake up and spend usage behind their back. So
 * must a loss too long ago to be the work in hand, and a turn that was itself
 * a restart resume: one automatic attempt per interruption, never a loop
 * through a turn that keeps taking its process down.
 *
 * A skip records its reason for the host's log and raises nothing: the
 * interruption row is already there, and offers Resume while the attachment
 * is live.
 */
import {
  isProcessLossWarning,
  isRestartResumeCommandId,
  restartResumeCommandId,
  sessionContinuedSince,
  ticketSiblingMovedOn,
  type RuntimeResumeBoundary,
  type ScheduledResumeSibling,
  type SessionProjection,
} from "@volli/shared";

/**
 * How long after a process loss a turn may still be continued on its own.
 * Past it the person is not plausibly waiting on this turn any more — a
 * Session left over a weekend is exactly the old Session that must not spend
 * usage unasked — and the row's Resume is the way back.
 */
const RESTART_RESUME_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export type RestartResumeSkipReason =
  /**
   * This launch shows Volli Cloud's board, not this Mac's: a local Session's
   * turn waits for a launch that shows it, where a person can see it run.
   */
  | "cloud-launch"
  /** Archived, stopped, or the recovered attachment is no longer the live one. */
  | "ended"
  /** A turn is running, or about to: something already continued it. */
  | "running"
  /** The latest turn is not an interrupted one. */
  | "not-interrupted"
  /**
   * No plain process-loss warning stands on the attachment: the executor
   * diagnosed something else (withheld history), or found nothing to resume.
   */
  | "not-a-process-loss"
  /** The person asked the turn to stop before the process ended. */
  | "stopped"
  /** The interrupted turn was itself a restart resume. */
  | "already-resumed"
  /** A person continued this Session after the loss. */
  | "continued"
  /** Another Session on the Ticket moved on after the loss. */
  | "superseded"
  /** The loss was longer ago than {@link RESTART_RESUME_MAX_AGE_MS}. */
  | "expired"
  /** Nothing durable says when the lost process was last alive. */
  | "loss-unknown"
  /** A tool call has no result: its side effects are the person's to judge. */
  | "tool-in-flight"
  /** Nothing is left to continue, or the executor cannot say. */
  | "nothing-to-continue";

export type RestartResumeVerdict =
  | { kind: "resume"; sessionId: string; attachmentId: string; commandId: string }
  | { kind: "skip"; reason: RestartResumeSkipReason };

export interface RestartResumeVerdictInput {
  projection: Pick<
    SessionProjection,
    | "session"
    | "status"
    | "stopped"
    | "liveExecutor"
    | "turnActive"
    | "latestTurnId"
    | "lastTurnOutcome"
    | "commands"
    | "receipts"
  > & { attention: Pick<SessionProjection["attention"], "active"> };
  /** The attachment recovery rebuilt for the interrupted turn. */
  attachmentId: string;
  /** When the lost process was last known alive, epoch ms; `null` when unknown. */
  lostAt: number | null;
  now: number;
  /** Whether this process already holds a turn start for the Session. */
  startPending: boolean;
  /** The executor's answer; `null` when it cannot say. */
  boundary: RuntimeResumeBoundary | null;
  /** Every Session on the Ticket (it may include this one); empty without one. */
  ticketSessions: readonly ScheduledResumeSibling[];
  /**
   * Whether this launch shows Volli Cloud's board rather than this Mac's
   * (VC-889). Absent is a local launch.
   */
  cloudLaunch?: boolean;
}

function skip(reason: RestartResumeSkipReason): RestartResumeVerdict {
  return { kind: "skip", reason };
}

/** What the host owes one recovered, interrupted turn. */
export function restartResumeVerdict(input: RestartResumeVerdictInput): RestartResumeVerdict {
  const { projection, attachmentId } = input;
  if (input.cloudLaunch === true) return skip("cloud-launch");
  if (
    projection.status !== "open" ||
    projection.stopped !== null ||
    projection.liveExecutor?.id !== attachmentId
  ) {
    return skip("ended");
  }
  if (projection.turnActive || input.startPending) return skip("running");
  const turnId = projection.latestTurnId;
  if (turnId === null || projection.lastTurnOutcome !== "interrupted") {
    return skip("not-interrupted");
  }
  if (
    !projection.attention.active.some((attention) => isProcessLossWarning(attention, attachmentId))
  ) {
    return skip("not-a-process-loss");
  }
  const last = lastTurnAct(projection);
  if (last === "stop") return skip("stopped");
  if (last === "restart-resume") return skip("already-resumed");
  const lostAt = input.lostAt;
  if (lostAt === null) return skip("loss-unknown");
  if (sessionContinuedSince(projection, lostAt)) return skip("continued");
  const superseded = input.ticketSessions.some(
    (sibling) =>
      sibling.session.id !== projection.session.id && ticketSiblingMovedOn(sibling, lostAt),
  );
  if (superseded) return skip("superseded");
  if (input.now - lostAt > RESTART_RESUME_MAX_AGE_MS) return skip("expired");
  if (input.boundary === "tool-in-flight") return skip("tool-in-flight");
  if (input.boundary !== "settled") return skip("nothing-to-continue");
  return {
    kind: "resume",
    sessionId: projection.session.id,
    attachmentId,
    commandId: restartResumeCommandId(attachmentId, turnId),
  };
}

/**
 * The last act on the turn's course that the engine did not refuse: a start
 * (a message or a retry), a host's restart resume, or a stop. Read from the
 * commands themselves rather than from `latestTurnOrigin`, which a fold
 * leaves `null` when two starts were pending at once — so neither a Stop the
 * lost process never carried out, nor a resume that was itself cut short, is
 * missed (VC-450).
 */
function lastTurnAct(
  projection: Pick<SessionProjection, "commands" | "receipts">,
): "start" | "restart-resume" | "stop" | null {
  const refused = new Set(
    projection.receipts
      .filter(({ status }) => status === "rejected")
      .map(({ commandId }) => commandId),
  );
  for (let index = projection.commands.length - 1; index >= 0; index -= 1) {
    const command = projection.commands[index]!;
    if (refused.has(command.id)) continue;
    switch (command.intent.kind) {
      case "executor.interrupt":
      case "executor.stop":
      case "session.stop":
        return "stop";
      case "executor.retry":
        return isRestartResumeCommandId(command.id) ? "restart-resume" : "start";
      case "message.submit":
        return "start";
      default:
        continue;
    }
  }
  return null;
}
