/**
 * What the move engine is composed from. The engine owns the order of the
 * steps, the journal and every rule about data; each port is one edge it
 * does not own: the backend under the person's sign-in, object storage
 * through the move's presigned URLs, the exporter worker, the backup writer,
 * the Session-history upload and the runner's live work.
 */
import type { MigrationExportOptions, MigrationExportResult } from "../migration-export/exporter";

/**
 * The backend as the moving person calls it: Convex function paths
 * (`module:function`) with JSON arguments, under their own sign-in. An
 * application refusal is thrown as an error carrying `data.code` (Convex's
 * `ConvexError`); anything else is taken as the network.
 */
export interface MoveBackend {
  query(path: string, args: Record<string, unknown>): Promise<unknown>;
  mutation(path: string, args: Record<string, unknown>): Promise<unknown>;
  action(path: string, args: Record<string, unknown>): Promise<unknown>;
}

/** One object a move uploads: its final key, exact length and SHA-256. */
export interface MoveObject {
  key: string;
  bytes: number;
  sha256: string;
}

/** What a stored object answers to a HEAD. */
export interface StoredObject {
  bytes: number;
  /** Null when the store did not report a checksum. */
  sha256: string | null;
}

/**
 * Object storage for one move, through its presigned URLs. Keys are
 * write-once: `put` of a key that already holds an object answers
 * `"exists"` rather than overwriting it.
 */
export interface MoveObjectStore {
  put(
    moveId: string,
    object: MoveObject,
    body: () => Promise<Uint8Array | NodeJS.ReadableStream>,
  ): Promise<"stored" | "exists">;
  head(moveId: string, key: string): Promise<StoredObject | null>;
  /** Reads an object whole, hashing it as it streams (never held in memory). */
  digest(moveId: string, key: string): Promise<{ bytes: number; sha256: string } | null>;
}

/** One moved Session, as its history upload needs it. */
export interface MovedSession {
  sessionId: string;
  projectId: string;
  lastSequence: number;
}

export interface MovedSessionUploadReport {
  /** Transcript bodies its events name that this machine could not read: in no pack. */
  missing: readonly string[];
  /** Pi session files that could not be uploaded whole. */
  piFilesLeftBehind: number;
  packs: number;
  piSegments: number;
}

/**
 * A moved Session's history beyond its rows: the backend's event encoding,
 * its transcript packs and Pi logs, and this runner's drain cursors (VC-990).
 */
export interface MoveSessionHistory {
  /** One exported Session event as the import sends it. Pure. */
  eventRecord(record: Record<string, unknown>): Record<string, unknown>;
  /**
   * Packs and commits one Session's transcript bodies and Pi logs, resuming
   * from the backend's head. `move.runnerId` is the runner the import named.
   * `onSigned` hears of every upload URL as it is issued, before it is used.
   */
  upload(
    move: { moveId: string; runnerId: string },
    session: MovedSession,
    signal: AbortSignal,
    onSigned?: (object: MoveObject) => void,
  ): Promise<MovedSessionUploadReport>;
  /** Hands the moved Sessions to this runner at their imported heads. Idempotent. */
  seedCursors(
    ownerUserId: string,
    sessions: ReadonlyArray<{ sessionId: string; acceptedThrough: number }>,
  ): void;
}

/** The profile's verified backup: written once per queue, re-read before any freeze.
 * write rejects with AbortError on cancellation, or code ENOSPC on disk shortage
 * (the engine pauses without freezing); verification/I/O errors also never return
 * a usable backup. After publication, return even if cancellation arrived: the
 * engine journals the reusable result before honoring it. The production writer
 * always supplies sha256; it is optional only for older injected ports/journals.
 */
export interface MoveBackupPort {
  write(signal: AbortSignal): Promise<{ path: string; bytes: number; sha256?: string }>;
}

/** This Mac's live work: a project with any of these Sessions is not idle. */
export interface MoveLiveWork {
  busySessionIds(): ReadonlySet<string>;
}

/** Who is signed in now, and as which runner this Mac is registered for them. */
export interface MoveIdentity {
  current(): Promise<{ userId: string; runnerId: string } | null>;
}

/** The real-path check after the commit: the window's own reads, as the person. */
export interface MoveRealPathCheck {
  check(input: RealPathInput, signal: AbortSignal): Promise<RealPathReport>;
}

export interface RealPathInput {
  moveId: string;
  projectId: string;
  workspaceId: string;
  exportDir: string;
  sessions: readonly MovedSession[];
}

export interface RealPathReport {
  ok: boolean;
  /** Check name → counts (checked, matched, failed). Never content. */
  checks: Record<string, { checked: number; failed: number }>;
  failures: string[];
}

export interface MoveEnginePorts {
  /** The live profile: the journal, the freeze, the handover writes and the liveness reads. */
  db: import("better-sqlite3").Database;
  /** The live `volli.db` the exporter snapshots read-only. */
  profilePath: string;
  /** Where moves keep their exports and reports: `<userData>/cloud-moves`. */
  workRoot: string;
  stores: { blobsDir: string; transcriptsDir: string; piLogsDir: string };
  homeDir: string;
  appVersion: string;
  backend: MoveBackend;
  objects: MoveObjectStore;
  history: MoveSessionHistory;
  backup: MoveBackupPort;
  liveWork: MoveLiveWork;
  identity: MoveIdentity;
  realPath: MoveRealPathCheck;
  /** The exporter, normally in its worker (`runMigrationExportInWorker`). */
  exportProject(options: MigrationExportOptions): Promise<MigrationExportResult>;
  /** Holds the profile-maintenance lease (backups pause) around a whole run. */
  maintenance?<T>(work: () => Promise<T>): Promise<T>;
  /**
   * The project's drain cursors were taken back (Go back to local, a roll
   * back after the commit), for these Sessions: a running cloud launch's
   * drain forgets their streams. Without it, the drain drops them the next
   * time it looks at them.
   */
  cursorsReleased?(sessionIds: readonly string[]): void;
  now?: () => number;
  newId?: () => string;
  /** Backoff between retries. Resolves early (or rejects) when `signal` aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  log?: {
    info(message: string, detail?: object): void;
    warn(message: string, detail?: object): void;
  };
  /** Fault injection for the kill/resume matrix: called at every named point. */
  faults?: (point: string) => void | Promise<void>;
}
