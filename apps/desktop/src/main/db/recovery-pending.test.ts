import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const { paths, synced } = vi.hoisted(() => ({
  paths: new Map<number, string>(),
  synced: [] as string[],
}));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      const fd = fs.openSync(...args);
      paths.set(fd, String(args[0]));
      return fd;
    },
    fsyncSync: (fd: number) => {
      synced.push(paths.get(fd) ?? "unknown");
      return fs.fsyncSync(fd);
    },
    closeSync: (fd: number) => {
      paths.delete(fd);
      return fs.closeSync(fd);
    },
  };
});
import {
  assertNoPendingDatabaseRecovery,
  beginDatabaseRecovery,
  finishDatabaseRecovery,
  recoveryPendingPath,
} from "./recovery-pending";

let directory: string | undefined;
afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  paths.clear();
  synced.length = 0;
});

function profile(): string {
  directory = mkdtempSync(join(tmpdir(), "volli-recovery-fence-"));
  return join(directory, "volli.db");
}

describe("durable recovery intent", () => {
  it("fences a new marker and its parent directory before displacement", () => {
    const path = profile();
    beginDatabaseRecovery(path, "preserved-original");
    expect(synced).toEqual([recoveryPendingPath(path), directory]);
    expect(() => assertNoPendingDatabaseRecovery(path)).toThrow("interrupted");
    expect(existsSync(path)).toBe(false);
  });

  it("re-fences an existing marker and a retry's new preservation directory", () => {
    const path = profile();
    writeFileSync(recoveryPendingPath(path), "prior intent whose directory fsync failed");
    mkdirSync(join(directory!, "retry-preserved"));
    beginDatabaseRecovery(path, "retry-preserved");
    expect(synced).toEqual([recoveryPendingPath(path), directory]);
    expect(() => assertNoPendingDatabaseRecovery(path)).toThrow("interrupted");
  });

  it("fences marker removal only after verification completes", () => {
    const path = profile();
    beginDatabaseRecovery(path, "preserved-original");
    synced.length = 0;
    finishDatabaseRecovery(path);
    expect(synced).toEqual([directory]);
    expect(() => assertNoPendingDatabaseRecovery(path)).not.toThrow();
  });
});
