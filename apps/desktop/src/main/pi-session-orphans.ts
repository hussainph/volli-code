import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  unlinkSync,
} from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type Database from "better-sqlite3";
import type {
  PiSessionOrphanCandidate,
  PiSessionOrphanInventory,
  PiSessionOrphanKept,
  PiSessionOrphanReclaimInput,
  PiSessionOrphanReclaimReport,
  PiSessionOrphanSkipped,
} from "../ipc/contract";

const HEADER_LIMIT_BYTES = 64 * 1024;
const PI_ADAPTER_ID = "pi";
const NATIVE_BINDING_KIND = "volli.native-binding.v1";

interface FileIdentity {
  device: number;
  inode: number;
  sizeBytes: number;
  modifiedAt: number;
}

interface ConfirmedPiSidecar extends PiSessionOrphanCandidate, FileIdentity {
  cwd: string;
  createdAt: string;
}

interface ScanState {
  report: PiSessionOrphanInventory;
  candidates: Map<string, ConfirmedPiSidecar>;
}

export interface PiSessionOrphanServiceOptions {
  now?: () => number;
  nextId?: () => string;
}

/**
 * Main-process owner of Pi orphan inventory and explicit reclaim.
 *
 * A reclaim can name only item ids minted by this instance's latest scan. The
 * path never comes back from the renderer as authority: it stays in the cached
 * main-process proposal and is fully re-checked immediately before unlink.
 */
export class PiSessionOrphanService {
  readonly #root: string;
  readonly #now: () => number;
  readonly #nextId: () => string;
  #current: ScanState | null = null;

  constructor(
    private readonly db: Database.Database,
    root: string,
    options: PiSessionOrphanServiceOptions = {},
  ) {
    this.#root = resolve(root);
    this.#now = options.now ?? Date.now;
    this.#nextId = options.nextId ?? randomUUID;
  }

  /** Read-only inventory. Nothing in this call removes or rewrites a sidecar. */
  async scan(): Promise<PiSessionOrphanInventory> {
    // A requested re-scan retires the old proposal even if the fresh walk
    // fails. A failed refresh must not leave an older revision actionable.
    this.#current = null;
    const protectedIds = protectedPiSessionIds(this.db);
    const skipped: PiSessionOrphanSkipped[] = [];
    const confirmed = await scanPiSidecars(this.#root, skipped);
    const candidates = confirmed.filter((entry) => !protectedIds.has(entry.sessionId));
    const revision = this.#nextId();
    const report: PiSessionOrphanInventory = {
      revision,
      scannedAt: this.#now(),
      candidates: candidates.map(publicCandidate),
      candidateCount: candidates.length,
      candidateBytes: candidates.reduce((sum, candidate) => sum + candidate.sizeBytes, 0),
      skipped,
    };
    this.#current = {
      report,
      candidates: new Map(candidates.map((candidate) => [candidate.itemId, candidate])),
    };
    return report;
  }

