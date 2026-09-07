/**
 * The bundle's container: a gzip-compressed POSIX ustar archive.
 *
 * Written by hand, and that is a decision rather than an omission. A backup
 * reader is a program that opens a file a stranger may have written, so the
 * archive layer is a security boundary; the guarantees this module needs —
 * only regular files, only paths in a fixed safe shape, no duplicates, no
 * partial result from a truncated stream — are exactly the ones a general
 * archive library leaves to its caller, and getting them right is a hundred
 * lines here against a dependency whose defaults would have to be audited
 * anyway. ustar is a documented, forty-year-old block format that `tar -tzf`
 * can list, so a bundle stays inspectable without Volli.
 *
 * What this layer does NOT do is decide what belongs in a bundle. It moves
 * named byte strings; `bundle.ts` decides which names are expected and holds
 * every entry against the manifest's hashes.
 *
 * Long names are refused rather than split across ustar's `prefix` field: the
 * bundle's own paths are short and fixed-shape, and a reader that reassembles
 * a name from two places is a reader with a second way to be tricked.
 */
import { gunzipSync, gzipSync } from "node:zlib";

/** ustar's fixed block. Headers are one block; file bodies are padded to a multiple of it. */
export const TAR_BLOCK_SIZE = 512;

/** ustar's name field, and so the longest path a bundle entry may have. */
const MAX_PATH_LENGTH = 100;

/** One entry: a name and its bytes. Directories are implied, never stored. */
export interface ArchiveEntry {
  path: string;
  bytes: Buffer;
}

/** A container-level failure: malformed, unsafe, or not an archive at all. */
export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveError";
  }
}

/**
 * Whether a path may appear in a bundle.
 *
 * Deliberately a narrow allowlist rather than a list of forbidden shapes: the
 * bundle mints every path it writes from a hash or a fixed constant, so
 * anything outside `[A-Za-z0-9._-]` segments is already not ours. That closes
 * traversal (`..`), absolute paths, empty and repeated separators, backslashes
 * a Windows reader would treat as separators, NUL truncation tricks, and the
 * `.` segment in one rule instead of six.
 */
export function isSafeArchivePath(path: string): boolean {
  if (path.length === 0 || path.length > MAX_PATH_LENGTH) return false;
  if (!/^[A-Za-z0-9._\-/]+$/.test(path)) return false;
  const segments = path.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function buildHeader(entry: ArchiveEntry): Buffer {
  const header = Buffer.alloc(TAR_BLOCK_SIZE);
  header.write(entry.path, 0, MAX_PATH_LENGTH, "utf8");
  header.write(octal(0o644, 8), 100, "utf8");
  header.write(octal(0, 8), 108, "utf8");
  header.write(octal(0, 8), 116, "utf8");
  header.write(octal(entry.bytes.length, 12), 124, "utf8");
  // A fixed mtime, not the clock: two bundles of the same profile should
  // differ only where the manifest says they differ.
  header.write(octal(0, 12), 136, "utf8");
  header.write("0", 156, "utf8");
  header.write("ustar\0", 257, "utf8");
  header.write("00", 263, "utf8");
  // The checksum is computed with its own field read as spaces, then written
  // back over it — the ustar rule.
  header.fill(" ", 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "utf8");
  return header;
}

function padding(size: number): number {
  const remainder = size % TAR_BLOCK_SIZE;
  return remainder === 0 ? 0 : TAR_BLOCK_SIZE - remainder;
}

/**
 * Packs entries into a gzipped ustar archive, in the order given.
 *
 * The writer applies the same path and duplicate rules the reader enforces, so
 * a bundle Volli produced can never be one Volli refuses to open.
 */
export function packArchive(entries: readonly ArchiveEntry[]): Buffer {
  const seen = new Set<string>();
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    if (!isSafeArchivePath(entry.path)) {
      throw new ArchiveError(`Archive entry has an unsafe path: ${JSON.stringify(entry.path)}`);
    }
    if (seen.has(entry.path)) {
      throw new ArchiveError(`Archive entry is a duplicate: ${entry.path}`);
    }
    seen.add(entry.path);
    blocks.push(buildHeader(entry), entry.bytes, Buffer.alloc(padding(entry.bytes.length)));
  }
  // Two zero blocks close a tar stream.
  blocks.push(Buffer.alloc(TAR_BLOCK_SIZE * 2));
  return gzipSync(Buffer.concat(blocks), { level: 9 });
}

function readString(block: Buffer, offset: number, length: number): string {
  const field = block.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
}

function readOctal(block: Buffer, offset: number, length: number, field: string): number {
  const raw = readString(block, offset, length).trim();
  if (raw.length === 0) return 0;
  if (!/^[0-7]+$/.test(raw)) throw new ArchiveError(`Archive header has a malformed ${field}`);
  return Number.parseInt(raw, 8);
}

function verifyChecksum(block: Buffer): void {
  const stored = readOctal(block, 148, 8, "checksum");
  let signed = 0;
  let unsigned = 0;
  for (let index = 0; index < TAR_BLOCK_SIZE; index += 1) {
    const byte = index >= 148 && index < 156 ? 0x20 : (block[index] ?? 0);
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  if (stored !== unsigned && stored !== signed) {
    throw new ArchiveError("Archive header failed its checksum");
  }
}

/**
 * Reads a gzipped ustar archive into its entries.
 *
 * Total: any structural surprise throws rather than yielding the entries it
 * managed to parse, because a partial archive read by a restore is a restore
 * that silently loses whatever came after the damage.
 */
export function unpackArchive(bytes: Buffer): ArchiveEntry[] {
  let tar: Buffer;
  try {
    tar = gunzipSync(bytes);
  } catch {
    throw new ArchiveError("Bundle is not a gzip archive");
  }
  if (tar.length === 0 || tar.length % TAR_BLOCK_SIZE !== 0) {
    throw new ArchiveError("Archive is truncated: length is not a whole number of blocks");
  }

  const entries: ArchiveEntry[] = [];
  const seen = new Set<string>();
  let offset = 0;
  while (offset + TAR_BLOCK_SIZE <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) break;
    verifyChecksum(header);
    const magic = readString(header, 257, 6);
    if (magic !== "ustar" && magic !== "ustar  ") {
      throw new ArchiveError("Archive entry is not in ustar format");
    }
    const typeFlag = readString(header, 156, 1);
    if (typeFlag !== "" && typeFlag !== "0") {
      throw new ArchiveError(
        `Archive holds a ${typeFlag === "5" ? "directory" : `type ${typeFlag}`} entry; only regular files are allowed`,
      );
    }
    if (readString(header, 345, 155).length > 0) {
      throw new ArchiveError("Archive entry uses a split ustar path prefix");
    }
    const path = readString(header, 0, MAX_PATH_LENGTH);
    if (!isSafeArchivePath(path)) {
      throw new ArchiveError(`Archive entry has an unsafe path: ${JSON.stringify(path)}`);
    }
    if (seen.has(path)) throw new ArchiveError(`Archive entry is a duplicate: ${path}`);
    seen.add(path);

    const size = readOctal(header, 124, 12, "size");
    const start = offset + TAR_BLOCK_SIZE;
    const end = start + size;
    if (end > tar.length) throw new ArchiveError(`Archive is truncated inside ${path}`);
    entries.push({ path, bytes: Buffer.from(tar.subarray(start, end)) });
    offset = end + padding(size);
  }
  if (entries.length === 0) throw new ArchiveError("Archive holds no entries");
  return entries;
}
