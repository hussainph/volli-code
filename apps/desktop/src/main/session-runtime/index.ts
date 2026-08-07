import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  createNativeAdapterRegistry,
  createSessionRuntime,
  type HostedSessionRuntime,
  type NativeHarnessAdapter,
  type SessionEngine,
} from "@volli/session-engine";
import { createDesktopSessionEngine } from "../session-control";
import { createDesktopSessionLocationResolver } from "./location";
import { createFileTranscriptArtifactStore } from "./transcript-artifacts";

export interface DesktopSessionRuntimeOptions {
  db: Database.Database;
  transcriptDirectory: string;
  adapters: readonly NativeHarnessAdapter[];
  sessionEngine?: SessionEngine;
  now?: () => number;
  nextId?: () => string;
}

/** Composes the transport-neutral Session runtime with the desktop's durable adapters. */
export function createDesktopSessionRuntime(
  options: DesktopSessionRuntimeOptions,
): HostedSessionRuntime {
  const now = options.now ?? Date.now;
  const nextId = options.nextId ?? randomUUID;
  return createSessionRuntime({
    engine: options.sessionEngine ?? createDesktopSessionEngine(options.db, { now, nextId }),
    adapters: createNativeAdapterRegistry(options.adapters),
    artifacts: createFileTranscriptArtifactStore(options.transcriptDirectory),
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
