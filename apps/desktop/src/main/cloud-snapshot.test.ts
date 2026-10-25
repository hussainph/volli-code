import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { CLOUD_SNAPSHOT_MAX_LENGTH, cloudSnapshotFiles, snapshotFileName } from "./cloud-snapshot";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function files() {
  const root = mkdtempSync(join(tmpdir(), "volli-cloud-snapshot-"));
  directories.push(root);
  const directory = join(root, "cloud-board-snapshots");
  return { directory, store: cloudSnapshotFiles(directory) };
}

describe("the last-seen cloud board on disk (VC-889)", () => {
  it("keeps one owner-only file per account, named by a hash, and reads it back", () => {
    const { directory, store } = files();
    expect(store.read("user-1")).toBeNull();
    store.write("user-1", '{"v":1}');
    store.write("user-2", '{"v":2}');
    store.write("user-1", '{"v":3}');
    expect(store.read("user-1")).toBe('{"v":3}');
    expect(store.read("user-2")).toBe('{"v":2}');
    const names = readdirSync(directory).toSorted();
    expect(names).toEqual([snapshotFileName("user-1"), snapshotFileName("user-2")].toSorted());
    expect(names.join("")).not.toContain("user");
    expect(statSync(join(directory, snapshotFileName("user-1"))).mode & 0o777).toBe(0o600);
  });

  it("refuses a snapshot past its bound, keeping the one it had", () => {
    const { store } = files();
    store.write("user-1", "kept");
    expect(() => store.write("user-1", "x".repeat(CLOUD_SNAPSHOT_MAX_LENGTH + 1))).toThrow(
      "too large",
    );
    expect(store.read("user-1")).toBe("kept");
  });

  it("leaves no temporary file behind when a write fails", () => {
    const { directory, store } = files();
    store.write("user-1", "a");
    // The target is a directory: the rename fails, the temporary file goes.
    mkdirSync(join(directory, snapshotFileName("user-9")));
    expect(() => store.write("user-9", "b")).toThrow();
    expect(readdirSync(directory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("surfaces a read that fails for another reason than a missing file", () => {
    const { directory, store } = files();
    mkdirSync(join(directory, snapshotFileName("user-1")), { recursive: true });
    expect(() => store.read("user-1")).toThrow();
  });

  it("clears every snapshot, and clearing nothing is fine", () => {
    const { directory, store } = files();
    store.clearAll();
    store.write("user-1", "a");
    store.clearAll();
    expect(existsSync(directory)).toBe(false);
    expect(store.read("user-1")).toBeNull();
  });
});
