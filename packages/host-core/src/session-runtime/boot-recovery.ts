/**
 * The attachments a relaunch has to recover before anything reads the ledger.
 *
 * One executor can answer for a local attachment after a quit, and it is the
 * structured one: Pi rehydrates from its own recovery sidecar. A turn that was
 * active at process loss is reconciled eagerly so its interruption becomes a
 * durable Session fact before listings read it. Everything else
 * is over the moment the process is. A terminal companion's PTY died with the
 * process that owned it. A binding written under any other adapter id — the
 * departed `opencode` runtime, or whatever a future build retires — names a
 * native identity nothing left in this build can reconnect to; a lazy
 * rehydration would refuse it as an adapter that was not found rather than
 * reconnect anything, and the attachment would meanwhile project as live.
 *
 * A reconcile can fail on either side of rebuilding the binding. When the
 * executor could not be rebuilt, nothing survives and the host closes the
 * attachment. When it was rebuilt, its replay of the sidecar comes first and
 * may already have recorded how the lost turn ended — the listing this sweep
 * read predates that — so the ledger is read again, and a turn the executor
 * ended stays on its live attachment for restart resume (VC-450, VC-926).
 * Every close says why in its provenance ({@link BootRecoveryReason}).
 *
 * Closing them is the durable, observable transition that turns them into
 * history. The invariant is the same in every case: the Session itself stays
 * open and its transcript stays readable; only the binding is over. The
 * structured executor never attaches under someone else's native identity — a
 * later attach is a fresh binding of its own.
 */
import {
  logErrorSummary,
  type LogErrorSummary,
  type SessionExecutionVenue,
  type SessionInteraction,
  type SessionNativeDetail,
  type SessionObservation,
} from "@volli/shared";

import { STRUCTURED_ADAPTER_ID } from "./sessions";

/** Exactly what the sweep reads of an attachment; a full projection satisfies it. */
export interface BootRecoveryAttachment {
  readonly id: string;
  readonly adapterId: string;
  readonly venue: SessionExecutionVenue;
  readonly status: "open" | "failed" | "closed";
}

export interface BootRecoverySession {
  readonly session: { readonly id: string };
  readonly attachments: readonly BootRecoveryAttachment[];
  /** Whether the durable ledger still has a turn open from the prior process. */
  readonly turnActive: boolean;
  /** The newest thing that happened here — evidence of when the prior process was last alive. */
  readonly lastActivityAt?: number;
  /** Cards parked in the lost process cannot resume their tool call after boot. */
  readonly interactions?: {
    readonly active: readonly Pick<SessionInteraction, "id" | "attachmentId" | "kind">[];
  };
}

/** The Session Engine verbs boot recovery is allowed to reach. */
export interface BootRecoveryEngine {
  listSessions(query: { projectId: string; scope: "all" }): Promise<readonly BootRecoverySession[]>;
  /**
   * One Session as the ledger has it now. Read after a failed reconcile,
   * because the listing predates it: a rebuilt executor may already have
   * replayed the lost turn's end before the failure (VC-926).
   */
  getSession(query: {
    sessionId: string;
  }): Promise<Pick<BootRecoverySession, "attachments" | "turnActive"> | null>;
  /** The recorded event is not read here; only that the fact was accepted. */
  observe(observation: SessionObservation): Promise<unknown>;
}