  /**
   * Explicit destructive half. Every selected item is re-checked against the
   * owned root, header, filename, file identity, and fresh attachment set.
   */
  async reclaim(input: PiSessionOrphanReclaimInput): Promise<PiSessionOrphanReclaimReport> {
    const scan = this.#current;
    if (scan === null || scan.report.revision !== input.scanRevision) {
      throw new Error("This Pi session inventory is out of date. Scan again before cleaning up.");
    }
    if (new Set(input.itemIds).size !== input.itemIds.length) {
      throw new Error("Pi session cleanup contains duplicate inventory items.");
    }
    const selected = input.itemIds.map((itemId) => {
      const candidate = scan.candidates.get(itemId);
      if (candidate === undefined) {
        throw new Error("Pi session cleanup named an item that was not in the reviewed scan.");
      }
      return candidate;
    });

    const removed: PiSessionOrphanCandidate[] = [];
    const kept: PiSessionOrphanKept[] = [];
    for (const candidate of selected) {
      try {
        // This block is deliberately synchronous from the final db read through
        // unlink: no IPC or other main-process callback can attach this id in
        // the gap between the protection check and deletion.
        const current = inspectPiSidecarSync(this.#root, candidate.path);
        if (!sameIdentity(candidate, current)) {
          throw new Error("The file changed after it was inventoried");
        }
        const protectedIds = protectedPiSessionIds(this.db);
        if (protectedIds.has(current.sessionId)) {
          throw new Error("The Pi session is now referenced by a Volli attachment");
        }
        unlinkSync(candidate.path);
        removed.push(publicCandidate(candidate));
      } catch (error) {
        kept.push({ candidate: publicCandidate(candidate), reason: errorMessage(error) });
      }
    }

    // A cleanup changes the proposal even when one item is kept. Requiring a
    // fresh scan keeps a second click from acting on a partly-consumed list.
    this.#current = null;
    return {
      removed,
      kept,
      removedCount: removed.length,
      removedBytes: removed.reduce((sum, candidate) => sum + candidate.sizeBytes, 0),
    };
  }
}

/** Pi's one-directory-per-cwd naming rule, kept byte-for-byte with upstream. */
export function piSessionDirectoryName(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** Pi's timestamp plus encoded native-id sidecar naming rule. */
export function piSessionFilename(createdAt: string, id: string): string {
  return `${new Date(createdAt).toISOString().replace(/[:.]/g, "-")}_${encodeURIComponent(id)}.jsonl`;
}

function protectedPiSessionIds(db: Database.Database): Set<string> {
  const rows = db
    .prepare("SELECT id, adapter_id, native_id, native_detail FROM session_attachments")
    .all() as Array<{
    id: string;
    adapter_id: string;
    native_id: string | null;
    native_detail: string | null;
  }>;
  const protectedIds = new Set<string>();
  for (const row of rows) {
    if (row.native_id !== null) protectedIds.add(row.native_id);
    if (row.native_detail === null) {
      if (row.adapter_id === PI_ADAPTER_ID && row.native_id !== null) malformedAttachment(row.id);
      continue;
    }

    let detail: unknown;
    try {
      detail = JSON.parse(row.native_detail);
    } catch {
      if (row.adapter_id === PI_ADAPTER_ID) malformedAttachment(row.id);
      continue;
    }
    if (!isRecord(detail) || detail.kind !== NATIVE_BINDING_KIND) {
      if (row.adapter_id === PI_ADAPTER_ID) malformedAttachment(row.id);
      continue;
    }
    const locator = detail.locator;
    if (isRecord(locator) && locator.runtime === "pi") {
      if (
        typeof locator.sessionId !== "string" ||
        locator.sessionId.length === 0 ||
        typeof locator.sessionFilePath !== "string" ||
        locator.sessionFilePath.length === 0
      ) {
        malformedAttachment(row.id);
      }
      protectedIds.add(locator.sessionId);
      continue;
    }
    if (row.adapter_id === PI_ADAPTER_ID) malformedAttachment(row.id);
  }
  return protectedIds;
}

function malformedAttachment(id: string): never {
  throw new Error(`Malformed Pi attachment ${id}; orphan inventory failed closed.`);
}

async function scanPiSidecars(
  root: string,
  skipped: PiSessionOrphanSkipped[],
): Promise<ConfirmedPiSidecar[]> {
  let rootInfo: Awaited<ReturnType<typeof lstat>>;
  try {
    rootInfo = await lstat(root);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("The owned Pi sessions root is not a regular directory.");
  }

  const confirmed: ConfirmedPiSidecar[] = [];
  for (const directoryEntry of await readdir(root, { withFileTypes: true })) {
    const directoryPath = join(root, directoryEntry.name);
    if (directoryEntry.isSymbolicLink()) {
      skipped.push({ path: directoryPath, reason: "Symlinks are never scanned." });
      continue;
    }
    if (!directoryEntry.isDirectory()) {
      if (directoryEntry.name.endsWith(".jsonl")) {
        skipped.push({
          path: directoryPath,
          reason: "Pi sidecars must be inside their encoded working-directory folder.",
        });
      }
      continue;
    }

    for (const fileEntry of await readdir(directoryPath, { withFileTypes: true })) {
      if (!fileEntry.name.endsWith(".jsonl")) continue;
      const path = join(directoryPath, fileEntry.name);
      try {
        const sidecar = await inspectPiSidecar(root, path);
        confirmed.push(sidecar);
      } catch (error) {
        skipped.push({ path, reason: errorMessage(error) });
      }
    }
  }
  return confirmed.sort((left, right) => left.path.localeCompare(right.path));
}

async function inspectPiSidecar(root: string, path: string): Promise<ConfirmedPiSidecar> {
  assertOwnedSidecarPath(root, path);
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error("Not a regular Pi sidecar file");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let line: string;
  let opened: Awaited<ReturnType<typeof handle.stat>>;
  try {
    opened = await handle.stat();
    if (!opened.isFile()) throw new Error("Not a regular Pi sidecar file");
    line = await readFirstLine(handle);
  } finally {
    await handle.close();
  }
  const after = await lstat(path);
  if (!sameStats(before, opened) || !sameStats(opened, after)) {
    throw new Error("Pi sidecar changed while it was being scanned");
  }
  return confirmedSidecar(root, path, line, identity(after));
}

function inspectPiSidecarSync(root: string, path: string): ConfirmedPiSidecar {
  assertOwnedSidecarPath(root, path);
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("Not a regular Pi sidecar file");
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let line: string;
  let opened: ReturnType<typeof fstatSync>;
  try {
    opened = fstatSync(descriptor);
    if (!opened.isFile()) throw new Error("Not a regular Pi sidecar file");
    line = readFirstLineSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  const after = lstatSync(path);
  if (!sameStats(before, opened) || !sameStats(opened, after)) {
    throw new Error("Pi sidecar changed while it was being checked");
  }
  return confirmedSidecar(root, path, line, identity(after));
}

function confirmedSidecar(
  root: string,
  path: string,
  line: string,
  file: FileIdentity,
): ConfirmedPiSidecar {
  let header: unknown;
  try {
    header = JSON.parse(line);
  } catch {
    throw new Error("Pi sidecar header is not valid JSON");
  }
  if (
    !isRecord(header) ||
    header.kind !== "header" ||
    header.v !== 4 ||
    typeof header.id !== "string" ||
    header.id.length === 0 ||
    typeof header.createdAt !== "string" ||
    typeof header.cwd !== "string" ||
    header.cwd.length === 0
  ) {
    throw new Error("Pi sidecar header is not a recognized v4 header");
  }

  let expectedFilename: string;
  try {
    expectedFilename = piSessionFilename(header.createdAt, header.id);
  } catch {
    throw new Error("Pi sidecar header has an invalid createdAt value");
  }
  const parts = relative(root, path).split(sep);
  if (
    parts.length !== 2 ||
    parts[0] !== piSessionDirectoryName(header.cwd) ||
    parts[1] !== expectedFilename
  ) {
    throw new Error("Pi sidecar path does not match its confirmed header");
  }

  return {
    itemId: `pi-orphan:${createHash("sha256").update(path).digest("hex")}`,
    path,
    sessionId: header.id,
    cwd: header.cwd,
    createdAt: header.createdAt,
    ...file,
  };
}

function assertOwnedSidecarPath(root: string, path: string): void {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  const within = relative(resolvedRoot, resolvedPath);
  if (!isAbsolute(resolvedRoot) || within.startsWith(`..${sep}`) || isAbsolute(within)) {
    throw new Error("Pi sidecar path is outside the owned root");
  }
  const parts = within.split(sep);
  if (parts.length !== 2 || !parts[0]?.startsWith("--") || !parts[0].endsWith("--")) {
    throw new Error("Pi sidecar path is not in a recognized owned directory");
  }
  const rootInfo = lstatSync(resolvedRoot);
  const directoryInfo = lstatSync(join(resolvedRoot, parts[0]));
  if (
    !rootInfo.isDirectory() ||
    rootInfo.isSymbolicLink() ||
    !directoryInfo.isDirectory() ||
    directoryInfo.isSymbolicLink()
  ) {
    throw new Error("Pi sidecar ownership path contains a symlink");
  }
}

async function readFirstLine(handle: Awaited<ReturnType<typeof open>>): Promise<string> {
  const buffer = Buffer.alloc(4096);
  const chunks: Buffer[] = [];
  let total = 0;
  while (total < HEADER_LIMIT_BYTES) {
    const length = Math.min(buffer.length, HEADER_LIMIT_BYTES - total);
    const { bytesRead } = await handle.read(buffer, 0, length, total);
    if (bytesRead === 0) break;
    const chunk = Buffer.from(buffer.subarray(0, bytesRead));
    const newline = chunk.indexOf(0x0a);
    if (newline >= 0) {
      chunks.push(chunk.subarray(0, newline));
      return Buffer.concat(chunks).toString("utf8");
    }
    chunks.push(chunk);
    total += bytesRead;
  }
  throw new Error("Pi sidecar has no bounded first-line header");
}

function readFirstLineSync(descriptor: number): string {
  const buffer = Buffer.alloc(4096);
  const chunks: Buffer[] = [];
  let total = 0;
  while (total < HEADER_LIMIT_BYTES) {
    const length = Math.min(buffer.length, HEADER_LIMIT_BYTES - total);
    const bytesRead = readSync(descriptor, buffer, 0, length, total);
    if (bytesRead === 0) break;
    const chunk = Buffer.from(buffer.subarray(0, bytesRead));
    const newline = chunk.indexOf(0x0a);
    if (newline >= 0) {
      chunks.push(chunk.subarray(0, newline));
      return Buffer.concat(chunks).toString("utf8");
    }
    chunks.push(chunk);
    total += bytesRead;
  }
  throw new Error("Pi sidecar has no bounded first-line header");
}

function identity(stats: {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}): FileIdentity {
  return {
    device: stats.dev,
    inode: stats.ino,
    sizeBytes: stats.size,
    modifiedAt: stats.mtimeMs,
  };
}

function sameStats(
  left: { dev: number; ino: number; size: number; mtimeMs: number },
  right: { dev: number; ino: number; size: number; mtimeMs: number },
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.sizeBytes === right.sizeBytes &&
    left.modifiedAt === right.modifiedAt
  );
}

function publicCandidate(candidate: ConfirmedPiSidecar): PiSessionOrphanCandidate {
  return {
    itemId: candidate.itemId,
    path: candidate.path,
    sessionId: candidate.sessionId,
    sizeBytes: candidate.sizeBytes,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
