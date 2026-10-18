import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  active: new Map<number, string>(),
  beforeLink: undefined as ((destination: string) => void) | undefined,
  afterStat: undefined as ((path: string) => void) | undefined,
  failure: undefined as "open" | "stat" | "write" | "read" | "link" | undefined,
  linkError: undefined as string | undefined,
  renameError: undefined as string | undefined,
  sweepFailure: undefined as
    | { operation: "readdir" | "lstat" | "unlink"; path: string }
    | undefined,
  directoryReads: [] as string[],
  // The order of durability-relevant calls, so a test can prove fsync precedes
  // publication and the directory is synced after it.
  journal: [] as string[],
  fsyncFailure: undefined as ((path: string) => boolean) | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      if (state.failure === "open") throw new Error("injected open failure");
      const fd = fs.openSync(...args);
      state.active.set(fd, String(args[0]));
      return fd;
    },
    fstatSync: (fd: number) => {
      if (state.failure === "stat") throw new Error("injected stat failure");
      const entry = fs.fstatSync(fd);
      state.afterStat?.(state.active.get(fd)!);
      return entry;
    },
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      if (state.failure === "write") {
        // Model failure after a partial write, not just before the first byte.
        fs.writeFileSync(args[0], "partial");
        throw new Error("injected write failure");
      }
      return fs.writeFileSync(...args);
    },
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      if (state.failure === "read") throw new Error("injected read failure");
      return fs.readFileSync(...args);
    },
    fsyncSync: (fd: number) => {
      const path = state.active.get(fd)!;
      if (state.fsyncFailure?.(path)) throw new Error("injected fsync failure");
      state.journal.push(`fsync ${path}`);
      return fs.fsyncSync(fd);
    },
    linkSync: (...args: Parameters<typeof fs.linkSync>) => {
      state.journal.push(`link ${String(args[1])}`);
      if (state.failure === "link") throw new Error("injected link failure");
      state.beforeLink?.(String(args[1]));
      if (state.linkError)
        throw Object.assign(new Error("injected link error"), { code: state.linkError });
      return fs.linkSync(...args);
    },
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      state.journal.push(`rename ${String(args[1])}`);
      if (state.renameError) {
        throw Object.assign(new Error("injected rename error"), { code: state.renameError });
      }
      return fs.renameSync(...args);
    },
    readdirSync: (...args: Parameters<typeof fs.readdirSync>) => {
      state.directoryReads.push(String(args[0]));
      if (
        state.sweepFailure?.operation === "readdir" &&
        state.sweepFailure.path === String(args[0])
      ) {
        throw new Error("injected sweep directory failure");
      }
      return fs.readdirSync(...args);
    },
    lstatSync: (...args: Parameters<typeof fs.lstatSync>) => {
      if (
        state.sweepFailure?.operation === "lstat" &&
        state.sweepFailure.path === String(args[0])
      ) {
        throw new Error("injected sweep stat failure");
      }
      return fs.lstatSync(...args);
    },
    unlinkSync: (...args: Parameters<typeof fs.unlinkSync>) => {
      if (
        state.sweepFailure?.operation === "unlink" &&
        state.sweepFailure.path === String(args[0])
      ) {
        throw new Error("injected sweep unlink failure");
      }
      return fs.unlinkSync(...args);
    },
    closeSync: (fd: number) => {
      fs.closeSync(fd);
      state.active.delete(fd);
    },
  };
});

import { blobExists, blobFilePath, hashBytes, readBlob, removeBlob, writeBlob } from "./blob-store";

let root: string;
const bytes = Buffer.from("attachment bytes");
const hash = hashBytes(bytes);
let destination: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "volli-blob-fd-"));
  destination = blobFilePath(root, hash);
  state.beforeLink = undefined;
  state.afterStat = undefined;
  state.failure = undefined;
  state.linkError = undefined;
  state.renameError = undefined;
  state.sweepFailure = undefined;
  state.directoryReads = [];
  state.journal = [];
  state.fsyncFailure = undefined;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  expect(state.active.size).toBe(0);
  vi.restoreAllMocks();
});

function expectNoTemporaryFiles(): void {
  if (!existsSync(dirname(destination))) return;
  expect(readdirSync(dirname(destination)).filter((name) => name.startsWith(".blob-"))).toEqual([]);
}

function stagingFile(path: string, ageMs = 2 * 60 * 60 * 1000): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "staged bytes");
  const time = new Date(Date.now() - ageMs);
  utimesSync(path, time, time);
  return path;
}

