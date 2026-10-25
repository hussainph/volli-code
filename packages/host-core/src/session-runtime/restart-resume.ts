/**
 * The host half of a restart resume (VC-450): after boot recovery rebuilt the
 * attachments of turns the prior process left open, ask the shared verdict
 * (`restartResumeVerdict`, `@volli/session-engine`) about each and perform
 * what it says.
 *
 * ── IT DECIDES NOTHING ────────────────────────────────────────────────────
 * Whether a turn is safe and still wanted to continue is the verdict's, tested
 * as a table. This module only gathers what the verdict reads — the Session,
 * its Ticket siblings, the executor's resume boundary, the turn starts this
 * process already holds — and acts through ONE door: the runtime's
 * `executor.retry`, the same one a person's Retry uses, under the frozen
 * restart-resume command id. The engine judges that command again as it
 * records it, so a person who acted in the meantime still has the last word.
 *
 * ── SAID ONCE, OR NOT AT ALL ──────────────────────────────────────────────
 * A resumed turn keeps the interruption Attention, which its row then draws
 * as resumed after the restart until the turn settles. A skip raises nothing:
 * the interruption row is already there. Its reason is written to the host log,
 * which is where a person diagnosing "why didn't it continue" looks.
 *
 * Decisions run only after every recovered turn has been closed as
 * interrupted, so a sibling still showing the dead process's turn cannot be
 * mistaken for one a person is running.
 *
 * ── NEVER A STAMPEDE ──────────────────────────────────────────────────────
 * One process loss can leave a dozen turns open, and starting them all at once
 * can reproduce the load that ended the process (docs/crash-recovery.md). So
 * at most {@link RESTART_RESUME_CONCURRENCY} resumed turns run at a time, and
 * each Session is judged only when a slot frees — against its state then, so a
 * person who picked it up in the meantime has already said no. The promise
 * settles when every turn has been judged and every resumed run has ended; a
 * host closing ends them through the runtime like any other turn.
 */
import {
  restartResumeVerdict,
  type SessionRuntimeCommandRequest,
  type SessionRuntimeCommandResult,
} from "@volli/session-engine";
import type { RuntimeResumeBoundary, SessionProjection } from "@volli/shared";

import { hostLogger } from "../log/root";
import type { BootRecoveredTurns } from "./boot-recovery";

const log = hostLogger("restart-resume");

export interface RestartResumePorts {
  projection(sessionId: string): Promise<SessionProjection>;
  /** Every Session on one Ticket, folded — the superseded rule's input. */
  ticketSessions(input: {
    projectId: string;
    ticketId: string;
  }): Promise<readonly SessionProjection[]>;
  resumeBoundary(input: { attachmentId: string }): RuntimeResumeBoundary | null;
  /** Sessions this process already holds an accepted, not yet opened turn for. */
  pendingTurnStarts(): ReadonlySet<string>;
  command(request: SessionRuntimeCommandRequest): Promise<SessionRuntimeCommandResult>;
  /** Whether the host is closing: no new resume starts once it is. */
  shouldStop(): boolean;
  now?(): number;
}

/** How many restart-resumed turns run at once. */
export const RESTART_RESUME_CONCURRENCY = 2;

/**
 * Judges every recovered turn and runs the resumes the verdict allows, a few
 * at a time. Resolves once every turn is judged and every resumed run ended.
 * Never rejects: one Session's failure is logged and the next is judged.
 */
export async function resumeRecoveredTurns(
  ports: RestartResumePorts,
  recovered: BootRecoveredTurns,
): Promise<void> {
  const pending = [...recovered.turns];
  const worker = async (): Promise<void> => {
    for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
      if (ports.shouldStop()) return;
      await judgeAndRun(ports, next, recovered.lostAt);
    }
  };
  await Promise.all(Array.from({ length: RESTART_RESUME_CONCURRENCY }, worker));
}

async function judgeAndRun(
  ports: RestartResumePorts,
  { sessionId, attachmentId }: BootRecoveredTurns["turns"][number],
  lostAt: number | null,
): Promise<void> {
  const now = ports.now ?? Date.now;
  let commandId: string;
  try {
    const projection = await ports.projection(sessionId);
    const { projectId, ticketId } = projection.session;
    const verdict =
      lostAt === null
        ? ({ kind: "skip", reason: "expired" } as const)
        : restartResumeVerdict({
            projection,
            attachmentId,
            lostAt,
            now: now(),
            startPending: ports.pendingTurnStarts().has(sessionId),
            boundary: ports.resumeBoundary({ attachmentId }),
            ticketSessions:
              ticketId === null ? [] : await ports.ticketSessions({ projectId, ticketId }),
          });
    if (verdict.kind === "skip") {
      log.info("interrupted turn left for the person", { sessionId, reason: verdict.reason });
      return;
    }
    commandId = verdict.commandId;
  } catch (error) {
    log.error("restart resume could not be judged", { sessionId, error });
    return;
  }
  if (ports.shouldStop()) return;
  log.info("resuming interrupted turn", { sessionId, commandId });
  await run(ports, sessionId, attachmentId, commandId);
}

async function run(
  ports: RestartResumePorts,
  sessionId: string,
  attachmentId: string,
  commandId: string,
): Promise<void> {
  try {
    const { receipt } = await ports.command({
      origin: { kind: "volli", reason: "relaunch-recovery" },
      commandId,
      sessionId,
      command: { kind: "executor.retry", attachmentId },
    });
    if (receipt?.status === "rejected") {
      log.info("restart resume refused", { sessionId, code: receipt.code, detail: receipt.detail });
    }
  } catch (error) {
    // A closing host ends the run it was waiting on; that is not a failure.
    if (ports.shouldStop()) return;
    log.error("restart resume failed", { sessionId, error });
  }
}
