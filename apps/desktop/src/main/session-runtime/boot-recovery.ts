/**
 * The attachments a relaunch has to retire before anything reads the ledger.
 *
 * One executor can answer for a local attachment after a quit, and it is the
 * structured one: Pi rehydrates from its own recovery sidecar. Everything else
 * is over the moment the process is. A terminal companion's PTY died with the
 * process that owned it. A binding written under any other adapter id — the
 * departed `opencode` runtime, or whatever a future build retires — names a
 * native identity nothing left in this build can reconnect to; a lazy
 * rehydration would refuse it as an adapter that was not found rather than
 * reconnect anything, and the attachment would meanwhile project as live.
 *
 * Closing them is the durable, observable transition that turns them into
 * history. The invariant is the same in every case: the Session itself stays
 * open and its transcript stays readable; only the binding is over. The
 * structured executor never attaches under someone else's native identity — a
 * later attach is a fresh binding of its own.
 */
import type { SessionExecutionVenue, SessionObservation } from "@volli/shared";

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
    attachment.adapterId !== STRUCTURED_ADAPTER_ID &&
    attachment.venue.kind === "local" &&
    attachment.status === "open"
  );
}
