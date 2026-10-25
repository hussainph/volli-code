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
 *
 * ── IN A CLOUD STORE, ONLY ONCE CONNECTED ─────────────────────────────────
 * A runner's own ledger holds only the Sessions it ran; a sibling a person
 * continued from another runner is known to the backend alone. So with a
 * cloud store ({@link RestartResumePorts.cloud}) nothing resumes until the
 * runner's link has connected once this launch, bounded by
 * {@link CLOUD_RECOVERY_CONNECT_WAIT_MS}, and a turn the local verdict would
 * resume is then also asked of the backend's siblings
 * (`runnerRecovery.ticketSiblings`): a remote sibling that moved on
 * supersedes it exactly as a local one does. Every doubt fails closed — no
 * connection in time, an unreadable or partial answer, a claim this runner no
 * longer holds — and leaves the interruption row's Resume to the person. A
 * cloud store judges only its owner's Sessions; the local path is unchanged.
 */
import {
  restartResumeVerdict,
  type RestartResumeSkipReason,
  type SessionRuntimeCommandRequest,
  type SessionRuntimeCommandResult,
} from "@volli/session-engine";
import type { RuntimeResumeBoundary, SessionProjection } from "@volli/shared";

import { hostLogger } from "../log/root";
import type { BootRecoveredTurns } from "./boot-recovery";

const log = hostLogger("restart-resume");

/**
 * How long a cloud store's restart resume waits for the runner's first
 * connect before leaving every recovered turn for the person.
 */
export const CLOUD_RECOVERY_CONNECT_WAIT_MS = 30_000;

/** The backend's answer about one Session's Ticket siblings (`runnerRecovery.ticketSiblings`). */
export interface CloudRecoverySiblings {
  /** One answer per visible sibling: `null` when the backend could not settle it. */
  readonly siblings: readonly { readonly sessionId: string; readonly movedOn: boolean | null }[];
  /** False when the Ticket had more siblings than one read judges. */
  readonly complete: boolean;
}

/** What a cloud store answers for a restart resume (`cloud-store/recovery.ts`). */
export interface RestartResumeCloud {
  /**
   * Resolves `true` once the runner's link has connected this launch (at
   * once if it already has), `false` past `timeoutMs` or when `signal` aborts.
   */
  firstConnect(options: { timeoutMs: number; signal: AbortSignal }): Promise<boolean>;
  /** Rejects when the backend cannot be read, or refuses this runner the Session. */
  ticketSiblings(input: {
    sessionId: string;
    projectId: string;
    ticketId: string | null;
    since: number;
  }): Promise<CloudRecoverySiblings>;
}

/** Why a turn was left for the person: the verdict's reasons and a cloud store's. */
export type RestartResumeHostSkipReason =
  | RestartResumeSkipReason
  /** The runner's link did not connect within the bound. */
  | "cloud-offline"
  /** The backend's siblings could not be read, or not settled. */
  | "cloud-siblings-unreadable"
  /** The cloud store does not own the Session (defense in depth). */
  | "not-owned";

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
  /** Whether this launch shows Volli Cloud's board, not this Mac's (VC-889): nothing resumes. */
  cloudLaunch?(): boolean;
  /**
   * A cloud store's reads: present, the restart resume runs for the store's
   * own Sessions behind the first connect and the backend's siblings, and
   * `cloudLaunch` no longer suppresses it.
   */
  cloud?: RestartResumeCloud;
  /** The store's owner scope; a Session outside it is never judged. */
  ownsSession?(sessionId: string): boolean;
  /** Aborts the first-connect wait when the host closes. */
  closing?: AbortSignal;
  /** Tests only: {@link CLOUD_RECOVERY_CONNECT_WAIT_MS}. */
  connectWaitMs?: number;
  now?(): number;
}