export interface BootRecoveryOptions {
  engine: BootRecoveryEngine;
  /** Only this host's bindings are owned by its restart. Defaults to desktop. */
  venue?: SessionExecutionVenue;
  /** Host-specific upgrade ownership; never broadens ordinary runtime authority. */
  ownsLegacyVenue?(venue: SessionExecutionVenue): boolean;
  /** Rehydrate and reconcile a structured attachment that lost its process mid-turn. */
  reconcile(input: { sessionId: string; attachmentId: string }): Promise<void>;
  /**
   * Whether the runtime now holds a live binding for the attachment: after a
   * failed reconcile, the line between an executor that could not be rebuilt
   * and one that was rebuilt and then failed to reconcile its history.
   * Absent, every failure counts as a binding that could not be rebuilt.
   */
  holdsBinding?(attachmentId: string): boolean;
  projectIds: readonly string[];
  newId: () => string;
  now: () => number;
  /**
   * One malformed or concurrently-closed attachment must not leave every later
   * stale one falsely open after relaunch, so a failure is reported and the
   * sweep continues.
   */
  onError: (attachmentId: string, error: unknown) => void;
  /**
   * Told about every structured attachment whose reconcile failed, with the
   * classified reason and what the sweep did about it — the line a support
   * report and a log need to tell the cases apart. Absent, the failure goes to
   * {@link onError} unclassified.
   */
  onFailure?(failure: BootRecoveryFailure): void;
  /**
   * Whether the host is shutting down. Read at each async boundary: once it
   * answers yes, the sweep starts no new project query or attachment work and
   * leaves the remaining bindings as the prior process left them, for the next
   * launch to recover. A reconcile rejected under a closing host is a stop,
   * not a lost sidecar — nothing durable is recorded for it. Legacy callers
   * that omit this always sweep to completion.
   */
  shouldStop?(): boolean;
  /**
   * Told once, when a sweep finishes, which interrupted turns it recovered onto
   * a rebuilt attachment — the turns a restart resume may continue (VC-450) —
   * and when the prior process was last known alive: the newest activity any
   * listed Session recorded, or `null` when none did. A sweep a shutdown cut
   * short tells nothing; the next launch recovers the rest.
   */
  onRecovered?(recovered: BootRecoveredTurns): void;
}

/**
 * Why boot recovery closed an attachment rather than recovering it (VC-926).
 *
 * Recorded on the host's own recovery facts — the `:boot-recovery` Attention
 * and the close — as `provenance.source.detail.bootRecovery`, so the ledger
 * alone says why, long after the log that saw it has rotated. The values are
 * durable: add one, never rename or reuse one.
 */
export type BootRecoveryReason =
  /** The executor could not rebuild the binding: its sidecar, workspace or Session would not open. */
  | "binding_unrecoverable"
  /** The executor rebuilt the binding, but reconciling its history failed with the turn still open. */
  | "reconcile_failed"
  /** Not the structured executor: a terminal companion or a retired runtime nothing here reconnects. */
  | "not_rebuildable";

/** The reason a close carries in its provenance, and the error behind it as far as is safe to keep. */
export interface BootRecoveryDetail {
  readonly reason: BootRecoveryReason;
  /** The failure's class name and stable code — never its message. `null` when nothing failed. */
  readonly error: LogErrorSummary | null;
}

/** One structured attachment whose reconcile failed, and what the sweep did about it. */
export interface BootRecoveryFailure {
  readonly sessionId: string;
  readonly attachmentId: string;
  readonly reason: Exclude<BootRecoveryReason, "not_rebuildable">;
  /**
   * `recovered`: the rebuilt executor had already recorded the lost turn's
   * end, so the attachment stays open and a restart resume may continue it.
   * `closed`: the host raised the process-loss Attention and closed it.
   */
  readonly outcome: "recovered" | "closed";
  /** The raw failure, for a log that redacts it; never written to the ledger. */
  readonly error: unknown;
}

/** The interrupted turns one sweep recovered onto a live attachment. */
export interface BootRecoveredTurns {
  readonly turns: readonly { readonly sessionId: string; readonly attachmentId: string }[];
  readonly lostAt: number | null;
}

/**
 * Reconciles structured turns left open by a crash and closes every attachment
 * that cannot survive this process. Returns how many attachments were closed.
 */