describe("blob staging cleanup", () => {
  it.each(["exists", "read", "write", "remove"])("sweeps on the first %s use only", (operation) => {
    const stale = stagingFile(join(dirname(destination), ".blob-stale"));
    writeFileSync(destination, bytes);
    if (operation === "exists") expect(blobExists(root, hash)).toBe(true);
    if (operation === "read") expect(readBlob(root, hash)).toEqual(bytes);
    if (operation === "write") expect(writeBlob(root, bytes)).toBe(hash);
    if (operation === "remove") removeBlob(root, hash);
    expect(existsSync(stale)).toBe(false);
    const later = stagingFile(join(dirname(destination), ".blob-later"));
    blobExists(root, hash);
    expect(existsSync(later)).toBe(true);
    expect(state.directoryReads.filter((path) => path === root)).toHaveLength(1);
  });

  it("only removes regular staging files older than one hour", () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const stale = stagingFile(join(dirname(destination), ".blob-stale"));
    const fresh = stagingFile(join(dirname(destination), ".blob-fresh"), 30 * 60 * 1000);
    const boundary = stagingFile(join(dirname(destination), ".blob-boundary"), 60 * 60 * 1000);
    stagingFile(destination);
    const unrelated = stagingFile(join(dirname(destination), "not-a-blob"));
    expect(blobExists(root, hash)).toBe(true);
    expect(existsSync(stale)).toBe(false);
    for (const path of [fresh, boundary, destination, unrelated])
      expect(existsSync(path)).toBe(true);
  });

  it("never follows shard or staging symlinks or recurses into staging directories", () => {
    const outside = join(root, "outside");
    const outsideFile = stagingFile(join(outside, ".blob-outside"));
    symlinkSync(outside, join(root, "00"));
    mkdirSync(dirname(destination), { recursive: true });
    const leaf = join(dirname(destination), ".blob-symlink");
    symlinkSync(outsideFile, leaf);
    const nested = stagingFile(join(dirname(destination), ".blob-directory", ".blob-nested"));
    const unrelated = stagingFile(join(root, "not-a-shard", ".blob-unrelated"));
    blobExists(root, hash);
    expect(lstatSync(leaf).isSymbolicLink()).toBe(true);
    for (const path of [outsideFile, nested, unrelated]) expect(existsSync(path)).toBe(true);
    expect(state.directoryReads).not.toContain(outside);
    expect(state.directoryReads).not.toContain(join(root, "00"));
    expect(state.directoryReads).not.toContain(dirname(nested));
  });

  it.each(["root", "shard", "lstat", "unlink"] as const)(
    "treats a sweep %s failure as best effort and does not retry",
    (failure) => {
      const shard = dirname(destination);
      const stale = stagingFile(join(shard, ".blob-stale"));
      state.sweepFailure = {
        operation: failure === "root" || failure === "shard" ? "readdir" : failure,
        path: failure === "root" ? root : failure === "shard" ? shard : stale,
      };
      expect(writeBlob(root, bytes)).toBe(hash);
      expect(readBlob(root, hash)).toEqual(bytes);
      expect(existsSync(stale)).toBe(true);
      state.sweepFailure = undefined;
      expect(writeBlob(root, bytes)).toBe(hash);
      expect(existsSync(stale)).toBe(true);
      expect(state.directoryReads.filter((path) => path === root)).toHaveLength(1);
    },
  );

  it("allows the first write after a missing-root sweep and does not retry", () => {
    rmSync(root, { recursive: true });
    expect(blobExists(root, hash)).toBe(false);
    expect(writeBlob(root, bytes)).toBe(hash);
    expect(readBlob(root, hash)).toEqual(bytes);
    expect(state.directoryReads.filter((path) => path === root)).toHaveLength(1);
  });

  it("continues cleaning other files after one staging unlink fails", () => {
    const stale = stagingFile(join(dirname(destination), ".blob-stale"));
    const other = stagingFile(join(dirname(destination), ".blob-other"));
    state.sweepFailure = { operation: "unlink", path: stale };
    expect(writeBlob(root, bytes)).toBe(hash);
    expect(existsSync(stale)).toBe(true);
    expect(existsSync(other)).toBe(false);
  });
});

