import { execFileSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { SealedStoreUnreadableError } from "./credential-state";
import {
  publishSealedFile,
  readSealedFile,
  SealedFileChangedError,
  SealedFileIndeterminateError,
  syncDirectory,
  type PublishStep,
} from "./durable-file";

const faults = vi.hoisted(() => ({
  fsyncDirectory: false,
  rename: false,
  readdir: false,
  rm: false,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    fsyncSync: (fd: number) => {
      if (faults.fsyncDirectory && actual.fstatSync(fd).isDirectory()) throw new Error("EINVAL");
      return actual.fsyncSync(fd);
    },
    renameSync: (from: string, to: string) => {
      if (faults.rename) throw new Error("EXDEV");
      return actual.renameSync(from, to);
    },
    readdirSync: (...args: Parameters<typeof actual.readdirSync>) => {
      if (faults.readdir) throw new Error("EACCES");
      return actual.readdirSync(...args);
    },
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      if (faults.rm && String(args[0]).endsWith(".tmp")) {
        throw new Error("EBUSY");
      }
      return actual.rmSync(...args);
    },
  };
});

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "volli-durable-file-"));
  path = join(dir, "host-credentials.enc");
});
afterEach(() => {
  Object.assign(faults, { fsyncDirectory: false, rename: false, readdir: false, rm: false });
  rmSync(dir, { recursive: true, force: true });
});

const A = Buffer.from("generation A");
const B = Buffer.from("generation B");

describe("readSealedFile", () => {
  it("answers null for no file, and the bytes of one, tightened to 0600", () => {
    expect(readSealedFile(path)).toBeNull();
    writeFileSync(path, A, { mode: 0o644 });
    expect(readSealedFile(path)).toEqual(A);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
  });

  it("is unreadable through a symlink or without permission, and not a file otherwise", () => {
    writeFileSync(join(dir, "real"), A);
    symlinkSync(join(dir, "real"), path);
    expect(() => readSealedFile(path)).toThrow(SealedStoreUnreadableError);
    rmSync(path);
    mkdirSync(path);
    expect(() => readSealedFile(path)).toThrow("not a file");
    rmSync(path, { recursive: true });
    execFileSync("mkfifo", [path]);
    // O_NONBLOCK: a FIFO never hangs the read.
    expect(() => readSealedFile(path)).toThrow("not a file");
    rmSync(path);
    if (process.getuid!() !== 0) {
      writeFileSync(path, A, { mode: 0o000 });
      expect(() => readSealedFile(path)).toThrow(SealedStoreUnreadableError);
      chmodSync(path, 0o600);
    }
  });
});

describe("publishSealedFile", () => {
  it("creates, then replaces, a 0600 file through a synced temporary, reporting each step", () => {
    const steps: PublishStep[] = [];
    expect(publishSealedFile(path, A, { expected: null, step: (at) => steps.push(at) })).toEqual({
      synced: true,
    });
    expect(steps).toEqual(["temporary-written", "temporary-synced", "renamed", "directory-synced"]);
    expect(publishSealedFile(path, B, { expected: A })).toEqual({ synced: true });
    expect(readFileSync(path)).toEqual(B);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["host-credentials.enc"]);
  });

  it("never writes over a file that is not the one the caller read", () => {
    writeFileSync(path, A);
    // Expected none, found one; expected another; expected one, found none.
    expect(() => publishSealedFile(path, B, { expected: null })).toThrow(SealedFileChangedError);
    expect(() => publishSealedFile(path, B, { expected: B })).toThrow(SealedFileChangedError);
    expect(readFileSync(path)).toEqual(A);
    rmSync(path);
    expect(() => publishSealedFile(path, B, { expected: A })).toThrow(SealedFileChangedError);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("leaves the old file whole when the write stops before the rename", () => {
    writeFileSync(path, A);
    for (const at of ["temporary-written", "temporary-synced"] as const) {
      expect(() =>
        publishSealedFile(path, B, {
          expected: A,
          step: (step) => {
            if (step === at) throw new Error(`stopped at ${at}`);
          },
        }),
      ).toThrow(`stopped at ${at}`);
      expect(readFileSync(path)).toEqual(A);
      expect(readdirSync(dir)).toEqual(["host-credentials.enc"]);
    }
    faults.rename = true;
    expect(() => publishSealedFile(path, B, { expected: A })).toThrow("EXDEV");
    expect(readFileSync(path)).toEqual(A);
    expect(readdirSync(dir)).toEqual(["host-credentials.enc"]);
  });

  it("has committed the new file once it is renamed, whatever happens next", () => {
    writeFileSync(path, A);
    expect(() =>
      publishSealedFile(path, B, {
        expected: A,
        step: (step) => {
          if (step === "renamed") throw new Error("stopped after the rename");
        },
      }),
    ).toThrow("stopped after the rename");
    expect(readFileSync(path)).toEqual(B);
  });

  it("reports an unsynced directory, or throws indeterminate when sync is required", () => {
    writeFileSync(path, A);
    faults.fsyncDirectory = true;
    expect(publishSealedFile(path, B, { expected: A })).toEqual({ synced: false });
    expect(readFileSync(path)).toEqual(B);
    expect(() => publishSealedFile(path, A, { expected: B, requireDirectorySync: true })).toThrow(
      SealedFileIndeterminateError,
    );
    // The rename happened: the caller must read again, not assume nothing changed.
    expect(readFileSync(path)).toEqual(A);
  });

  it("sweeps temporaries a crashed writer left, and only those", () => {
    writeFileSync(path, A);
    const stale = [
      "host-credentials.enc.4242.0123456789ab.tmp",
      "host-credentials.enc.1.abcdefabcdef.tmp",
    ];
    const kept = [
      "host-credentials.enc.locked-20261005T000000Z-abcd1234",
      "host-credentials.enc.x.0123456789ab.tmp",
      "other.enc.4242.0123456789ab.tmp",
      "host-credentials.lock",
    ];
    for (const name of [...stale, ...kept]) writeFileSync(join(dir, name), "x");
    publishSealedFile(path, B, { expected: A });
    expect(readdirSync(dir).toSorted()).toEqual(["host-credentials.enc", ...kept].toSorted());
  });

  it("writes even when the sweep cannot list or remove", () => {
    writeFileSync(path, A);
    writeFileSync(join(dir, "host-credentials.enc.4242.0123456789ab.tmp"), "x");
    faults.rm = true;
    publishSealedFile(path, B, { expected: A });
    expect(readFileSync(path)).toEqual(B);
    faults.rm = false;
    faults.readdir = true;
    publishSealedFile(path, A, { expected: B });
    expect(readFileSync(path)).toEqual(A);
  });
});

describe("syncDirectory", () => {
  it("answers whether the directory synced", () => {
    expect(syncDirectory(dir)).toBe(true);
    expect(syncDirectory(join(dir, "missing"))).toBe(false);
  });
});
