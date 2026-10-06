import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
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
    linkSync: (...args: Parameters<typeof fs.linkSync>) => {
      if (state.failure === "link") throw new Error("injected link failure");
      state.beforeLink?.(String(args[1]));
      return fs.linkSync(...args);
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
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  expect(state.active.size).toBe(0);
});

function expectNoTemporaryFiles(): void {
  if (!existsSync(dirname(destination))) return;
  expect(readdirSync(dirname(destination)).filter((name) => name.startsWith(".blob-"))).toEqual([]);
}

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

  it("does not overwrite a racing writer's destination", () => {
    state.beforeLink = (path) => writeFileSync(path, "winner", { flag: "wx" });
    expect(writeBlob(root, bytes)).toBe(hash);
    expect(readFileSync(destination, "utf8")).toBe("winner");
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