describe("blob atomic publication and descriptor safety", () => {
  it("roundtrips bytes and leaves an existing blob untouched", () => {
    expect(writeBlob(root, bytes)).toBe(hash);
    const original = statSync(destination);
    expect(writeBlob(root, bytes)).toBe(hash);
    const repeated = statSync(destination);
    expect(repeated.ino).toBe(original.ino);
    expect(repeated.mtimeMs).toBe(original.mtimeMs);
    expect(readBlob(root, hash)).toEqual(bytes);
    expect(blobExists(root, hash)).toBe(true);
    expectNoTemporaryFiles();
    removeBlob(root, hash);
    removeBlob(root, hash);
    expect(blobExists(root, hash)).toBe(false);
    expect(() => readBlob(root, hash)).toThrow();
  });

  it.each([0o022, 0o002, 0o077])(
    "applies umask %s to blobs and copyFile materialization",
    (mask) => {
      const previous = process.umask(mask);
      try {
        writeBlob(root, bytes);
        const materialized = join(root, "materialized");
        copyFileSync(destination, materialized);
        expect(statSync(destination).mode & 0o777).toBe(0o666 & ~mask);
        expect(statSync(materialized).mode & 0o777).toBe(0o666 & ~mask);
      } finally {
        process.umask(previous);
      }
    },
  );

  it.each(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"])(
    "publishes complete bytes through rename when hard links fail with %s",
    (code) => {
      state.linkError = code;
      expect(writeBlob(root, bytes)).toBe(hash);
      expect(readBlob(root, hash)).toEqual(bytes);
      expectNoTemporaryFiles();
    },
  );

  it("keeps a racing reader's inode intact when rename replaces equal-hash bytes", () => {
    state.linkError = "ENOTSUP";
    let reader: number | undefined;
    let readerInode: number | undefined;
    state.beforeLink = (path) => {
      writeFileSync(path, bytes, { flag: "wx" });
      reader = openSync(path, "r");
      readerInode = statSync(path).ino;
    };
    try {
      expect(writeBlob(root, bytes)).toBe(hash);
      expect(statSync(destination).ino).not.toBe(readerInode);
      expect(readFileSync(reader!)).toEqual(bytes);
      expect(readBlob(root, hash)).toEqual(bytes);
      expectNoTemporaryFiles();
    } finally {
      if (reader !== undefined) closeSync(reader);
    }
  });

  it.each(["EACCES", "EIO", "ENOSPC"])("propagates non-fallback link errors (%s)", (code) => {
    state.linkError = code;
    expect(() => writeBlob(root, bytes)).toThrow("injected link error");
    expect(existsSync(destination)).toBe(false);
    expectNoTemporaryFiles();
  });

  it("propagates rename failure and removes staging bytes", () => {
    state.linkError = "EXDEV";
    state.renameError = "EACCES";
    expect(() => writeBlob(root, bytes)).toThrow("injected rename error");
    expect(existsSync(destination)).toBe(false);
    expectNoTemporaryFiles();
  });

  it("validates an EEXIST winner even on the rename fallback", () => {
    state.linkError = "EPERM";
    state.renameError = "EEXIST";
    state.beforeLink = (path) => writeFileSync(path, bytes, { flag: "wx" });
    expect(writeBlob(root, bytes)).toBe(hash);
    expect(readBlob(root, hash)).toEqual(bytes);
    expectNoTemporaryFiles();
  });

  it("does not follow a racing symlink on the rename fallback", () => {
    const target = join(root, "outside-target");
    writeFileSync(target, "untouched");
    state.linkError = "ENOTSUP";
    state.beforeLink = (path) => symlinkSync(target, path);
    expect(writeBlob(root, bytes)).toBe(hash);
    expect(readBlob(root, hash)).toEqual(bytes);
    expect(readFileSync(target, "utf8")).toBe("untouched");
    expectNoTemporaryFiles();
  });

  it("deduplicates without writing when existing bytes are present", () => {
    writeBlob(root, bytes);
    state.failure = "write";
    expect(writeBlob(root, bytes)).toBe(hash);
    expectNoTemporaryFiles();
  });

  it.each([false, true])(
    "refuses pre-existing symlinks without modifying their targets (dangling: %s)",
    (dangling) => {
      mkdirSync(dirname(destination), { recursive: true });
      const target = join(root, "outside-target");
      if (!dangling) writeFileSync(target, "untouched");
      symlinkSync(target, destination);
      expect(() => writeBlob(root, bytes)).toThrow();
      expect(() => readBlob(root, hash)).toThrow();
      if (dangling) expect(existsSync(target)).toBe(false);
      else expect(readFileSync(target, "utf8")).toBe("untouched");
      expectNoTemporaryFiles();
    },
  );

  it("does not overwrite a racing writer's complete destination", () => {
    let winner: number | undefined;
    state.beforeLink = (path) => {
      writeFileSync(path, bytes, { flag: "wx" });
      winner = statSync(path).ino;
    };
    expect(writeBlob(root, bytes)).toBe(hash);
    expect(statSync(destination).ino).toBe(winner);
    expect(readFileSync(destination)).toEqual(bytes);
    expectNoTemporaryFiles();
  });

  it("refuses a symlink inserted just before exclusive publication", () => {
    const target = join(root, "outside-target");
    writeFileSync(target, "untouched");
    state.beforeLink = (path) => symlinkSync(target, path);
    expect(() => writeBlob(root, bytes)).toThrow();
    expect(readFileSync(target, "utf8")).toBe("untouched");
    expectNoTemporaryFiles();
  });

  it("publishes only complete bytes", () => {
    state.beforeLink = (path) => {
      expect(existsSync(path)).toBe(false);
      const temporary = readdirSync(dirname(path)).find((name) => name.startsWith(".blob-"))!;
      expect(readFileSync(join(dirname(path), temporary))).toEqual(bytes);
      expect(state.active.size).toBe(0);
    };
    writeBlob(root, bytes);
    expect(readBlob(root, hash)).toEqual(bytes);
  });

  it("rejects a nonregular destination for both writes and reads", () => {
    mkdirSync(destination, { recursive: true });
    expect(() => writeBlob(root, bytes)).toThrow("regular file");
    expect(() => readBlob(root, hash)).toThrow("regular file");
    expectNoTemporaryFiles();
  });

  it("reads the validated inode after the pathname is replaced by a symlink", () => {
    writeBlob(root, bytes);
    const target = join(root, "replacement");
    writeFileSync(target, "must not be read");
    state.afterStat = (path) => {
      if (path !== destination) return;
      rmSync(path);
      symlinkSync(target, path);
    };
    expect(readBlob(root, hash)).toEqual(bytes);
    expect(readFileSync(target, "utf8")).toBe("must not be read");
  });

  it.each(["open", "stat", "write", "link"] as const)(
    "does not publish a failed %s and cleans up descriptors and staging files",
    (failure) => {
      state.failure = failure;
      expect(() => writeBlob(root, bytes)).toThrow(`injected ${failure} failure`);
      expect(existsSync(destination)).toBe(false);
      expectNoTemporaryFiles();
    },
  );

  it.each(["stat", "read"] as const)("closes the read descriptor after %s failure", (failure) => {
    writeBlob(root, bytes);
    state.failure = failure;
    expect(() => readBlob(root, hash)).toThrow(`injected ${failure} failure`);
    expectNoTemporaryFiles();
  });

  it("closes the winning destination's descriptor if validation fails", () => {
    state.beforeLink = (path) => writeFileSync(path, bytes, { flag: "wx" });
    state.afterStat = (path) => {
      if (path === destination) throw new Error("injected winner validation failure");
    };
    expect(() => writeBlob(root, bytes)).toThrow("winner validation failure");
    expect(readFileSync(destination)).toEqual(bytes);
    expectNoTemporaryFiles();
  });
});

