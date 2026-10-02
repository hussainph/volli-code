import { uuidv7 } from "@earendil-works/pi-ai";
import type { Context } from "../../context";
import type { FileSystem } from "../../types";
import { insertUsage } from "../commit";
import { type CommittedWrite, InMemoryStorageState } from "../in-memory-storage-state";
import type {
  CommitResult,
  Entry,
  EntryScan,
  EntryStructure,
  SessionStats,
  Storage,
  StorageBranchScan,
  UsageRow,
  UsageScan,
  Write,
} from "../types";
import type { ListElement, ListReadOptions, StoredValue, Value, ValueList } from "../values";
import {
  fileValue,
  parseJsonlTransaction,
  publishFileAtomically,
  publishJsonl,
  readJsonlHeader,
  serializeJsonlTransaction,
} from "./io";
import { LegacyV3Source } from "./legacy-v3";
import { JSONL_STORAGE_VERSION, type JsonlStorageHeader, type JsonlStorageOptions } from "./types";

const NEWLINE = 0x0a;
/** Bytes of complete lines decoded at a time; each batch ends on a newline. */
const REPLAY_DECODE_BATCH_BYTES = 256 * 1024;
/** Longest stretch of replay work between two yields to the event loop. */
const REPLAY_SLICE_MS = 8;

/** Let queued timers, I/O and IPC run between replay slices. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) =>
    typeof setImmediate === "function" ? setImmediate(resolve) : setTimeout(resolve, 0),
  );
}

/**
 * Visit every complete UTF-8 JSONL line in order, in time-bounded slices.
 *
 * A newline byte never occurs inside a UTF-8 sequence, so decoding newline-terminated
 * batches yields the same text as whole-file decoding. `ignoreBOM` preserves a leading
 * U+FEFF. The synchronous visitor's work counts toward the slice; a throw rejects.
 * Folded from Volli's pi-agent-core@0.99.2 storage.js patch (VC-462).
 */
async function forEachCompleteLineInSlices(
  bytes: Uint8Array,
  completeLength: number,
  visit: (line: string) => void,
): Promise<void> {
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  let sliceStart = performance.now();
  for (let start = 0; start < completeLength;) {
    const end =
      bytes.indexOf(NEWLINE, Math.min(start + REPLAY_DECODE_BATCH_BYTES, completeLength) - 1) + 1;
    const lines = decoder.decode(bytes.subarray(start, end)).split("\n");
    lines.pop();
    start = end;
    for (const line of lines) {
      visit(line);
      if (performance.now() - sliceStart >= REPLAY_SLICE_MS) {
        await yieldToEventLoop();
        sliceStart = performance.now();
      }
    }
  }
}

type JsonlBacking = { kind: "v4" } | { kind: "v3"; source: LegacyV3Source };

/** JSONL storage backed by an injected filesystem capability. */
export class JsonlStorage implements Storage {
  private readonly fileSystem: FileSystem;
  private readonly path: string;
  private readonly now: () => number;
  readonly header: JsonlStorageHeader;
  private backing: JsonlBacking;
  private readonly storageState = new InMemoryStorageState();
  private commitQueue: Promise<void> = Promise.resolve();
  private state: "open" | "closing" | "closed" = "open";
  private closePromise: Promise<void> | undefined;

  private constructor(
    options: JsonlStorageOptions,
    header: JsonlStorageHeader,
    backing: JsonlBacking,
  ) {
    this.fileSystem = options.fileSystem;
    this.path = options.path;
    this.now = options.now ?? Date.now;
    this.header = header;
    this.backing = backing;
  }

  static async create(
    options: JsonlStorageOptions,
    header: JsonlStorageHeader,
    initialWrites: Write[],
    context: Context,
  ): Promise<JsonlStorage> {
    const storage = new JsonlStorage(options, header, { kind: "v4" });
    const prepared = storage.storageState.prepareCommit(initialWrites, storage.now());
    await publishJsonl(options.fileSystem, options.path, header, context, async (append) => {
      if (prepared.writes.length !== 0) await append(prepared.writes);
    });
    storage.storageState.applyValidated(prepared.writes);
    return storage;
  }

