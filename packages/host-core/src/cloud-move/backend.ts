/**
 * The move's calls to the backend's person-authorized import
 * (`convex/functions/projectImports.ts`), with the engine's one retry rule:
 * a call the network lost is sent again, unchanged, with backoff (every
 * import call is idempotent: `begin` by move id, `importRows` answers
 * `unchanged` for what landed, `commit` answers `committed`); an
 * application refusal is not retried and reaches the step as a
 * {@link MoveBackendError} naming its code.
 */
import type { MigrationImportStream } from "@volli/shared/cloud";

import type { MoveBackend } from "./ports";

/** An application refusal from the backend: a code the step decides on. */
export class MoveBackendError extends Error {
  readonly code: string;
  readonly data: Record<string, unknown>;
  constructor(code: string, message: string, data: Record<string, unknown>) {
    super(message);
    this.name = "MoveBackendError";
    this.code = code;
    this.data = data;
  }
}

/** The network stayed down through every retry: the move pauses and resumes later. */
export class MoveNetworkError extends Error {
  constructor(cause: unknown) {
    super("Volli Cloud did not answer. Nothing is lost; the move resumes.", { cause });
    this.name = "MoveNetworkError";
  }
}

/**
 * The refusal a thrown value carries, or null for the network. A Convex
 * application error carries `data` (an object with a `code`, or a string);
 * a server-side failure (`Server Error`, an uncaught exception, a validator)
 * is a refusal too, named `backend_error`, never retried forever.
 */
export function refusalOf(error: unknown): MoveBackendError | null {
  if (error instanceof MoveBackendError) return error;
  const data = (error as { data?: unknown } | null)?.data;
  if (data !== undefined && data !== null) {
    if (typeof data === "object" && typeof (data as { code?: unknown }).code === "string") {
      const record = data as Record<string, unknown>;
      return new MoveBackendError(
        record.code as string,
        typeof record.message === "string" ? record.message : String(record.code),
        record,
      );
    }
    return new MoveBackendError("backend_error", String(data), {});
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/Server Error|Uncaught|ArgumentValidationError|ReturnsValidationError/.test(message)) {
    return new MoveBackendError("backend_error", message.split("\n")[0]!.slice(0, 200), {});
  }
  return null;
}

export interface RetryPolicy {
  attempts: number;
  baseMs: number;
  maxMs: number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  signal: AbortSignal;
  onRetry?: (attempt: number, error: unknown) => void;
  /** Errors that are neither a refusal nor the network (a full disk): thrown as they are. */
  passThrough?: (error: unknown) => boolean;
}

/** Runs `call`, retrying what the network lost. */
export async function withRetry<T>(call: () => Promise<T>, policy: RetryPolicy): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.attempts; attempt += 1) {
    policy.signal.throwIfAborted();
    try {
      return await call();
    } catch (error) {
      if (policy.passThrough?.(error) === true) throw error;
      const refusal = refusalOf(error);
      if (refusal !== null) throw refusal;
      lastError = error;
      if (attempt === policy.attempts) break;
      policy.onRetry?.(attempt, error);
      await policy.sleep(Math.min(policy.baseMs * 2 ** (attempt - 1), policy.maxMs), policy.signal);
    }
  }
  throw new MoveNetworkError(lastError);
}

export interface StreamPromise {
  stream: MigrationImportStream;
  count: number;
  digest: string;
}

export interface ImportRowsAnswer {
  inserted: number;
  unchanged: number;
  conflicts: Array<{ index: number; code: string; detail: string }>;
  rejected: Array<{ index: number; code: string; detail: string }>;
  accumulated: { count: number; digest: string };
}

export interface ImportStatus {
  moveId: string;
  projectId: string;
  status: "reserved" | "importing" | "committed" | "aborting" | "purged";
  committedAt: number | null;
  streams: Array<{
    stream: string;
    expectedCount: number;
    expectedDigest: string;
    count: number;
    digest: string;
  }>;
}

export interface ReadRowsPage {
  rows: Array<Record<string, unknown>>;
  continueCursor: string;
  isDone: boolean;
}

/** The import's functions, each retried as {@link withRetry} says. */
export function importCalls(backend: MoveBackend, retry: Omit<RetryPolicy, "signal">) {
  const run = <T>(signal: AbortSignal, call: () => Promise<unknown>) =>
    withRetry(call, { ...retry, signal }) as Promise<T>;
  return {
    begin: (
      signal: AbortSignal,
      args: {
        moveId: string;
        projectId: string;
        workspaceId: string;
        runnerId: string;
        manifestSha256: string;
        expected: readonly StreamPromise[];
      },
    ) =>
      run<{ moveId: string; status: string }>(signal, () =>
        backend.mutation("projectImports:begin", { ...args, expected: [...args.expected] }),
      ),
    importRows: (
      signal: AbortSignal,
      args: { moveId: string; stream: MigrationImportStream; rows: readonly unknown[] },
    ) =>
      run<ImportRowsAnswer>(signal, () =>
        backend.mutation("projectImports:importRows", { ...args, rows: [...args.rows] }),
      ),
    status: (signal: AbortSignal, moveId: string) =>
      run<ImportStatus>(signal, () => backend.query("projectImports:status", { moveId })),
    readRows: (
      signal: AbortSignal,
      args: {
        moveId: string;
        stream: MigrationImportStream;
        parentId: string | null;
        cursor: string | null;
        numItems: number;
        maximumBytesRead?: number;
      },
    ) => run<ReadRowsPage>(signal, () => backend.query("projectImports:readRows", args)),
    commit: (signal: AbortSignal, args: { moveId: string; manifestSha256: string }) =>
      run<{ status: string }>(signal, () => backend.mutation("projectImports:commit", args)),
    uncommit: (signal: AbortSignal, args: { moveId: string; confirmChanged: boolean }) =>
      run<{ status: string }>(signal, () => backend.mutation("projectImports:uncommit", args)),
    abort: (signal: AbortSignal, moveId: string) =>
      run<{ status: string }>(signal, () => backend.mutation("projectImports:abort", { moveId })),
  };
}

export type ImportCalls = ReturnType<typeof importCalls>;
