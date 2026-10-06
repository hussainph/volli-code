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
  readDatabaseRecoveryIntent,
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

  it("names the exact hostd retry command and retains the first restore's metadata", () => {
    const path = profile();
    const restore = { sourcePath: join(directory!, "operator's backup.db"), schemaVersion: 59 };
    beginDatabaseRecovery(path, "first-preserved", restore);
    beginDatabaseRecovery(path, "retry-preserved", {
      sourcePath: "/another-copy",
      schemaVersion: 58,
    });
    expect(readDatabaseRecoveryIntent(path)).toEqual({
      preservedDirectory: "first-preserved",
      restore,
    });
    expect(() => assertNoPendingDatabaseRecovery(path)).toThrow(
      `volli-hostd database restore --data-dir '${directory}' --from '${directory}/operator'\\''s backup.db' --schema 59 --yes`,
    );
  });

  it.each([
    "not JSON",
    "null",
    JSON.stringify({ preservedDirectory: "../outside" }),
    JSON.stringify({ preservedDirectory: "." }),
  ])("keeps malformed or unsafe old intent fenced without using its metadata: %s", (marker) => {
    const path = profile();
    writeFileSync(recoveryPendingPath(path), marker);
    expect(readDatabaseRecoveryIntent(path)).toBeUndefined();
    expect(() => assertNoPendingDatabaseRecovery(path)).toThrow(
      "--from <same-source> --schema <same-schema> --yes",
    );
    expect(existsSync(recoveryPendingPath(path))).toBe(true);
  });

  it("ignores invalid retry fields while preserving the original evidence directory", () => {
    const path = profile();
    writeFileSync(
      recoveryPendingPath(path),
      JSON.stringify({ preservedDirectory: "first-preserved", restore: { schemaVersion: 0 } }),
    );
    expect(readDatabaseRecoveryIntent(path)).toEqual({ preservedDirectory: "first-preserved" });
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
