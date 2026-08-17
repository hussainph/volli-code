import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  createSessionRuntime,
  type HostedSessionRuntime,
  type NativeHarnessAdapter,
  type SessionEngine,
  type TranscriptArtifactStore,
} from "@volli/session-engine";
import { createDesktopSessionEngine } from "../session-control";
import { createDesktopSessionLocationResolver } from "./location";
import { createFileTranscriptArtifactStore } from "./transcript-artifacts";

export interface DesktopSessionRuntimeOptions {
  db: Database.Database;
  transcriptDirectory: string;
  executor: NativeHarnessAdapter;
  sessionEngine?: SessionEngine;
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
}

/** Composes the transport-neutral Session runtime with the desktop's durable executor. */
export function createDesktopSessionRuntime(
  options: DesktopSessionRuntimeOptions,
): HostedSessionRuntime {
  const now = options.now ?? Date.now;
  const nextId = options.nextId ?? randomUUID;
  return createSessionRuntime({
    engine: options.sessionEngine ?? createDesktopSessionEngine(options.db, { now, nextId }),
    executor: options.executor,
    artifacts: options.artifacts ?? createFileTranscriptArtifactStore(options.transcriptDirectory),
    locations: createDesktopSessionLocationResolver(options.db),
    clock: { now },
    ids: { next: () => nextId() },
  });
}

export { createDesktopSessionLocationResolver } from "./location";
export {
  createFileTranscriptArtifactStore,
  FileTranscriptArtifactStore,
} from "./transcript-artifacts";
