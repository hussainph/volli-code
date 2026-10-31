/**
 * The three files an update passes between the daemon and the applier
 * (`layout.ts` says where each lives):
 *
 * - the **request** (`<dataDir>/update/request.json`): the daemon writes it,
 *   the applier reads it. In system mode the daemon runs as `volli`, the
 *   account every agent runs as, so the root applier reads the request as
 *   **untrusted**: through one non-following descriptor, size-capped, parsed
 *   strictly, and only ever a wish (`apply.ts` decides). A forged request can
 *   at most get a genuine signed release installed early.
 * - the **updater state** (`<installRoot>/update-state.json`): the applier's
 *   alone. Root-owned and world-readable in system mode, durable, and what the
 *   daemon reads to learn what was staged, applied or rolled back.
 * - the daemon's **reported** set and its **now** request (`update --now`).
 */
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  RUNNER_UPDATE_OUTCOME_KINDS,
  type RunnerUpdateOutcomeKind,
  type RunnerUpdateReport,
} from "@volli/shared/cloud";

import { atomicWrite, durableWrite } from "../shell/write-file";
import { isReleaseVersion } from "./manifest";

const MAX_REQUEST_BYTES = 8 * 1024;
const MAX_STATE_BYTES = 256 * 1024;
/** How many request ids and outcomes the state remembers. */
export const STATE_HISTORY = 32;

/**
 * Reads a small regular file through one descriptor that never follows a
 * final symlink and never blocks on a FIFO; `null` when it does not exist.
 * Anything else (a symlink, a directory, a device, an oversized file) throws.
 */
