/**
 * The attachments a relaunch has to retire before anything reads the ledger.
 *
 * Two kinds cannot survive a quit, and both would otherwise project as live
 * forever. A local terminal's PTY died with the process that owned it. An
 * `opencode` attachment is stranger: the structured OpenCode runtime is gone,
 * so no adapter can ever answer for that native identity again — a lazy
 * rehydration would raise `Native adapter opencode was not found` rather than
 * reconnect anything.
 *
 * Closing them is the durable, observable transition that turns them into
 * history. The invariant, in both cases: the Session itself stays open and its
 * transcript stays readable; only the binding is over. Pi never attaches under
 * an OpenCode native identity — a later attach is a fresh binding of its own.
 */
import type { SessionExecutionVenue, SessionObservation } from "@volli/shared";

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
}

/** The two Session Engine verbs boot recovery is allowed to reach. */
export interface BootRecoveryEngine {
  listSessions(query: { projectId: string; scope: "all" }): Promise<readonly BootRecoverySession[]>;
  /** The recorded event is not read here; only that the fact was accepted. */
  observe(observation: SessionObservation): Promise<unknown>;
}

export interface BootRecoveryOptions {
  engine: BootRecoveryEngine;
  projectIds: readonly string[];
  newId: () => string;
  now: () => number;
  /**
   * One malformed or concurrently-closed attachment must not leave every later
   * stale one falsely open after relaunch, so a failure is reported and the
   * sweep continues.
   */
  onError: (attachmentId: string, error: unknown) => void;
}

/**
 * Adapter ids whose open local attachments a relaunch always retires.
 *
 * Only these two. Every other adapter is a live executor that owns its own
 * recovery, and closing one here would forge the end of a binding that may
 * still be running.
 */
const STALE_ON_BOOT_ADAPTER_IDS: ReadonlySet<string> = new Set(["terminal", "opencode"]);

/** Closes every stale open attachment across the given projects; returns how many. */
export async function closeStaleAttachments(options: BootRecoveryOptions): Promise<number> {
  let closed = 0;
  for (const projectId of options.projectIds) {
    const sessions = await options.engine.listSessions({ projectId, scope: "all" });
    for (const projection of sessions) {
      for (const attachment of projection.attachments) {
        if (!isStaleOnBoot(attachment)) continue;
        try {
          await options.engine.observe({
            id: options.newId(),
            kind: "attachment.closed",
            sessionId: projection.session.id,
            attachmentId: attachment.id,
            occurredAt: options.now(),
            provenance: {
              source: { kind: "system", id: "desktop-recovery", detail: null },
              venue: { id: "local", kind: "local" },
            },
            outcome: "interrupted",
          });
          closed += 1;
        } catch (error) {
          options.onError(attachment.id, error);
        }
      }
    }
  }
  return closed;
}

function isStaleOnBoot(attachment: BootRecoveryAttachment): boolean {
  return (
    STALE_ON_BOOT_ADAPTER_IDS.has(attachment.adapterId) &&
    attachment.venue.kind === "local" &&
    attachment.status === "open"
  );
}