export async function closeStaleAttachments(options: BootRecoveryOptions): Promise<number> {
  let closed = 0;
  const venue = options.venue ?? { id: "local", kind: "local" };
  const owns = (attachment: BootRecoveryAttachment) =>
    (attachment.venue.id === venue.id && attachment.venue.kind === venue.kind) ||
    (options.ownsLegacyVenue?.(attachment.venue) ?? false);
  // Shutdown is not a failure: once the host is closing, only the attachment
  // already in flight may finish, and a reconcile unblocked by that close is a
  // stop, not a lost sidecar — no durable fact is recorded from it.
  const stopping = () => options.shouldStop?.() ?? false;
  const recovered: { sessionId: string; attachmentId: string }[] = [];
  let lostAt: number | null = null;
  for (const projectId of options.projectIds) {
    if (stopping()) return closed;
    const sessions = await options.engine.listSessions({ projectId, scope: "all" });
    for (const projection of sessions) {
      if (projection.lastActivityAt !== undefined) {
        lostAt = Math.max(lostAt ?? projection.lastActivityAt, projection.lastActivityAt);
      }
      for (const attachment of projection.attachments) {
        if (stopping()) return closed;
        // A local process restart cannot recover the promise that parked a
        // permission or model question, even if the turn already interrupted
        // or its sidecar is lost. Retiring it invents no answer or allowance.
        if (attachment.adapterId === STRUCTURED_ADAPTER_ID && owns(attachment)) {
          for (const interaction of projection.interactions?.active ?? []) {
            if (stopping()) return closed;
            if (interaction.attachmentId !== attachment.id) continue;
            try {
              await options.engine.observe({
                id: options.newId(),
                sessionId: projection.session.id,
                attachmentId: attachment.id,
                occurredAt: options.now(),
                provenance: {
                  source: { kind: "system", id: "desktop-recovery", detail: null },
                  venue: attachment.venue,
                },
                kind: "interaction.cancelled",
                interactionId: interaction.id,
                reason: "abandoned",
              });
            } catch (error) {
              options.onError(attachment.id, error);
            }
          }
        }
        if (stopping()) return closed;
        let detail: BootRecoveryDetail;
        if (needsStructuredTurnRecovery(projection, attachment, owns(attachment))) {
          try {
            await options.reconcile({
              sessionId: projection.session.id,
              attachmentId: attachment.id,
            });
            recovered.push({ sessionId: projection.session.id, attachmentId: attachment.id });
            continue;
          } catch (error) {
            if (stopping()) return closed;
            const reason =
              (options.holdsBinding?.(attachment.id) ?? false)
                ? "reconcile_failed"
                : "binding_unrecoverable";
            const report = (outcome: BootRecoveryFailure["outcome"]) => {
              const failure = {
                sessionId: projection.session.id,
                attachmentId: attachment.id,
                reason,
                outcome,
                error,
              } as const;
              if (options.onFailure) options.onFailure(failure);
              else options.onError(attachment.id, error);
            };
            // A rebuilt executor replays its own history before anything else
            // in a reconcile can fail, so the lost turn's end may already be on
            // the ledger the listing predates. Then the turn is recovered: the
            // attachment and its live binding stay, and a restart resume may
            // continue it. Closing it would strand a turn the executor saved.
            if (reason === "reconcile_failed") {
              if (await endedOnLiveAttachment(options, projection.session.id, attachment.id)) {
                report("recovered");
                recovered.push({ sessionId: projection.session.id, attachmentId: attachment.id });
                continue;
              }
              if (stopping()) return closed;
            }
            // The host found a turn with no surviving process. Record that
            // failure predicate even when the runtime could not reconstruct
            // its own sidecar, then close the unusable attachment so the
            // durable projection no longer claims the turn is active.
            report("closed");
            detail = { reason, error: logErrorSummary(error) };
            await tryRaiseCrashRecoveryAttention(
              options,
              projection.session.id,
              attachment.id,
              detail,
            );
          }
        } else if (!isStaleOnBoot(attachment, owns(attachment))) {
          continue;
        } else {
          detail = { reason: "not_rebuildable", error: null };
          if (projection.turnActive) {
            await tryRaiseCrashRecoveryAttention(
              options,
              projection.session.id,
              attachment.id,
              detail,
            );
          }
        }
        if (stopping()) return closed;
        try {
          await closeInterrupted(options, projection.session.id, attachment.id, detail);
          closed += 1;
        } catch (error) {
          options.onError(attachment.id, error);
        }
      }
    }
  }
  if (!stopping()) options.onRecovered?.({ turns: recovered, lostAt });
  return closed;
}