  static async open(options: JsonlStorageOptions, context: Context): Promise<JsonlStorage> {
    const reader = fileValue(
      await options.fileSystem.openTextLineReader(options.path, context),
      `Failed to read JSONL storage ${options.path}`,
    );
    const parsed = await readJsonlHeader(reader, options.path, context).finally(() =>
      reader.close(context),
    );
    return parsed.format === "v3-legacy"
      ? JsonlStorage.openLegacyV3(options, context)
      : JsonlStorage.openV4(options, parsed.header, context);
  }

  private static async openV4(
    options: JsonlStorageOptions,
    header: JsonlStorageHeader,
    context: Context,
  ): Promise<JsonlStorage> {
    const bytes = fileValue(
      await options.fileSystem.readBinaryFile(options.path, context),
      `Failed to read JSONL storage ${options.path}`,
    );
    // Everything after the last newline is a torn tail from an interrupted append.
    const completeLength = bytes.lastIndexOf(NEWLINE) + 1;
    const torn = bytes[bytes.length - 1] !== NEWLINE;
    if (header.storageVersion !== JSONL_STORAGE_VERSION) {
      throw new Error(
        `Session ${header.id} uses unsupported storage version ${header.storageVersion}`,
      );
    }
    const storage = new JsonlStorage(options, header, { kind: "v4" });
    // Keep decoded lines only when a torn file needs rewriting without its tail.
    const lines: string[] | undefined = torn ? [] : undefined;
    let lineNumber = 0;
    await forEachCompleteLineInSlices(bytes, completeLength, (line) => {
      lineNumber++;
      lines?.push(line);
      // Line 1 is the header, already parsed by `open`.
      if (lineNumber === 1) return;
      try {
        storage.replayCommitted(parseJsonlTransaction(line));
      } catch (error) {
        throw new Error(`Invalid JSONL storage ${options.path}: line ${lineNumber}`, {
          cause: error,
        });
      }
    });
    if (header.nextSeq !== undefined) storage.storageState.advanceNextSeq(header.nextSeq);
    if (lines !== undefined) {
      await publishFileAtomically(options.fileSystem, options.path, context, (append) =>
        append(`${lines.join("\n")}\n`),
      );
    }
    return storage;
  }

  private static async openLegacyV3(
    options: JsonlStorageOptions,
    context: Context,
  ): Promise<JsonlStorage> {
    const source = await LegacyV3Source.read(options.fileSystem, options.path, context);
    const storage = new JsonlStorage(
      options,
      { ...source.header, nextSeq: source.nextSeq },
      { kind: "v3", source },
    );
    for await (const write of source.writes(context)) storage.replayCommitted([write]);
    return storage;
  }

  private replayCommitted(writes: readonly CommittedWrite[]): void {
    this.storageState.validateCommitted(writes);
    this.storageState.applyValidated(writes);
  }

