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

/**
 * The ustar header block for one entry.
 *
 * Exported for the bounded-memory writer (`streaming.ts`), which emits a
 * header and then streams a body whose size it learned from its inventory —
 * the buffer writer below is one caller, not the only one. A size that does
 * not match the bytes actually written is caught by the streaming reader's
 * block accounting and by the manifest hash, never by trusting this field.
 */
export function buildTarHeader(path: string, sizeBytes: number): Buffer {
  if (!isSafeArchivePath(path)) {
    throw new ArchiveError(`Archive entry has an unsafe path: ${JSON.stringify(path)}`);
  }
  // ustar's size field holds eleven octal digits; a larger body has no honest
  // representation here, and truncating the written field would produce an
  // archive whose blocks disagree with its headers.
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > 0o77777777777) {
    throw new ArchiveError(`Archive entry ${path} is too large for a ustar header`);
  }
  const header = Buffer.alloc(TAR_BLOCK_SIZE);
  header.write(path, 0, MAX_PATH_LENGTH, "utf8");
  header.write(octal(0o644, 8), 100, "utf8");
  header.write(octal(0, 8), 108, "utf8");
  header.write(octal(0, 8), 116, "utf8");
  header.write(octal(sizeBytes, 12), 124, "utf8");
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

/** Bytes of zero padding a tar body of this size is followed by. */
export function tarPadding(size: number): number {
  return padding(size);
}

/** The two zero blocks every tar stream ends with. */
export function tarEndBlocks(): Buffer {
  return Buffer.alloc(TAR_BLOCK_SIZE * 2);
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
    blocks.push(buildTarHeader(entry.path, entry.bytes.length), entry.bytes);
    if (padding(entry.bytes.length) > 0) blocks.push(Buffer.alloc(padding(entry.bytes.length)));
  }
  // Two zero blocks close a tar stream.
  blocks.push(tarEndBlocks());
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

/**
 * Validates one ustar header block and reads what it claims.
 *
 * Shared by the buffer reader and the streaming reader so the two can never
 * disagree about which headers are acceptable: checksum, magic, type flag,
 * the refused split prefix, path safety and the size field are checked here
 * once, in the reader's order.
 */
