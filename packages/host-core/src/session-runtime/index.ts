import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ObservabilitySink, RunnerIdentity } from "@volli/shared";
import {
  createSessionRuntime,
  type HostedSessionRuntime,
  mapSessionExecutorSlot,
  type SessionExecutorSlot,
  type SessionEngine,
  type SubscribeCommittedSessionEvents,
  type TranscriptArtifactStore,
} from "@volli/session-engine";
import { createCheckpointFailureReporter } from "../session-control";
import type { HostEventBus, PowerPort } from "../ports";
import type { Logger } from "../log/logger";
import { correlatedExecutor } from "./correlated-executor";
import { createSessionLocationResolver, type WorktreeSetupEnvironment } from "./location";
import { createSqliteSessionFollowUpLedger } from "../db/session-follow-up-repo";
import { createFileTranscriptArtifactStore } from "./transcript-artifacts";

export interface HostSessionRuntimeOptions {
  db: Database.Database;
  venue?: RunnerIdentity;
  events: HostEventBus;
  /**
   * The host's log port. hostd turns it into structured records; a failed
   * automatic follow-up release is reported here, never to a bare console.
   */
  log: Pick<Logger, "error">;
  dataDir: string;
  transcriptDirectory: string;
  /** The structured runtimes Sessions run on; Pi is the one that ships (VC-916). */
  executors: SessionExecutorSlot;
  sessionEngine: SessionEngine;
  /**
   * Every Session Event `sessionEngine` commits, from the host's wake bus
   * (`session-control/session-wake.ts`). It is how a write made around the
   * runtime — a retitle, a CLI signal, a terminal's command bookkeeping —
   * reaches an open chat as it commits (VC-790). Absent, such a write waits
   * for the next event the runtime publishes itself.
   */
  committed?: SubscribeCommittedSessionEvents;
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
   * The shell and environment a worktree's setup command runs in when a
   * structured Session's start owes it (VC-835). Absent uses the host's own
   * environment as is.
   */
  setupEnvironment?: (sessionId: string) => Promise<WorktreeSetupEnvironment>;
  /** Whether a working copy's environment recipe runs (VC-584, the `cloud` flag). */
  environmentRecipes?: () => boolean;
  /** The machine's wakes, which owe each working copy its `.agents/resume` again. */
  power?: PowerPort;
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
    ...(options.committed === undefined ? {} : { committed: options.committed }),
    followUps: createSqliteSessionFollowUpLedger(options.db),
    // The payload stays durable and the Session raises Attention; this is the
    // operator's record of why an automatic release did not go out.
    onFollowUpFailure: (error) => options.log.error("follow-up queue release failed", { error }),
    // Attachments start detached, commands run under their own trace (VC-699).
    executors: mapSessionExecutorSlot(options.executors, correlatedExecutor),
    artifacts: options.artifacts ?? createFileTranscriptArtifactStore(options.transcriptDirectory),
    locations: createSessionLocationResolver(
      options.db,
      { events: options.events },
      {
        dataDir: options.dataDir,
        ...(options.venue === undefined ? {} : { venue: options.venue }),
        ...(options.setupEnvironment === undefined
          ? {}
          : { setupEnvironment: options.setupEnvironment }),
        ...(options.environmentRecipes === undefined
          ? {}
          : { environmentRecipes: options.environmentRecipes }),
        ...(options.power === undefined ? {} : { power: options.power }),
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