describe("blob durability and torn-file repair", () => {
  function plantTorn(content: string | Buffer): void {
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  }

  it("fsyncs the staged file before publishing and the new directories after", () => {
    writeBlob(root, bytes);
    const shard = dirname(destination);
    const staged = state.journal.findIndex((entry) => entry.startsWith(`fsync ${shard}/.blob-`));
    const link = state.journal.indexOf(`link ${destination}`);
    expect(staged).toBeGreaterThanOrEqual(0);
    expect(link).toBeGreaterThan(staged);
    // The shard was just created, so its entry in the root needs syncing too.
    expect(state.journal.slice(link + 1)).toEqual([`fsync ${shard}`, `fsync ${root}`]);
  });

  it("syncs only the shard when it already existed", () => {
    mkdirSync(dirname(destination), { recursive: true });
    writeBlob(root, bytes);
    const link = state.journal.indexOf(`link ${destination}`);
    expect(state.journal.slice(link + 1)).toEqual([`fsync ${dirname(destination)}`]);
  });

  it("fsyncs the staged file before the rename fallback too", () => {
    state.linkError = "ENOTSUP";
    writeBlob(root, bytes);
    const rename = state.journal.indexOf(`rename ${destination}`);
    expect(state.journal[rename - 2]).toMatch(/\/\.blob-/);
    expect(state.journal.slice(rename + 1)).toEqual([
      `fsync ${dirname(destination)}`,
      `fsync ${root}`,
    ]);
  });

  it("does not publish bytes whose fsync failed", () => {
    const shard = dirname(destination);
    state.fsyncFailure = (path) => path.startsWith(`${shard}/.blob-`);
    expect(() => writeBlob(root, bytes)).toThrow("injected fsync failure");
    expect(state.journal.some((entry) => entry.startsWith("link "))).toBe(false);
    expect(existsSync(destination)).toBe(false);
    expectNoTemporaryFiles();
  });

  it("propagates a directory fsync failure", () => {
    state.fsyncFailure = (path) => path === dirname(destination);
    expect(() => writeBlob(root, bytes)).toThrow("injected fsync failure");
    expectNoTemporaryFiles();
  });

  it.each([
    ["empty", Buffer.alloc(0)],
    ["truncated", bytes.subarray(0, 5)],
    ["zero-filled at full length", Buffer.alloc(bytes.length)],
  ])("replaces a %s file pre-planted at the hash path", (_label, torn) => {
    plantTorn(torn);
    expect(writeBlob(root, bytes)).toBe(hash);
    expect(readFileSync(destination)).toEqual(bytes);
    expect(readBlob(root, hash)).toEqual(bytes);
    const rename = state.journal.indexOf(`rename ${destination}`);
    expect(state.journal[rename - 1]).toMatch(/^fsync .*\/\.blob-/);
    expect(state.journal.slice(rename + 1)).toEqual([`fsync ${dirname(destination)}`]);
    expectNoTemporaryFiles();
  });

  it("replaces a torn winner found when publication loses the race", () => {
    state.beforeLink = (path) => writeFileSync(path, "winner", { flag: "wx" });
    expect(writeBlob(root, bytes)).toBe(hash);
    expect(readFileSync(destination)).toEqual(bytes);
    expectNoTemporaryFiles();
  });

  it("keeps a torn reader's inode intact while repairing the path", () => {
    plantTorn("torn");
    const reader = openSync(destination, "r");
    try {
      writeBlob(root, bytes);
      expect(readFileSync(reader, "utf8")).toBe("torn");
      expect(readFileSync(destination)).toEqual(bytes);
    } finally {
      closeSync(reader);
    }
  });

  it("refuses a torn file in a read-only shard rather than reporting it stored", () => {
    plantTorn("torn");
    chmodSync(dirname(destination), 0o555);
    try {
      expect(() => writeBlob(root, bytes)).toThrow();
      expect(readFileSync(destination, "utf8")).toBe("torn");
    } finally {
      chmodSync(dirname(destination), 0o755);
    }
  });

  /** Swap the path's inode once, just after the store first looks at it. */
  function replaceOnceAfterJudging(content: string | Buffer): () => number | undefined {
    let replaced: number | undefined;
    state.afterStat = (path) => {
      if (path !== destination || replaced !== undefined) return;
      rmSync(destination);
      writeFileSync(destination, content);
      replaced = statSync(destination).ino;
    };
    return () => replaced;
  }

  it("never overwrites a path that changed after it was judged torn", () => {
    plantTorn("torn");
    replaceOnceAfterJudging("someone else");
    expect(() => writeBlob(root, bytes)).toThrow("changed while it was being repaired");
    expect(readFileSync(destination, "utf8")).toBe("someone else");
    expectNoTemporaryFiles();
  });

  it("accepts a path another writer repaired first", () => {
    plantTorn("torn");
    const repaired = replaceOnceAfterJudging(bytes);
    expect(writeBlob(root, bytes)).toBe(hash);
    expect(statSync(destination).ino).toBe(repaired());
    expect(state.journal.some((entry) => entry.startsWith("rename "))).toBe(false);
    expectNoTemporaryFiles();
  });

  it.each([
    ["truncated", bytes.subarray(0, 5)],
    ["same length, wrong bytes", Buffer.alloc(bytes.length)],
  ])("readBlob refuses a %s file whose bytes do not match their hash", (_label, torn) => {
    plantTorn(torn);
    expect(() => readBlob(root, hash)).toThrow(`Blob ${hash} is corrupt`);
  });
});