/**
 * Whether the ledger now shows the turn ended with the attachment still open:
 * the rebuilt executor replayed the turn's end before its reconcile failed.
 * A read that fails is no evidence, and the turn is treated as still open.
 */
async function endedOnLiveAttachment(
  options: BootRecoveryOptions,
  sessionId: string,
  attachmentId: string,
): Promise<boolean> {
  try {
    const current = await options.engine.getSession({ sessionId });
    return (
      current !== null &&
      !current.turnActive &&
      current.attachments.some(({ id, status }) => id === attachmentId && status === "open")
    );
  } catch (error) {
    options.onError(attachmentId, error);
    return false;
  }
}

/** The host's recovery provenance, carrying why it closed what it closed. */
function recoveryProvenance(
  options: BootRecoveryOptions,
  detail: BootRecoveryDetail,
): SessionObservation["provenance"] {
  return {
    source: {
      kind: "system",
      id: "desktop-recovery",
      detail: {
        sessionOrigin: { kind: "volli", reason: "relaunch-recovery" },
        bootRecovery: { reason: detail.reason, error: errorDetail(detail.error) },
      },
    },
    venue: options.venue ?? { id: "local", kind: "local" },
  };
}

function errorDetail(error: LogErrorSummary | null): SessionNativeDetail {
  if (error === null) return null;
  return error.code === undefined ? { name: error.name } : { name: error.name, code: error.code };
}

async function tryRaiseCrashRecoveryAttention(
  options: BootRecoveryOptions,
  sessionId: string,
  attachmentId: string,
  detail: BootRecoveryDetail,
): Promise<void> {
  try {
    await raiseCrashRecoveryAttention(options, sessionId, attachmentId, detail);
  } catch (error) {
    options.onError(attachmentId, error);
  }
}

function raiseCrashRecoveryAttention(
  options: BootRecoveryOptions,
  sessionId: string,
  attachmentId: string,
  detail: BootRecoveryDetail,
): Promise<unknown> {
  return options.engine.observe({
    id: options.newId(),
    kind: "attention.raised",
    sessionId,
    attachmentId,
    occurredAt: options.now(),
    provenance: recoveryProvenance(options, detail),
    attention: {
      id: `${attachmentId}:boot-recovery`,
      attachmentId,
      kind: "partial_turn_interrupted",
      detail: "The prior desktop process ended while this turn was active.",
      diagnostic: null,
    },
  });
}

function closeInterrupted(
  options: BootRecoveryOptions,
  sessionId: string,
  attachmentId: string,
  detail: BootRecoveryDetail,
): Promise<unknown> {
  return options.engine.observe({
    id: options.newId(),
    kind: "attachment.closed",
    sessionId,
    attachmentId,
    occurredAt: options.now(),
    provenance: recoveryProvenance(options, detail),
    outcome: "interrupted",
  });
}

function needsStructuredTurnRecovery(
  session: BootRecoverySession,
  attachment: BootRecoveryAttachment,
  owned: boolean,
): boolean {
  return (
    session.turnActive &&
    attachment.adapterId === STRUCTURED_ADAPTER_ID &&
    owned &&
    attachment.status === "open"
  );
}

function isStaleOnBoot(attachment: BootRecoveryAttachment, owned: boolean): boolean {
  return attachment.adapterId !== STRUCTURED_ADAPTER_ID && owned && attachment.status === "open";
}