function parseTarHeader(header: Buffer): { path: string; size: number } {
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
  return { path, size: readOctal(header, 124, 12, "size") };
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
 * Refuses an archive that does not END: tar's two zero blocks are part of the
 * stream, not optional padding.
 *
 * A stream cut at an entry boundary used to look complete to this module, and
 * a bundle missing its last entries would then verify as far as it went. A
 * file that ends after one zero block, or holds anything but zero blocks
 * after the two, is damage rather than a shorter archive.
 */
function assertEndOfArchive(tar: Buffer, offset: number): void {
  const markerEnd = offset + TAR_BLOCK_SIZE * 2;
  if (markerEnd > tar.length) {
    throw new ArchiveError("Archive is truncated: its end-of-archive marker is incomplete");
  }
  for (let index = offset; index < markerEnd; index += 1) {
    if (tar[index] !== 0) {
      throw new ArchiveError("Archive is truncated: its end-of-archive marker is incomplete");
    }
  }
  for (let index = markerEnd; index < tar.length; index += 1) {
    if (tar[index] !== 0) {
      throw new ArchiveError("Archive holds data after its end-of-archive marker");
    }
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
  let ended = false;
  let offset = 0;
  while (offset + TAR_BLOCK_SIZE <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) {
      assertEndOfArchive(tar, offset);
      ended = true;
      break;
    }
    const { path, size } = parseTarHeader(header);
    if (seen.has(path)) throw new ArchiveError(`Archive entry is a duplicate: ${path}`);
    seen.add(path);

    const start = offset + TAR_BLOCK_SIZE;
    const end = start + size;
    if (end > tar.length) throw new ArchiveError(`Archive is truncated inside ${path}`);
    entries.push({ path, bytes: Buffer.from(tar.subarray(start, end)) });
    offset = end + padding(size);
  }
  if (!ended) throw new ArchiveError("Archive is truncated: it has no end-of-archive marker");
  if (entries.length === 0) throw new ArchiveError("Archive holds no entries");
  return entries;
}

/** One entry handed out by {@link ArchiveStreamReader}. */
export interface ArchiveStreamEntry {
  readonly path: string;
  readonly size: number;
  /**
   * The next body chunk, or `null` once the body and its padding are consumed.
   *
   * Chunks are views into a decompression buffer and are never larger than the
   * entry; a caller must not retain one past the next `read()` if it wants the
   * archive layer's bounded memory to be its own. Reading past the entry is
   * refused rather than silently returning the next entry's bytes.
   */
  read(): Promise<Buffer | null>;
}

/**
 * Where an archive reader remembers the paths it has already handed out.
 *
 * Duplicate paths are a container-level refusal, so the reader must know every
 * path it has seen. A `Set` is right for a bundle in memory; a streaming
 * verifier of a profile with hundreds of thousands of transcripts injects a
 * disk-backed registry instead, keeping RSS independent of the file count.
 */
export interface ArchivePathRegistry {
  /** Records `path`; returns `false` when it was already present. */
  add(path: string): boolean;
}

/** The default registry: paths in a `Set`, bounded by the entry count. */
export function inMemoryArchivePaths(): ArchivePathRegistry {
  const seen = new Set<string>();
  return {
    add(path: string): boolean {
      if (seen.has(path)) return false;
      seen.add(path);
      return true;
    },
  };
}

function asBuffer(chunk: Uint8Array): Buffer {
  return Buffer.isBuffer(chunk)
    ? chunk
    : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

/**
 * Reads a gzipped ustar stream one entry at a time, with the same rules
 * {@link unpackArchive} enforces and no whole-archive buffer.
 *
 * A backup of a large profile cannot be gunzipped into memory just to hash it,
 * so the strict container checks live here too — and the two readers share
 * {@link parseTarHeader} and the end-marker rule, which is what keeps the
 * streaming path from being a weaker verifier than the buffer path. Beyond one
 * header-sized buffer, its only state is the path registry — a `Set` by
 * default, or a verifier's disk-backed one — so its memory is bounded by
 * neither the archive's bytes nor, when injected, its file count.
 *
 * The source is any async byte stream (a gunzipped file). Errors from it — a
 * failed gzip stream — propagate unchanged; the caller names them.
 */
export class ArchiveStreamReader {
  readonly #source: AsyncIterator<Uint8Array>;
  readonly #paths: ArchivePathRegistry;
  #buffer: Buffer = Buffer.alloc(0);
  #ended = false;
  #body: { path: string; remaining: number; padding: number } | undefined;
  /** Bytes of an abandoned entry still to be skipped before the next header. */
  #pendingSkip = 0;

  constructor(
    source: AsyncIterable<Uint8Array>,
    paths: ArchivePathRegistry = inMemoryArchivePaths(),
  ) {
    this.#source = source[Symbol.asyncIterator]();
    this.#paths = paths;
  }

  /** The next entry, or `null` once the end marker and every trailing zero block have been read. */
  async nextEntry(): Promise<ArchiveStreamEntry | null> {
    await this.#skipAbandonedBody();
    if (this.#ended) return null;
    const header = await this.#take(TAR_BLOCK_SIZE, "it has no end-of-archive marker");
    if (header.every((byte) => byte === 0)) {
      await this.#finish();
      return null;
    }
    const { path, size } = parseTarHeader(header);
    if (!this.#paths.add(path)) {
      throw new ArchiveError(`Archive entry is a duplicate: ${path}`);
    }
    this.#body = { path, remaining: size, padding: padding(size) };
    return { path, size, read: () => this.#readBody() };
  }

  /**
   * Skips the rest of an entry the caller did not read to its end, so the next
   * header is taken from the right offset. Awaiting it here is what makes
   * abandoning an entry safe; the bytes still pass through the stream and are
   * checked for truncation like any other body byte.
   */
  async #skipAbandonedBody(): Promise<void> {
    const body = this.#body;
    if (body !== undefined) {
      this.#body = undefined;
      this.#pendingSkip = body.remaining + body.padding;
    }
    if (this.#pendingSkip === 0) return;
    const bytes = this.#pendingSkip;
    this.#pendingSkip = 0;
    await this.#discard(bytes, "inside an entry");
  }

  async #readBody(): Promise<Buffer | null> {
    const body = this.#body;
    if (body === undefined) return null;
    if (body.remaining === 0) {
      await this.#discard(body.padding, `inside ${body.path}`);
      this.#body = undefined;
      return null;
    }
    if (!(await this.#fill(1))) throw new ArchiveError(`Archive is truncated inside ${body.path}`);
    const size = Math.min(body.remaining, this.#buffer.length);
    const chunk = this.#buffer.subarray(0, size);
    this.#buffer = this.#buffer.subarray(size);
    body.remaining -= size;
    if (body.remaining === 0) {
      await this.#discard(body.padding, `inside ${body.path}`);
      this.#body = undefined;
    }
    return chunk;
  }

  async #finish(): Promise<void> {
    const second = await this.#take(TAR_BLOCK_SIZE, "its end-of-archive marker is incomplete");
    if (!second.every((byte) => byte === 0)) {
      throw new ArchiveError("Archive is truncated: its end-of-archive marker is incomplete");
    }
    for (;;) {
      if (this.#buffer.length > 0) {
        if (!this.#buffer.every((byte) => byte === 0)) {
          throw new ArchiveError("Archive holds data after its end-of-archive marker");
        }
        this.#buffer = Buffer.alloc(0);
      }
      const next = await this.#source.next();
      if (next.done) break;
      this.#buffer = asBuffer(next.value);
    }
    this.#ended = true;
  }

  async #fill(size: number): Promise<boolean> {
    while (this.#buffer.length < size) {
      const next = await this.#source.next();
      if (next.done) return false;
      const chunk = asBuffer(next.value);
      if (chunk.length === 0) continue;
      this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    }
    return true;
  }

  async #take(size: number, truncated: string): Promise<Buffer> {
    if (!(await this.#fill(size))) {
      throw new ArchiveError(`Archive is truncated: ${truncated}`);
    }
    const taken = this.#buffer.subarray(0, size);
    this.#buffer = this.#buffer.subarray(size);
    return taken;
  }

  async #discard(size: number, context: string): Promise<void> {
    let left = size;
    while (left > 0) {
      if (this.#buffer.length === 0) {
        const next = await this.#source.next();
        if (next.done) throw new ArchiveError(`Archive is truncated ${context}`);
        this.#buffer = asBuffer(next.value);
        continue;
      }
      const step = Math.min(left, this.#buffer.length);
      this.#buffer = this.#buffer.subarray(step);
      left -= step;
    }
  }
}
