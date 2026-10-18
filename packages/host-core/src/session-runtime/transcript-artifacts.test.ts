import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { renameSync, symlinkSync } from "node:fs";
import { lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzip, gzip } from "node:zlib";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { canonicalJson, type SessionTranscriptArtifact } from "@volli/session-engine";

import {
  createFileTranscriptArtifactStore,
  FileTranscriptArtifactStore,
  repackLegacyTranscriptArtifacts,
} from "./transcript-artifacts";

/**
 * CodeQL #23/#24: the read used to `lstat` a path and then `readFile` it, so the
 * path could be swapped for a symlink between the check and the use. These
 * seams let a test do exactly that swap at the worst moment — right after the
 * store's FIRST filesystem touch of the artifact path, whichever call that is —
 * without assuming which call the store makes. A read that checks and reads one
 * open file is unaffected by the swap; a read that re-resolves the path is not.
 */
const race = vi.hoisted(() => ({
  target: undefined as string | undefined,
  swap: undefined as (() => void) | undefined,
  touched(path: unknown): void {
    if (path !== race.target || race.swap === undefined) return;
    const swap = race.swap;
    race.swap = undefined;
    swap();
  },
}));

/**
 * VC-465: what a crash would keep, recorded from the store's own syncs and
 * links. A name survives a crash at some instant if a directory sync that
 * STARTED after its link had FINISHED by then, and its bytes are intact if
 * the file was synced before the link. The gates let a test hold or fail a
 * sync, so a crash can be judged in the middle of a batch.
 */
const disk = vi.hoisted(() => ({
  clock: 0,
  /** Temporary files whose sync finished, with the instant it did. */
  fileSynced: new Map<string, number>(),
  links: [] as Array<{ source: string; name: string; at: number }>,
  directorySyncs: [] as Array<{ startedAt: number; endedAt?: number; ok?: boolean }>,
  /** Paths the store opened for reading, in order. */
  reads: [] as string[],
  /** Runs before directory sync `index` touches the disk; a rejection is that sync's failure. */
  directoryGate: undefined as ((index: number) => Promise<void>) | undefined,
  /** An error here fails that temporary file's sync instead of performing it. */
  fileSyncFault: undefined as ((path: string) => Error | undefined) | undefined,
  reset(): void {
    disk.clock = 0;
    disk.fileSynced.clear();
    disk.links.length = 0;
    disk.directorySyncs.length = 0;
    disk.reads.length = 0;
    disk.directoryGate = undefined;
    disk.fileSyncFault = undefined;
  },
  /** The store opens its directory `"r"` to sync it and a temporary file `"wx"`. */
  watch(handle: { sync(): Promise<void> }, path: string, flags: unknown): void {
    const sync = handle.sync.bind(handle);
    if (flags === "r") {
      handle.sync = async () => {
        const record: { startedAt: number; endedAt?: number; ok?: boolean } = {
          startedAt: ++disk.clock,
        };
        const index = disk.directorySyncs.push(record) - 1;
        try {
          await disk.directoryGate?.(index);
          await sync();
          record.ok = true;
        } catch (error) {
          record.ok = false;
          throw error;
        } finally {
          record.endedAt = ++disk.clock;
        }
      };
    } else if (flags === "wx") {
      handle.sync = async () => {
        const fault = disk.fileSyncFault?.(path);
        if (fault) throw fault;
        await sync();
        disk.fileSynced.set(path, ++disk.clock);
      };
    } else {
      disk.reads.push(path);
    }
  },
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const info = await actual.lstat(...args);
      race.touched(args[0]);
      return info;
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      race.touched(args[0]);
      disk.watch(handle, String(args[0]), args[1]);
      return handle;
    },
    link: async (...args: Parameters<typeof actual.link>) => {
      await actual.link(...args);
      disk.links.push({ source: String(args[0]), name: String(args[1]), at: ++disk.clock });
    },
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const lstatSync = ((...args: Parameters<typeof actual.lstatSync>) => {
    const info = actual.lstatSync(...args);
    race.touched(args[0]);
    return info;
  }) as typeof actual.lstatSync;
  const openSync = (...args: Parameters<typeof actual.openSync>) => {
    const fd = actual.openSync(...args);
    race.touched(args[0]);
    return fd;
  };
  return { ...actual, lstatSync, openSync };
});

const gunzipAsync = promisify(gunzip);
const gzipAsync = promisify(gzip);

let directory: string | undefined;