export function readSmallFile(path: string, maxBytes: number): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${path} is not a regular file.`);
    if (stat.size > maxBytes) throw new Error(`${path} is larger than ${maxBytes} bytes.`);
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

// ── the request ─────────────────────────────────────────────────────────────

/** Stage a release (download, verify, probe), or activate the staged one. */
export type UpdateRequest =
  | {
      readonly v: 1;
      readonly id: string;
      readonly phase: "stage";
      readonly version: string;
      readonly manifestUrl: string;
      readonly urgent: boolean;
    }
  | {
      readonly v: 1;
      readonly id: string;
      readonly phase: "activate";
      readonly version: string;
      readonly urgent: boolean;
    };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** The request on disk, or `null`; throws on anything that is not exactly a request. */
export function readUpdateRequest(path: string): UpdateRequest | null {
  const text = readSmallFile(path, MAX_REQUEST_BYTES);
  if (text === null) return null;
  const value = JSON.parse(text) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The update request is not an object.");
  }
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).toSorted().join(",");
  const common =
    row.v === 1 &&
    typeof row.id === "string" &&
    UUID.test(row.id) &&
    isReleaseVersion(row.version) &&
    typeof row.urgent === "boolean";
  if (
    common &&
    row.phase === "stage" &&
    keys === "id,manifestUrl,phase,urgent,v,version" &&
    typeof row.manifestUrl === "string"
  ) {
    return row as unknown as UpdateRequest;
  }
  if (common && row.phase === "activate" && keys === "id,phase,urgent,v,version") {
    return row as unknown as UpdateRequest;
  }
  throw new Error("The update request does not match its schema.");
}

type RequestBody<Phase extends UpdateRequest["phase"]> = Omit<
  Extract<UpdateRequest, { phase: Phase }>,
  "v" | "id"
>;

/** The daemon's side: a fresh request, replacing any before it. */
export function writeUpdateRequest(
  path: string,
  request: RequestBody<"stage"> | RequestBody<"activate">,
): UpdateRequest {
  const written = { v: 1, id: randomUUID(), ...request } as UpdateRequest;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  atomicWrite(path, `${JSON.stringify(written)}\n`, 0o600);
  return written;
}

// ── the updater state ───────────────────────────────────────────────────────

export type UpdateOutcomeKind = RunnerUpdateOutcomeKind;

/** One thing an update did; the daemon reports each to Volli once, by `id`. */
export interface UpdateOutcome {
  readonly id: string;
  readonly kind: UpdateOutcomeKind;
  /** The release the outcome is about: staged, applied, failed, or rolled back to. */
  readonly version: string;
  /** The release that was current before, when there was one. */
  readonly fromVersion: string | null;
  /** A short machine reason for a failure or a rollback. */
  readonly reason: string | null;
  readonly at: string;
}

/** One outcome as the daemon reports it to Volli (`runnerUpdateReports.report`). */
export function outcomeReport(outcome: UpdateOutcome): RunnerUpdateReport {
  return {
    outcomeId: outcome.id,
    kind: outcome.kind,
    version: outcome.version,
    fromVersion: outcome.fromVersion,
    reason: outcome.reason,
    at: Date.parse(outcome.at),
  };
}

export interface UpdaterState {
  readonly v: 1;
  /** The release staged under `releases/` and not yet activated. */
  readonly staged: string | null;
  /** The release `current` pointed to before the last activation: the rollback. */
  readonly previous: string | null;
  /** Releases that failed their health check here; never staged again. */
  readonly bad: readonly string[];
  /** The last request ids handled, so a request is acted on once. */
  readonly handled: readonly string[];
  readonly outcomes: readonly UpdateOutcome[];
}

export const EMPTY_STATE: UpdaterState = {
  v: 1,
  staged: null,
  previous: null,
  bad: [],
  handled: [],
  outcomes: [],
};

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isOutcome(value: unknown): value is UpdateOutcome {
  if (value === null || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    RUNNER_UPDATE_OUTCOME_KINDS.includes(row.kind as UpdateOutcomeKind) &&
    typeof row.version === "string" &&
    (row.fromVersion === null || typeof row.fromVersion === "string") &&
    (row.reason === null || typeof row.reason === "string") &&
    typeof row.at === "string"
  );
}

/** The updater state, {@link EMPTY_STATE} when there is none; throws on a damaged one. */
export function readUpdaterState(path: string): UpdaterState {
  const text = readSmallFile(path, MAX_STATE_BYTES);
  if (text === null) return EMPTY_STATE;
  const row = JSON.parse(text) as Record<string, unknown>;
  if (
    row === null ||
    typeof row !== "object" ||
    row.v !== 1 ||
    !(row.staged === null || typeof row.staged === "string") ||
    !(row.previous === null || typeof row.previous === "string") ||
    !strings(row.bad) ||
    !strings(row.handled) ||
    !Array.isArray(row.outcomes) ||
    !row.outcomes.every(isOutcome)
  ) {
    throw new Error(`${path} is not an updater state this build reads.`);
  }
  return row as unknown as UpdaterState;
}

/** The applier's side: durable, readable by the daemon, histories bounded. */
export function writeUpdaterState(path: string, state: UpdaterState): void {
  const bounded: UpdaterState = {
    ...state,
    handled: state.handled.slice(-STATE_HISTORY),
    outcomes: state.outcomes.slice(-STATE_HISTORY),
  };
  durableWrite(path, `${JSON.stringify(bounded, null, 2)}\n`, 0o644);
}

// ── the daemon's own ────────────────────────────────────────────────────────

/** `update --now`: update to Volli's target now, or to `version`. */
export interface NowRequest {
  readonly v: 1;
  readonly version: string | null;
  readonly at: string;
}

export function readNowRequest(path: string): NowRequest | null {
  const text = readSmallFile(path, MAX_REQUEST_BYTES);
  if (text === null) return null;
  const row = JSON.parse(text) as Record<string, unknown>;
  if (
    row === null ||
    typeof row !== "object" ||
    row.v !== 1 ||
    !(row.version === null || isReleaseVersion(row.version)) ||
    typeof row.at !== "string"
  ) {
    throw new Error(`${path} is not an update request this build reads.`);
  }
  return row as unknown as NowRequest;
}

/** Written by the install root's owner; world-readable, so a system daemon (as `volli`) reads it. */
export function writeNowRequest(path: string, version: string | null, at: Date): void {
  const request: NowRequest = { v: 1, version, at: at.toISOString() };
  atomicWrite(path, `${JSON.stringify(request)}\n`, 0o644);
}

/** The outcome ids the daemon has reported; an unreadable file is an empty set. */
export function readReported(path: string): Set<string> {
  try {
    const text = readSmallFile(path, MAX_STATE_BYTES);
    const value = text === null ? [] : (JSON.parse(text) as unknown);
    return new Set(strings(value) ? value : []);
  } catch {
    return new Set();
  }
}

export function writeReported(path: string, ids: Iterable<string>): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  atomicWrite(path, `${JSON.stringify([...ids].slice(-STATE_HISTORY * 2))}\n`, 0o600);
}