/** How many restart-resumed turns run at once. */
const RESTART_RESUME_CONCURRENCY = 2;

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
  if (ports.cloud !== undefined && pending.length > 0) {
    const connected = await ports.cloud
      .firstConnect({
        timeoutMs: ports.connectWaitMs ?? CLOUD_RECOVERY_CONNECT_WAIT_MS,
        signal: ports.closing ?? new AbortController().signal,
      })
      .catch((error: unknown) => {
        log.error("restart resume could not wait for Volli Cloud", { error });
        return false;
      });
    if (!connected) {
      if (ports.shouldStop()) return;
      for (const { sessionId } of pending) leave(sessionId, "cloud-offline");
      return;
    }
  }
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
  const cloud = ports.cloud;
  let commandId: string;
  try {
    if (cloud !== undefined && ports.ownsSession?.(sessionId) === false) {
      leave(sessionId, "not-owned");
      return;
    }
    const judge = async () => {
      const projection = await ports.projection(sessionId);
      const { projectId, ticketId } = projection.session;
      const ticketSessions =
        ticketId === null ? [] : await ports.ticketSessions({ projectId, ticketId });
      // Read last, after every await, so a start accepted meanwhile is seen.
      const verdict = restartResumeVerdict({
        projection,
        attachmentId,
        lostAt,
        now: now(),
        startPending: ports.pendingTurnStarts().has(sessionId),
        boundary: ports.resumeBoundary({ attachmentId }),
        ticketSessions,
        // A cloud store's own Sessions are judged here; only a launch without
        // one leaves this Mac's turns for a launch that shows them (VC-889).
        cloudLaunch: cloud === undefined && (ports.cloudLaunch?.() ?? false),
      });
      return { verdict, projectId, ticketId };
    };
    const first = await judge();
    if (first.verdict.kind === "skip") {
      leave(sessionId, first.verdict.reason);
      return;
    }
    if (cloud !== undefined) {
      const reason = await cloudSiblingsVeto(cloud, {
        sessionId,
        projectId: first.projectId,
        ticketId: first.ticketId,
        // A resume verdict is never given without a known loss ("loss-unknown").
        since: lostAt!,
      });
      if (reason !== null) {
        leave(sessionId, reason);
        return;
      }
      if (ports.shouldStop()) return;
      // The backend read awaited: judge again against the Session as it is now.
      const second = await judge();
      if (second.verdict.kind === "skip") {
        leave(sessionId, second.verdict.reason);
        return;
      }
      commandId = second.verdict.commandId;
    } else {
      commandId = first.verdict.commandId;
    }
  } catch (error) {
    log.error("restart resume could not be judged", { sessionId, error });
    return;
  }
  if (ports.shouldStop()) return;
  log.info("resuming interrupted turn", { sessionId, commandId });
  await run(ports, sessionId, attachmentId, commandId);
}

function leave(sessionId: string, reason: RestartResumeHostSkipReason): void {
  log.info("interrupted turn left for the person", { sessionId, reason });
}

/**
 * Why the backend's Ticket siblings forbid a resume the local verdict allowed,
 * or `null` when they do not. A sibling that moved on supersedes the turn as a
 * local one would; anything the backend could not say forbids it too.
 */
async function cloudSiblingsVeto(
  cloud: RestartResumeCloud,
  input: Parameters<RestartResumeCloud["ticketSiblings"]>[0],
): Promise<RestartResumeHostSkipReason | null> {
  let answer: CloudRecoverySiblings;
  try {
    answer = await cloud.ticketSiblings(input);
  } catch (error) {
    log.warn("restart resume could not read the Ticket's cloud siblings", {
      sessionId: input.sessionId,
      error,
    });
    return "cloud-siblings-unreadable";
  }
  const others = answer.siblings.filter((sibling) => sibling.sessionId !== input.sessionId);
  if (others.some((sibling) => sibling.movedOn === true)) return "superseded";
  if (!answer.complete || others.some((sibling) => sibling.movedOn === null)) {
    return "cloud-siblings-unreadable";
  }
  return null;
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