  async commit(writes: Write[], context: Context): Promise<CommitResult> {
    if (this.state !== "open") throw new Error("JsonlStorage is closed");
    const result = this.commitQueue.then(() => this.applyCommit(writes, context));
    this.commitQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async applyCommit(writes: Write[], context: Context): Promise<CommitResult> {
    if (this.backing.kind === "v3" && writes.length !== 0) {
      return this.upgradeLegacyV3ToV4(this.backing.source, writes, context);
    }
    const prepared = this.storageState.prepareCommit(writes, this.now());
    if (prepared.writes.length !== 0) {
      fileValue(
        await this.fileSystem.appendFile(
          this.path,
          `${serializeJsonlTransaction(prepared.writes)}\n`,
          context,
        ),
        `Failed to append JSONL storage ${this.path}`,
      );
    }
    const stats = this.storageState.applyValidated(prepared.writes);
    return { ...prepared.result, stats: this.withImportedUsage(stats) };
  }

  /** Atomically upgrade legacy v3 backing and preserve the first caller write as a v4 transaction. */
  private async upgradeLegacyV3ToV4(
    source: LegacyV3Source,
    callerWrites: Write[],
    context: Context,
  ): Promise<CommitResult> {
    const timestamp = this.now();
    const prepared = this.storageState.prepareCommit(
      [
        insertUsage({
          id: uuidv7(timestamp),
          usage: source.importedUsage,
          adjustment: true,
          details: { source: "v3-import" },
        }),
        ...callerWrites,
      ],
      timestamp,
    );

    const nextSeq = prepared.result.firstSeq + prepared.writes.length;
    const upgradedHeader = { ...this.header, nextSeq };
    await publishJsonl(this.fileSystem, this.path, upgradedHeader, context, async (append) => {
      for await (const write of source.writes(context)) await append([write]);
      await append(prepared.writes);
    });

    const stats = this.storageState.applyValidated(prepared.writes);
    this.backing = { kind: "v4" };
    // The first sequence belongs to the internal usage adjustment; return only caller-write sequences.
    return {
      ...prepared.result,
      firstSeq: prepared.result.firstSeq + 1,
      seqs: prepared.result.seqs.slice(1),
      stats,
    };
  }

  getEntries(ids: string[], _context: Context): Promise<Map<string, Entry>> {
    if (this.state !== "open") return Promise.reject(new Error("JsonlStorage is closed"));
    return Promise.resolve(this.storageState.getEntries(ids));
  }

  getValue<T>(address: Value<T>, _context: Context): Promise<StoredValue<T> | undefined> {
    if (this.state !== "open") return Promise.reject(new Error("JsonlStorage is closed"));
    return Promise.resolve(this.storageState.getValue(address));
  }

  scanValues<T>(prefix: Value<T>, _context: Context): Promise<StoredValue<T>[]> {
    if (this.state !== "open") return Promise.reject(new Error("JsonlStorage is closed"));
    return Promise.resolve(this.storageState.scanValues(prefix));
  }

  async readList<T>(
    address: ValueList<T>,
    options: ListReadOptions | undefined,
    _context: Context,
  ): Promise<ListElement<T>[]> {
    if (this.state !== "open") throw new Error("JsonlStorage is closed");
    return this.storageState.readList(address, options);
  }

  async scanBranch(query: StorageBranchScan, _context: Context): Promise<Entry[]> {
    if (this.state !== "open") throw new Error("JsonlStorage is closed");
    return this.storageState.scanBranch(query);
  }

  async scanBranchStructure(
    query: StorageBranchScan,
    _context: Context,
  ): Promise<EntryStructure[]> {
    if (this.state !== "open") throw new Error("JsonlStorage is closed");
    return this.storageState.scanBranchStructure(query);
  }

  scanEntries(query: EntryScan, _context: Context): Promise<Entry[]> {
    if (this.state !== "open") return Promise.reject(new Error("JsonlStorage is closed"));
    return Promise.resolve(this.storageState.scanEntries(query));
  }

  scanUsage(query: UsageScan, _context: Context): Promise<UsageRow[]> {
    if (this.state !== "open") return Promise.reject(new Error("JsonlStorage is closed"));
    return Promise.resolve(this.storageState.scanUsage(query));
  }

  getStats(_context: Context): Promise<SessionStats> {
    if (this.state !== "open") return Promise.reject(new Error("JsonlStorage is closed"));
    return Promise.resolve(this.withImportedUsage(this.storageState.getStats()));
  }

  private withImportedUsage(stats: SessionStats): SessionStats {
    return this.backing.kind === "v4"
      ? stats
      : { ...stats, usage: this.backing.source.importedUsage };
  }

  isLegacyV3(): boolean {
    return this.backing.kind === "v3";
  }

  /** Capture the first sequence a later source commit would use. */
  captureForkNextSeq(_context: Context): Promise<number> {
    if (this.state !== "open") return Promise.reject(new Error("JsonlStorage is closed"));
    const result = this.commitQueue.then(() => this.storageState.getNextSeq());
    this.commitQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  close(_context: Context): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.state = "closing";
    this.closePromise = this.commitQueue.then(() => {
      this.state = "closed";
    });
    return this.closePromise;
  }
}
