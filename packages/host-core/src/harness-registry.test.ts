import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  active: new Set<number>(),
  afterStat: undefined as (() => Promise<void>) | undefined,
  statError: false,
  readError: false,
  shortReads: false,
  bytesRequested: [] as number[],
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const file = await fs.open(...args);
      state.active.add(file.fd);
      return {
        stat: async () => {
          if (state.statError) throw new Error("injected stat failure");
          const entry = await file.stat();
          await state.afterStat?.();
          return entry;
        },
        read: async (buffer: Buffer, offset: number, length: number, position: number) => {
          if (state.readError) throw new Error("injected read failure");
          state.bytesRequested.push(length);
          return file.read(
            buffer,
            offset,
            state.shortReads ? Math.min(length, 7) : length,
            position,
          );
        },
        close: async () => {
          const fd = file.fd;
          await file.close();
          state.active.delete(fd);
        },
      };
    },
  };
});

import { MAX_MANIFEST_BYTES, scanHarnessManifests } from "./harness-registry";

let root: string;
let path: string;
const raw = JSON.stringify({
  manifestVersion: 1,
  slug: "my-harness",
  label: "My Harness",
  command: "my-harness",
  events: [],
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "volli-harness-fd-"));
  path = join(root, "my-harness", "harness.json");
  await mkdir(join(root, "my-harness"));
  state.afterStat = undefined;
  state.statError = false;
  state.readError = false;
  state.shortReads = false;
  state.bytesRequested.length = 0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  expect(state.active.size).toBe(0);
});

describe("manifest descriptor safety", () => {
  it("reads and hashes ordinary manifests, including short reads", async () => {
    await writeFile(path, raw);
    state.shortReads = true;
    const scan = await scanHarnessManifests(root);
    expect(scan.gap).toBeNull();
    expect(scan.manifests[0]?.adapter?.id).toBe("my-harness");
    expect(scan.manifests[0]?.manifestSha256).toBe(createHash("sha256").update(raw).digest("hex"));
  });

  it.each([false, true])("refuses a leaf symlink (dangling: %s)", async (dangling) => {
    const target = join(root, "target");
    if (!dangling) await writeFile(target, raw);
    await symlink(target, path);
    expect(await scanHarnessManifests(root)).toEqual({ manifests: [], gap: "manifest-unreadable" });
    if (!dangling) expect(await readFile(target, "utf8")).toBe(raw);
  });

  it("reads the checked inode when the pathname becomes a symlink after fstat", async () => {
    await writeFile(path, raw);
    const target = join(root, "replacement");
    await writeFile(target, "must not be read");
    state.afterStat = async () => {
      await rm(path);
      await symlink(target, path);
    };
    const scan = await scanHarnessManifests(root);
    expect(scan.manifests[0]?.manifestSha256).toBe(createHash("sha256").update(raw).digest("hex"));
    expect(scan.gap).toBeNull();
  });

  it("rejects nonregular files without reading and closes the descriptor", async () => {
    await mkdir(path);
    expect(await scanHarnessManifests(root)).toEqual({ manifests: [], gap: null });
    expect(state.bytesRequested).toEqual([]);
  });

  it("rejects oversized files before reading and closes the descriptor", async () => {
    await writeFile(path, "x".repeat(MAX_MANIFEST_BYTES + 1));
    expect(await scanHarnessManifests(root)).toEqual({ manifests: [], gap: null });
    expect(state.bytesRequested).toEqual([]);
  });

  it("bounds the read even when the same inode grows after fstat", async () => {
    await writeFile(path, raw);
    state.afterStat = () => writeFile(path, "x".repeat(MAX_MANIFEST_BYTES * 2));
    expect(await scanHarnessManifests(root)).toEqual({ manifests: [], gap: null });
    expect(state.bytesRequested).toEqual([MAX_MANIFEST_BYTES + 1]);
  });

  it("accepts a manifest at the exact byte limit", async () => {
    await writeFile(path, raw.padEnd(MAX_MANIFEST_BYTES, " "));
    expect((await scanHarnessManifests(root)).manifests[0]?.adapter?.id).toBe("my-harness");
  });

  it.each(["stat", "read"])(
    "closes the descriptor and preserves the gap on %s failure",
    async (operation) => {
      await writeFile(path, raw);
      state.statError = operation === "stat";
      state.readError = operation === "read";
      expect(await scanHarnessManifests(root)).toEqual({
        manifests: [],
        gap: "manifest-unreadable",
      });
    },
  );
});