afterEach(async () => {
  race.target = undefined;
  race.swap = undefined;
  disk.reset();
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

function artifact(text = "Hello"): SessionTranscriptArtifact {
  return {
    version: 1,
    threadId: "thread-1",
    branchId: "branch-1",
    attemptId: "attempt-1",
    turnId: null,
    message: { id: "message-1", role: "assistant", parts: [{ type: "text", text }] },
  };
}

async function store() {
  directory = await mkdtemp(join(tmpdir(), "volli-transcript-artifacts-"));
  return createFileTranscriptArtifactStore(directory);
}

function canonicalBytes(value: SessionTranscriptArtifact): Buffer {
  return Buffer.from(canonicalJson(value), "utf8");
}

function referenceFor(value: SessionTranscriptArtifact) {
  const bytes = canonicalBytes(value);
  const digest = createHash("sha256").update(bytes).digest("hex");
  return {
    bytes,
    reference: {
      id: `sha256:${digest}`,
      digest: `sha256:${digest}`,
      mediaType: "application/vnd.volli.ui-message+json",
    },
  } as const;
}

/** The compressed name an artifact is published under. */
function compressedName(reference: { id: string }): string {
  return join(directory!, `${reference.id.slice("sha256:".length)}.json.gz`);
}

/** Whether a crash at `instant` would keep `name`, with its bytes intact. */
function survivesCrash(name: string, instant: number): boolean {
  return disk.links.some(
    (link) =>
      link.name === name &&
      (disk.fileSynced.get(link.source) ?? Infinity) < link.at &&
      disk.directorySyncs.some(
        (sync) => sync.ok === true && sync.startedAt > link.at && sync.endedAt! <= instant,
      ),
  );
}

/** A name an earlier process linked, its bytes synced and its directory sync not known to have run. */
function leftByEarlierProcess(name: string): void {
  disk.fileSynced.set(name, ++disk.clock);
  disk.links.push({ source: name, name, at: ++disk.clock });
}

/**
 * A stand-in for the ledger: it commits a reference the moment the store
 * returns it, which is what the Session runtime does with a transcript
 * artifact, and remembers the instant so a crash can be judged then.
 */
function ledger() {
  const commits: Array<{ name: string; at: number }> = [];
  return {
    commits,
    commit<Reference extends { id: string }>(write: Promise<Reference>): Promise<Reference> {
      return write.then((reference) => {
        commits.push({ name: compressedName(reference), at: ++disk.clock });
        return reference;
      });
    },
    /** Every committed reference names an artifact a crash right after the commit keeps. */
    expectEveryCommitSurvivesACrash() {
      for (const { name, at } of commits) expect(survivesCrash(name, at), name).toBe(true);
    },
  };
}

/** Hold directory syncs by index until a test releases them, resolving or failing each. */
function holdDirectorySyncs() {
  const held = new Map<number, PromiseWithResolvers<void>>();
  const gate = (index: number) => {
    const waiter = held.get(index) ?? Promise.withResolvers<void>();
    held.set(index, waiter);
    return waiter.promise;
  };
  disk.directoryGate = gate;
  return {
    release(index: number, error?: Error) {
      const waiter = held.get(index) ?? Promise.withResolvers<void>();
      held.set(index, waiter);
      if (error) waiter.reject(error);
      else waiter.resolve();
    },
  };
}

function settled<T>(promise: Promise<T>) {
  const state = { done: false };
  promise.then(
    () => (state.done = true),
    () => (state.done = true),
  );
  return state;
}

const SLOW_DISK = { timeout: 15_000 };

describe("FileTranscriptArtifactStore group-committed directory syncs (VC-465)", () => {
  it("publishes concurrent artifacts behind one shared directory sync, and none before it", async () => {
    const artifacts = await store();
    const syncs = holdDirectorySyncs();
    const book = ledger();
    const first = book.commit(artifacts.write(artifact("first")));
    await vi.waitFor(() => expect(disk.directorySyncs).toHaveLength(1), SLOW_DISK);

    // While the first sync runs, seven more publications link and queue.
    const batch = Array.from({ length: 7 }, (_, index) =>
      book.commit(artifacts.write(artifact(`batch ${index}`))),
    );
    const batchSettled = batch.map(settled);
    await vi.waitFor(() => expect(disk.links).toHaveLength(8), SLOW_DISK);
    await new Promise((resolve) => setImmediate(resolve));
    expect(disk.directorySyncs).toHaveLength(1);
    expect(book.commits).toEqual([]);

    syncs.release(0);
    await first;
    await vi.waitFor(() => expect(disk.directorySyncs).toHaveLength(2), SLOW_DISK);

    // A crash in the middle of the batch: its one sync has started, not finished.
    expect(batchSettled.some((state) => state.done)).toBe(false);
    expect(book.commits).toHaveLength(1);
    book.expectEveryCommitSurvivesACrash();
    const batchNames = disk.links.slice(1).map((link) => link.name);
    for (const name of batchNames) expect(survivesCrash(name, disk.clock)).toBe(false);

    syncs.release(1);
    await Promise.all(batch);
    // Two directory syncs for eight artifacts, where each used to pay its own.
    expect(disk.directorySyncs).toHaveLength(2);
    expect(disk.fileSynced.size).toBe(8);
    expect(book.commits).toHaveLength(8);
    book.expectEveryCommitSurvivesACrash();
  });

  it("rejects every publication in a batch whose directory sync fails, and commits none of them", async () => {
    const artifacts = await store();
    const syncs = holdDirectorySyncs();
    const book = ledger();
    const first = book.commit(artifacts.write(artifact("first")));
    await vi.waitFor(() => expect(disk.directorySyncs).toHaveLength(1), SLOW_DISK);
    const values = Array.from({ length: 5 }, (_, index) => artifact(`doomed ${index}`));
    const batch = values.map((value) => book.commit(artifacts.write(value)));
    const outcomes = Promise.allSettled(batch);
    await vi.waitFor(() => expect(disk.links).toHaveLength(6), SLOW_DISK);
    await new Promise((resolve) => setImmediate(resolve));

    syncs.release(0);
    await first;
    await vi.waitFor(() => expect(disk.directorySyncs).toHaveLength(2), SLOW_DISK);
    const fault = Object.assign(new Error("injected directory sync failure"), { code: "EIO" });
    syncs.release(1, fault);

    const results = await outcomes;
    expect(results.map((result) => result.status)).toEqual(Array(5).fill("rejected"));
    for (const result of results) expect((result as PromiseRejectedResult).reason).toBe(fault);
    expect(book.commits).toHaveLength(1);
    book.expectEveryCommitSurvivesACrash();

    // Their names are visible but no sync covers them, so a crash may take
    // them back. A retry must sync the directory again before reporting one.
    const doomedNames = values.map((value) => compressedName(referenceFor(value).reference));
    for (const name of doomedNames) {
      expect((await lstat(name)).isFile()).toBe(true);
      expect(survivesCrash(name, disk.clock)).toBe(false);
    }
    syncs.release(2);
    const retried = await book.commit(artifacts.write(values[0]!));
    expect(compressedName(retried)).toBe(doomedNames[0]);
    expect(disk.directorySyncs).toHaveLength(3);
    book.expectEveryCommitSurvivesACrash();
  });

  it("does not report the bytes another write linked until a directory sync covers them", async () => {
    const artifacts = await store();
    const syncs = holdDirectorySyncs();
    const book = ledger();
    const value = artifact("written twice");
    const name = compressedName(referenceFor(value).reference);
    const publisher = book.commit(artifacts.write(value));
    await vi.waitFor(() => expect(disk.directorySyncs).toHaveLength(1), SLOW_DISK);

    // The second write finds the name already there, before its sync finished.
    const observer = book.commit(artifacts.write(value));
    const observed = settled(observer);
    await vi.waitFor(() => expect(disk.reads).toContain(name), SLOW_DISK);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(observed.done).toBe(false);
    expect(book.commits).toEqual([]);

    syncs.release(0);
    syncs.release(1);
    await Promise.all([publisher, observer]);
    expect(book.commits).toHaveLength(2);
    book.expectEveryCommitSurvivesACrash();

    // Once a sync covered the name, a repeat write costs none.
    const syncsBefore = disk.directorySyncs.length;
    await book.commit(artifacts.write(value));
    expect(disk.directorySyncs).toHaveLength(syncsBefore);
    book.expectEveryCommitSurvivesACrash();
  });

  it("syncs a name an earlier process left once before reporting it, then remembers it", async () => {
    const artifacts = await store();
    const book = ledger();
    const value = artifact("left behind");
    const { bytes, reference } = referenceFor(value);
    const name = compressedName(reference);
    await writeFile(name, await gzipAsync(bytes));
    leftByEarlierProcess(name);

    await book.commit(artifacts.write(value));
    expect(disk.directorySyncs).toHaveLength(1);
    expect(disk.links).toHaveLength(1);
    await book.commit(artifacts.write(value));
    expect(disk.directorySyncs).toHaveLength(1);
    book.expectEveryCommitSurvivesACrash();

    // A legacy plain name is reported the same way, without a compressed copy.
    const legacyValue = artifact("legacy left behind");
    const legacy = referenceFor(legacyValue);
    const legacyName = join(directory!, `${legacy.reference.id.slice("sha256:".length)}.json`);
    await writeFile(legacyName, legacy.bytes);
    await expect(artifacts.write(legacyValue)).resolves.toEqual(legacy.reference);
    expect(disk.directorySyncs).toHaveLength(2);
    await expect(lstat(compressedName(legacy.reference))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a write whose file sync fails before any name points at its bytes", async () => {
    const artifacts = await store();
    const book = ledger();
    const value = artifact("never half-written");
    const fault = Object.assign(new Error("injected file sync failure"), { code: "EIO" });
    disk.fileSyncFault = () => fault;

    await expect(book.commit(artifacts.write(value))).rejects.toBe(fault);
    expect(disk.links).toEqual([]);
    expect(await readdir(directory!)).toEqual([]);

    disk.fileSyncFault = undefined;
    await book.commit(artifacts.write(value));
    expect(book.commits).toHaveLength(1);
    book.expectEveryCommitSurvivesACrash();
  });
});

describe("FileTranscriptArtifactStore", () => {
  it("writes gzip bytes at the canonical digest and reads them back verified", async () => {
    const artifacts = await store();
    const value = artifact("Hello ".repeat(200));
    const reference = await artifacts.write(value);

    expect(reference).toEqual({
      id: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      mediaType: "application/vnd.volli.ui-message+json",
    });
    const name = `${reference.id.slice("sha256:".length)}.json.gz`;
    const packed = await readFile(join(directory!, name));
    expect([...packed.subarray(0, 2)]).toEqual([0x1f, 0x8b]);
    const bytes = await gunzipAsync(packed);
    expect(`sha256:${createHash("sha256").update(bytes).digest("hex")}`).toBe(reference.id);
    expect(packed.length).toBeLessThan(bytes.length);
    await expect(artifacts.read(reference)).resolves.toEqual(value);
  });

  it("reads a verified legacy plain artifact without changing it", async () => {
    const artifacts = await store();
    const value = artifact("legacy");
    const { bytes, reference } = referenceFor(value);
    const path = join(directory!, `${reference.id.slice("sha256:".length)}.json`);
    await writeFile(path, bytes);

    await expect(artifacts.read(reference)).resolves.toEqual(value);
    await expect(readFile(path)).resolves.toEqual(bytes);
  });

  it("fails loudly on a corrupt gzip and never falls back to a valid plain sibling", async () => {
    const artifacts = await store();
    const value = artifact("do not hide corruption");
    const { bytes, reference } = referenceFor(value);
    const digest = reference.id.slice("sha256:".length);
    await writeFile(join(directory!, `${digest}.json`), bytes);
    await writeFile(join(directory!, `${digest}.json.gz`), Buffer.from([0x1f, 0x8b, 0x08]));

    await expect(artifacts.read(reference)).rejects.toThrow();
  });

  // VC-315: a history window is chosen from these sizes before any body is read.
  it("says an artifact's canonical size from its metadata, without reading the body", async () => {
    const artifacts = await store();
    const value = artifact("sized ".repeat(500));
    const reference = await artifacts.write(value);
    const canonical = canonicalBytes(value).length;
    // What it adds to a frame on the wire: the body's JSON, byte for byte.
    expect(canonical).toBe(Buffer.byteLength(JSON.stringify(value)));
    await expect(artifacts.byteLength(reference)).resolves.toBe(canonical);

    const legacyValue = artifact("legacy sized");
    const legacy = referenceFor(legacyValue);
    await writeFile(
      join(directory!, `${legacy.reference.id.slice("sha256:".length)}.json`),
      legacy.bytes,
    );
    await expect(artifacts.byteLength(legacy.reference)).resolves.toBe(legacy.bytes.length);
  });

  it("answers a size even when the body is corrupt, and null when it cannot say", async () => {
    const artifacts = await store();
    const value = artifact("corrupt but sized");
    const reference = await artifacts.write(value);
    const path = join(directory!, `${reference.id.slice("sha256:".length)}.json.gz`);
    const packed = await readFile(path);
    // A damaged body with its trailer intact: unreadable, and still sized.
    packed.fill(0, 10, packed.length - 8);
    await writeFile(path, packed);
    await expect(artifacts.read(reference)).rejects.toThrow();
    const fresh = createFileTranscriptArtifactStore(directory!);
    await expect(fresh.byteLength(reference)).resolves.toBe(canonicalBytes(value).length);

    // Too short to hold a trailer, missing, a symlink, an invalid reference: null.
    await writeFile(path, Buffer.from([0x1f, 0x8b, 0x08]));
    await expect(createFileTranscriptArtifactStore(directory!).byteLength(reference)).resolves.toBe(
      null,
    );
    const missing = referenceFor(artifact("never written")).reference;
    await expect(fresh.byteLength(missing)).resolves.toBe(null);
    const external = join(directory!, "outside.json.gz");
    await writeFile(external, packed);
    await rm(path);
    await symlink(external, path);
    await expect(createFileTranscriptArtifactStore(directory!).byteLength(reference)).resolves.toBe(
      null,
    );
    await expect(
      fresh.byteLength({ id: "sha256:nope", digest: "sha256:nope", mediaType: null }),
    ).resolves.toBe(null);
  });

  it("remembers a size once read: the artifact it names cannot change", async () => {
    const artifacts = await store();
    const value = artifact("remembered");
    const reference = await artifacts.write(value);
    await expect(artifacts.byteLength(reference)).resolves.toBe(canonicalBytes(value).length);
    await rm(join(directory!, `${reference.id.slice("sha256:".length)}.json.gz`));
    await expect(artifacts.byteLength(reference)).resolves.toBe(canonicalBytes(value).length);
  });

  it("deduplicates concurrent identical writes", async () => {
    const artifacts = await store();
    const book = ledger();
    const value = artifact();
    const references = await Promise.all(
      Array.from({ length: 8 }, () => book.commit(artifacts.write(value))),
    );

    expect(new Set(references.map((reference) => reference.id))).toEqual(
      new Set([references[0]!.id]),
    );
    await expect(artifacts.read(references[0]!)).resolves.toEqual(value);
    // A writer that lost the link race reports the winner's name only once it is durable.
    book.expectEveryCommitSurvivesACrash();
  });

  it("retries directory initialization after a transient creation failure", async () => {
    directory = await mkdtemp(join(tmpdir(), "volli-transcript-artifacts-"));
    const blockedDirectory = join(directory, "artifacts");
    await writeFile(blockedDirectory, "not a directory");
    const artifacts = createFileTranscriptArtifactStore(blockedDirectory);

    await expect(artifacts.write(artifact())).rejects.toThrow();
    await rm(blockedDirectory);
    await expect(artifacts.write(artifact())).resolves.toMatchObject({
      id: expect.stringMatching(/^sha256:/),
    });
  });

  it("uses canonical JSON semantics for optional UI message values and arrays", async () => {
    const artifacts = await store();
    const withOptionalValues = {
      version: 1 as const,
      threadId: "thread-1",
      branchId: "branch-1",
      attemptId: "attempt-1",
      turnId: null,
      message: {
        role: "assistant",
        id: "message-1",
        metadata: { omitted: undefined, retained: "value" },
        parts: [{ text: "Hello", type: "text", metadata: { ignored: undefined } }, undefined],
      } as unknown as SessionTranscriptArtifact["message"],
    };
    const canonicalEquivalent = {
      attemptId: "attempt-1",
      branchId: "branch-1",
      message: {
        id: "message-1",
        metadata: { retained: "value" },
        parts: [{ metadata: {}, text: "Hello", type: "text" }, null],
        role: "assistant",
      } as unknown as SessionTranscriptArtifact["message"],
      threadId: "thread-1",
      turnId: null,
      version: 1 as const,
    };

    const first = await artifacts.write(withOptionalValues);
    const second = await artifacts.write(canonicalEquivalent);

    expect(second).toEqual(first);
    const packed = await readFile(join(directory!, `${first.id.slice("sha256:".length)}.json.gz`));
    await expect(gunzipAsync(packed).then((bytes) => bytes.toString("utf8"))).resolves.toBe(
      '{"attemptId":"attempt-1","branchId":"branch-1","message":{"id":"message-1","metadata":{"retained":"value"},"parts":[{"metadata":{},"text":"Hello","type":"text"},null],"role":"assistant"},"threadId":"thread-1","turnId":null,"version":1}',
    );
    await expect(artifacts.read(first)).resolves.toEqual(canonicalEquivalent);
  });

  it("rejects invalid reference metadata and checksum-corrupted artifact bytes", async () => {
    const artifacts = await store();
    await expect(
      artifacts.read({
        id: "sha256:../../outside",
        digest: "sha256:../../outside",
        mediaType: null,
      }),
    ).rejects.toThrow("reference is invalid");

    const reference = await artifacts.write(artifact());
    await expect(artifacts.read({ ...reference, mediaType: "application/json" })).rejects.toThrow(
      "reference is invalid",
    );
    await writeFile(join(directory!, `${reference.id.slice("sha256:".length)}.json.gz`), "corrupt");
    await expect(artifacts.read(reference)).rejects.toThrow();
  });

  it("rejects a digest filename replaced with a symlink", async () => {
    const artifacts = await store();
    const reference = await artifacts.write(artifact());
    const artifactPath = join(directory!, `${reference.id.slice("sha256:".length)}.json.gz`);
    const externalPath = join(directory!, "outside.json.gz");
    await writeFile(externalPath, await readFile(artifactPath));
    await rm(artifactPath);
    await symlink(externalPath, artifactPath);

    await expect(artifacts.read(reference)).rejects.toThrow("not a regular file");
  });

  it("rejects a symlinked digest path on the synchronous read too", async () => {
    const artifacts = await store();
    const reference = await artifacts.write(artifact());
    const artifactPath = join(directory!, `${reference.id.slice("sha256:".length)}.json.gz`);
    const externalPath = join(directory!, "outside.json.gz");
    await writeFile(externalPath, await readFile(artifactPath));
    await rm(artifactPath);
    await symlink(externalPath, artifactPath);

    expect(() => artifacts.readCanonicalBytesSync(reference)).toThrow("not a regular file");
  });

  it("refuses a FIFO at the digest path instead of blocking on it", async () => {
    // Opening a FIFO for reading waits for a writer. The old `lstat` refused it
    // before any open; an open-first read has to refuse it without waiting.
    const artifacts = await store();
    const reference = await artifacts.write(artifact());
    const artifactPath = join(directory!, `${reference.id.slice("sha256:".length)}.json.gz`);
    await rm(artifactPath);
    execFileSync("mkfifo", [artifactPath]);

    await expect(artifacts.read(reference)).rejects.toThrow("not a regular file");
    expect(() => artifacts.readCanonicalBytesSync(reference)).toThrow("not a regular file");
  });

  describe("a digest path swapped for a symlink after the store first touches it", () => {
    /**
     * Arms the race: the first touch of the compressed path replaces it, in one
     * atomic rename, with a symlink to a decoy holding ANOTHER artifact's valid
     * bytes. Reading through the symlink therefore fails the digest check, and
     * reading the file the store actually opened and checked succeeds.
     */
    async function armSwap() {
      const artifacts = await store();
      const value = artifact("the bytes that were checked");
      const reference = await artifacts.write(value);
      const decoy = await artifacts.write(artifact("a decoy behind the symlink"));
      const digestPath = (id: string) => join(directory!, `${id.slice("sha256:".length)}.json.gz`);
      const swapLink = join(directory!, "swap.link");
      race.target = digestPath(reference.id);
      race.swap = () => {
        symlinkSync(digestPath(decoy.id), swapLink);
        renameSync(swapLink, digestPath(reference.id));
      };
      return { artifacts, reference, value };
    }

    it("reads the file it checked on the async path", async () => {
      const { artifacts, reference, value } = await armSwap();

      await expect(artifacts.read(reference)).resolves.toEqual(value);
      expect(race.swap).toBeUndefined();
      expect((await lstat(race.target!)).isSymbolicLink()).toBe(true);
    });

    it("reads the file it checked on the synchronous path", async () => {
      const { artifacts, reference, value } = await armSwap();

      const bytes = artifacts.readCanonicalBytesSync(reference);
      expect(JSON.parse(bytes.toString("utf8"))).toEqual(value);
      expect(race.swap).toBeUndefined();
      expect((await lstat(race.target!)).isSymbolicLink()).toBe(true);
    });
  });

  it("rejects tampered and symlinked digest paths before publishing a write", async () => {
    const artifacts = await store();
    const value = artifact();
    const reference = await artifacts.write(value);
    const artifactPath = join(directory!, `${reference.id.slice("sha256:".length)}.json.gz`);

    await writeFile(artifactPath, "bytes for another digest");
    await expect(artifacts.write(value)).rejects.toThrow();

    const externalPath = join(directory!, "outside.json.gz");
    await writeFile(externalPath, await readFile(artifactPath));
    await rm(artifactPath);
    await symlink(externalPath, artifactPath);
    await expect(artifacts.write(value)).rejects.toThrow("not a regular file");
  });

  it("repack skips wrong digest bytes and keeps the only readable form in place", async () => {
    const artifacts = await store();
    const { reference } = referenceFor(artifact("expected"));
    const digest = reference.id.slice("sha256:".length);
    const plainPath = join(directory!, `${digest}.json`);
    await writeFile(plainPath, canonicalBytes(artifact("different")));
    const failures: string[] = [];

    const report = await repackLegacyTranscriptArtifacts(artifacts, {
      batchSize: 1,
      pause: async () => undefined,
      onError: (path, error) => failures.push(`${path}: ${String(error)}`),
    });

    expect(report).toMatchObject({ scanned: 1, repacked: 0, skipped: 1 });
    expect(failures).toHaveLength(1);
    expect((await lstat(plainPath)).isFile()).toBe(true);
    await expect(lstat(join(directory!, `${digest}.json.gz`))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps a good plain artifact readable when compressed publication fails", async () => {
    await store();
    const value = artifact("publish failure");
    const { bytes, reference } = referenceFor(value);
    const digest = reference.id.slice("sha256:".length);
    const plainPath = join(directory!, `${digest}.json`);
    await writeFile(plainPath, bytes);
    const artifacts = new FileTranscriptArtifactStore(directory!, {
      gzipBytes: async () => {
        throw new Error("fixture gzip failed");
      },
    });

    const report = await repackLegacyTranscriptArtifacts(artifacts, {
      pause: async () => undefined,
    });

    expect(report).toMatchObject({ scanned: 1, repacked: 0, skipped: 1 });
    expect((await lstat(plainPath)).isFile()).toBe(true);
    await expect(artifacts.read(reference)).resolves.toEqual(value);
  });

  it("removes its bad publication and keeps the plain artifact when gzip inflates to wrong bytes", async () => {
    await store();
    const value = artifact("good plain bytes");
    const { bytes, reference } = referenceFor(value);
    const digest = reference.id.slice("sha256:".length);
    const plainPath = join(directory!, `${digest}.json`);
    const compressedPath = join(directory!, `${digest}.json.gz`);
    await writeFile(plainPath, bytes);
    const artifacts = new FileTranscriptArtifactStore(directory!, {
      gzipBytes: async () => gzipAsync(canonicalBytes(artifact("wrong compressed bytes"))),
    });

    const report = await repackLegacyTranscriptArtifacts(artifacts, {
      pause: async () => undefined,
    });

    expect(report).toMatchObject({ scanned: 1, repacked: 0, skipped: 1 });
    expect((await lstat(plainPath)).isFile()).toBe(true);
    await expect(lstat(compressedPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(artifacts.read(reference)).resolves.toEqual(value);
  });

  it("keeps a same-bytes legacy replacement when its file identity changes during publish", async () => {
    await store();
    const value = artifact("identity changed");
    const { bytes, reference } = referenceFor(value);
    const digest = reference.id.slice("sha256:".length);
    const plainPath = join(directory!, `${digest}.json`);
    await writeFile(plainPath, bytes);
    const artifacts = new FileTranscriptArtifactStore(directory!, {
      gzipBytes: async (canonical) => {
        await rm(plainPath);
        await writeFile(plainPath, canonical);
        return gzipAsync(canonical);
      },
    });

    const report = await repackLegacyTranscriptArtifacts(artifacts, {
      pause: async () => undefined,
    });

    expect(report).toMatchObject({ scanned: 1, repacked: 0, skipped: 1 });
    expect((await lstat(plainPath)).isFile()).toBe(true);
    await expect(artifacts.read(reference)).resolves.toEqual(value);
  });

  it("keeps both known-bad gzip and good plain bytes when the repair temp fails verification", async () => {
    await store();
    const value = artifact("repair source survives");
    const { bytes, reference } = referenceFor(value);
    const digest = reference.id.slice("sha256:".length);
    const plainPath = join(directory!, `${digest}.json`);
    const compressedPath = join(directory!, `${digest}.json.gz`);
    const knownBad = Buffer.from([0x1f, 0x8b, 0x08]);
    await writeFile(plainPath, bytes);
    await writeFile(compressedPath, knownBad);
    const artifacts = new FileTranscriptArtifactStore(directory!, {
      gzipBytes: async () => gzipAsync(canonicalBytes(artifact("wrong repair bytes"))),
    });

    const report = await repackLegacyTranscriptArtifacts(artifacts, {
      pause: async () => undefined,
    });

    expect(report).toMatchObject({ scanned: 1, repacked: 0, skipped: 1 });
    await expect(readFile(compressedPath)).resolves.toEqual(knownBad);
    await expect(readFile(plainPath)).resolves.toEqual(bytes);
  });

  it("atomically repairs a known-bad compressed sibling from a verified plain artifact", async () => {
    const artifacts = await store();
    const value = artifact("repair me");
    const { bytes, reference } = referenceFor(value);
    const digest = reference.id.slice("sha256:".length);
    const plainPath = join(directory!, `${digest}.json`);
    const compressedPath = join(directory!, `${digest}.json.gz`);
    await writeFile(plainPath, bytes);
    await writeFile(compressedPath, Buffer.from([0x1f, 0x8b, 0x08]));

    const report = await repackLegacyTranscriptArtifacts(artifacts, {
      pause: async () => undefined,
    });

    expect(report).toMatchObject({ scanned: 1, repacked: 1, skipped: 0 });
    await expect(lstat(plainPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(gunzipAsync(await readFile(compressedPath))).resolves.toEqual(bytes);
    await expect(artifacts.read(reference)).resolves.toEqual(value);
  });

  it("backs off while a turn is live before attempting a legacy batch", async () => {
    await store();
    const entry = referenceFor(artifact("wait for idle"));
    await writeFile(
      join(directory!, `${entry.reference.id.slice("sha256:".length)}.json`),
      entry.bytes,
    );
    const events: string[] = [];
    let live = true;
    const artifacts = new FileTranscriptArtifactStore(directory!, {
      gzipBytes: async (bytes) => {
        events.push("gzip");
        return gzipAsync(bytes);
      },
    });

    const report = await repackLegacyTranscriptArtifacts(artifacts, {
      pause: async () => undefined,
      shouldBackOff: () => {
        events.push(live ? "live" : "idle");
        return live;
      },
      backoff: async () => {
        events.push("backoff");
        live = false;
      },
    } as Parameters<typeof repackLegacyTranscriptArtifacts>[1]);

    expect(report).toMatchObject({ repacked: 1, skipped: 0, aborted: false });
    expect(events).toEqual(["live", "backoff", "idle", "gzip"]);
  });

  it("cancels without touching a legacy artifact while waiting for idle", async () => {
    await store();
    const entry = referenceFor(artifact("quit while busy"));
    const plainPath = join(directory!, `${entry.reference.id.slice("sha256:".length)}.json`);
    await writeFile(plainPath, entry.bytes);
    const controller = new AbortController();
    const artifacts = new FileTranscriptArtifactStore(directory!, {
      gzipBytes: async () => {
        throw new Error("repack ran after cancellation");
      },
    });

    const report = await repackLegacyTranscriptArtifacts(artifacts, {
      signal: controller.signal,
      shouldBackOff: () => true,
      backoff: async () => controller.abort(),
    } as Parameters<typeof repackLegacyTranscriptArtifacts>[1]);

    expect(report).toMatchObject({ repacked: 0, skipped: 0, aborted: true });
    expect((await lstat(plainPath)).isFile()).toBe(true);
  });

  it("an interrupted repack leaves every artifact readable and resumes from siblings", async () => {
    const artifacts = await store();
    const entries = [referenceFor(artifact("alpha")), referenceFor(artifact("beta"))];
    for (const entry of entries) {
      await writeFile(
        join(directory!, `${entry.reference.id.slice("sha256:".length)}.json`),
        entry.bytes,
      );
    }
    const controller = new AbortController();

    const first = await repackLegacyTranscriptArtifacts(artifacts, {
      batchSize: 1,
      signal: controller.signal,
      pause: async () => controller.abort(),
    });

    expect(first).toMatchObject({ scanned: 2, repacked: 1, aborted: true });
    for (const entry of entries) {
      await expect(artifacts.read(entry.reference)).resolves.toEqual(
        JSON.parse(entry.bytes.toString("utf8")),
      );
    }
    const namesAfterInterruption = await readdir(directory!);
    expect(namesAfterInterruption.filter((name) => name.endsWith(".json.gz"))).toHaveLength(1);
    expect(namesAfterInterruption.filter((name) => name.endsWith(".json"))).toHaveLength(1);

    const resumed = await repackLegacyTranscriptArtifacts(artifacts, {
      batchSize: 1,
      pause: async () => undefined,
    });
    expect(resumed).toMatchObject({ scanned: 1, repacked: 1, skipped: 0, aborted: false });
    expect((await readdir(directory!)).filter((name) => name.endsWith(".json"))).toHaveLength(0);
  });
});
