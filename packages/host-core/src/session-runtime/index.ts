import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ObservabilitySink } from "@volli/shared";
import {
  createSessionRuntime,
  type HostedSessionRuntime,
  type NativeHarnessAdapter,
  type SessionEngine,
  type TranscriptArtifactStore,
} from "@volli/session-engine";
import { createCheckpointFailureReporter } from "@volli/host-core/session-control";
import type { HostEventBus } from "../ports";
import { createDesktopSessionLocationResolver } from "./location";
import { createFileTranscriptArtifactStore } from "./transcript-artifacts";

export interface DesktopSessionRuntimeOptions {
  db: Database.Database;
  events: HostEventBus;
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
export function createDesktopSessionRuntime(
  options: DesktopSessionRuntimeOptions,
): HostedSessionRuntime {
  const now = options.now ?? Date.now;
  const nextId = options.nextId ?? randomUUID;
  // Runtime write-path diagnostics; the Sessions module owns the engine's
  // read-path reporter. No engine is constructed here.
  const onProjectionCheckpointFailure = createCheckpointFailureReporter();
  return createSessionRuntime({
    engine: options.sessionEngine,
    executor: options.executor,
    artifacts: options.artifacts ?? createFileTranscriptArtifactStore(options.transcriptDirectory),
    locations: createDesktopSessionLocationResolver(
      options.db,
      { events: options.events },
      { dataDir: options.dataDir },
    ),
    clock: { now },
    ids: { next: () => nextId() },
    onProjectionCheckpointFailure,
    ...(options.observability === undefined ? {} : { observability: options.observability }),
  });
}

export { createDesktopSessionLocationResolver } from "./location";
export {
  createFileTranscriptArtifactStore,
  FileTranscriptArtifactStore,
  repackLegacyTranscriptArtifacts,
  sessionTranscriptsRoot,
  transcriptReferenceForId,
} from "./transcript-artifacts";
