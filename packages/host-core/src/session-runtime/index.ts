import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ObservabilitySink, SessionExecutionVenue } from "@volli/shared";
import {
  createSessionRuntime,
  type HostedSessionRuntime,
  type NativeHarnessAdapter,
  type SessionEngine,
  type TranscriptArtifactStore,
} from "@volli/session-engine";
import { createCheckpointFailureReporter } from "../session-control";
import type { HostEventBus } from "../ports";
import type { Logger } from "../log/logger";
import { correlatedExecutor } from "./correlated-executor";
import { createSessionLocationResolver } from "./location";
import { createSqliteSessionFollowUpLedger } from "../db/session-follow-up-repo";
import { createFileTranscriptArtifactStore } from "./transcript-artifacts";

export interface HostSessionRuntimeOptions {
  db: Database.Database;
  venue?: SessionExecutionVenue;
  events: HostEventBus;
  /**
   * The host's log port. hostd turns it into structured records; a failed
   * automatic follow-up release is reported here, never to a bare console.
   */
  log: Pick<Logger, "error">;
  dataDir: string;
  transcriptDirectory: string;
  executor: NativeHarnessAdapter;
  sessionEngine: SessionEngine;
  /**
   * The one artifact store for this launch. Passed in when another reader needs
   * the same store — `session peek`'s chat transcript tail reads it straight
   * from the ledger, outside the runtime — so one directory never grows two
   * store objects with two mkdir races. Defaults to the file store this
   * composition would have built for itself.
   */
  artifacts?: TranscriptArtifactStore;
  now?: () => number;
  nextId?: () => string;
  /**
   * The same opt-in VC-119 sink the Pi runtime holds, for the one measurement
   * only the Session runtime can make: time a message queued before its turn
   * opened (VC-455). Absent records nothing.
   */
  observability?: ObservabilitySink;
}

/** Composes the transport-neutral Session runtime with the desktop's durable executor. */
export function createHostSessionRuntime(options: HostSessionRuntimeOptions): HostedSessionRuntime {
  const now = options.now ?? Date.now;
  const nextId = options.nextId ?? randomUUID;
  // Runtime write-path diagnostics; the Sessions module owns the engine's
  // read-path reporter. No engine is constructed here.
  const onProjectionCheckpointFailure = createCheckpointFailureReporter();
  return createSessionRuntime({
    engine: options.sessionEngine,
    followUps: createSqliteSessionFollowUpLedger(options.db),
    // The payload stays durable and the Session raises Attention; this is the
    // operator's record of why an automatic release did not go out.
    onFollowUpFailure: (error) => options.log.error("follow-up queue release failed", { error }),
    // Attachments start detached, commands run under their own trace (VC-699).
    executor: correlatedExecutor(options.executor),
    artifacts: options.artifacts ?? createFileTranscriptArtifactStore(options.transcriptDirectory),
    locations: createSessionLocationResolver(
      options.db,
      { events: options.events },
      {
        dataDir: options.dataDir,
        ...(options.venue === undefined ? {} : { venue: options.venue }),
      },
    ),
    clock: { now },
    ids: { next: () => nextId() },
    onProjectionCheckpointFailure,
    ...(options.observability === undefined ? {} : { observability: options.observability }),
  });
}

export { correlatedExecutor } from "./correlated-executor";
export { createSessionLocationResolver } from "./location";
export {
  createFileTranscriptArtifactStore,
  FileTranscriptArtifactStore,
  repackLegacyTranscriptArtifacts,
  sessionTranscriptsRoot,
  transcriptReferenceForId,
} from "./transcript-artifacts";
