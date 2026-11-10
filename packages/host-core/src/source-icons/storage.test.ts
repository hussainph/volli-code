import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
  access,
  truncate,
  rename,
  readdir,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { SourceIconDisk, type StoredSourceIcon } from "./storage";
import { SourceIconCache } from "./cache";
import * as directoryIo from "./directory-io";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/6ZkAAAAASUVORK5CYII=",
  "base64",
);
const OWNER = "a".repeat(64);
const OTHER = "b".repeat(64);
const roots: string[] = [];
const caches: SourceIconCache[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const held of caches.splice(0)) held.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function directory(): Promise<string> {
  const parent = fileURLToPath(new URL("../../../../.tmp/", import.meta.url));
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "source-icon-storage-"));
  roots.push(root);
  return root;
}
const row = (id = 1): StoredSourceIcon => ({
  id: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
  sessionId: "session",
  authority: OWNER,
  origin: "https://docs.example.com",
  expiresAt: 7 * 24 * 60 * 60 * 1000,
  bytes: PNG,
});
function cache(disk: SourceIconDisk, owner: string | null = OWNER) {
  const held = new SourceIconCache({
    persistence: disk,
    now: () => 0,
    authorityForSession: (id) => (id === "session" ? owner : null),
  });
  caches.push(held);
  return held;
}

describe("source icon persistence and rehydration", () => {
  it("rehydrates opaque references only for the same live Session/account grant", async () => {
    const root = await directory();
    const disk = new SourceIconDisk(root, vi.fn(), () => 0);
    disk.save([row()]);
    await disk.settled();
    const first = cache(disk);
    await first.hydrated;
    expect(first.picture("session", row().id).data).toBe(PNG.toString("base64"));
    expect(first.picture("other-session", row().id).data).toBeNull();
    // No acquisition port is constructed when history resolves cached bytes.
    const otherDisk = new SourceIconDisk(root, vi.fn(), () => 0);
    const denied = cache(otherDisk, OTHER);
    await denied.hydrated;
    expect(denied.picture("session", row().id).data).toBeNull();
    const emit = vi.fn();
    const stop = denied.watch({ sessionId: "session", origins: [row().origin] }, emit);
    expect(emit).toHaveBeenCalledWith({
      icons: [{ origin: row().origin, pictureId: null, registrableDomain: "example.com" }],
    });
    stop();
    await disk.settled();
    await otherDisk.settled();
  });

  it("rebinds only the same known sign-in to a new live epoch, never a different account", async () => {
    const root = await directory();
    const disk = new SourceIconDisk(root, vi.fn(), () => 0);
    disk.save([row()]);
    await disk.settled();
    let epoch = "live-epoch-after-relaunch";
    const restored = new SourceIconCache({
      persistence: disk,
      now: () => 0,
      authorityForSession: () => epoch,
      persistentAuthorityForSession: () => OWNER,
    });
    caches.push(restored);
    await restored.hydrated;
    expect(restored.picture("session", row().id).data).not.toBeNull();
    epoch = "revoked-epoch";
    expect(restored.picture("session", row().id).data).toBeNull();
    await disk.settled();
    disk.save([row()]);
    await disk.settled();
    const foreign = new SourceIconCache({
      persistence: disk,
      now: () => 0,
      authorityForSession: () => "live-epoch-after-relaunch",
      persistentAuthorityForSession: () => OTHER,
    });
    caches.push(foreign);
    await foreign.hydrated;
    expect(foreign.picture("session", row().id).data).toBeNull();
    await disk.settled();
  });

  it("filters expired, torn, corrupt and unsupported records without changing history", async () => {
    const root = await directory();
    const disk = new SourceIconDisk(root, vi.fn(), () => 0);
    disk.save([row()]);
    await disk.settled();
    const path = join(root, "cache-v1.json");
    const snapshot = JSON.parse(await readFile(path, "utf8"));
    for (const bad of [
      { ...snapshot.entries[0], id: "../../private" },
      { ...snapshot.entries[0], authority: "not an owner hash" },
      { ...snapshot.entries[0], origin: "https://user:secret@example.com" },
      { ...snapshot.entries[0], expiresAt: 0 },
      { ...snapshot.entries[0], expiresAt: row().expiresAt + 1 },
      { ...snapshot.entries[0], sha256: "0".repeat(64) },
      { ...snapshot.entries[0], data: PNG.toString("base64") + "!" },
    ]) {
      await writeFile(path, JSON.stringify({ version: 1, entries: [bad] }));
      expect(await disk.load()).toEqual([]);
    }
    for (const body of [
      "{torn",
      JSON.stringify({ version: 2, entries: [] }),
      JSON.stringify({ version: 1, entries: Array(257).fill(snapshot.entries[0]) }),
    ]) {
      await writeFile(path, body);
      expect(await disk.load()).toEqual([]);
    }
  });

  it("refuses an oversized sparse snapshot before allocating its declared size", async () => {
    const root = await directory();
    const path = join(root, "cache-v1.json");
    await writeFile(path, "");
    await truncate(path, 24 * 1024 * 1024 + 1);
    expect(await new SourceIconDisk(root, vi.fn()).load()).toEqual([]);
  });

  it("rejects symlinks and removes only its own abandoned staging files", async () => {
    const root = await directory();
    const inside = join(root, "icons");
    await mkdir(inside);
    const target = join(root, "not-the-cache.json");
    await writeFile(target, "private workspace data");
    await symlink(target, join(inside, "cache-v1.json"));
    const stage = join(inside, ".cache-00000000-0000-4000-8000-000000000002");
    await writeFile(stage, "torn");
    const unrelated = join(inside, "keep.txt");
    await writeFile(unrelated, "untouched");
    const disk = new SourceIconDisk(inside, vi.fn(), () => 0);
    expect(await disk.load()).toEqual([]);
    expect(await readFile(target, "utf8")).toBe("private workspace data");
    expect(await readFile(unrelated, "utf8")).toBe("untouched");
    await expect(access(stage)).rejects.toThrow();
  });

  it("never traverses a symlinked cache directory for read, staging, publish or cleanup", async () => {
    const parent = await directory();
    const outside = join(parent, "outside");
    await mkdir(outside);
    const stage = ".cache-00000000-0000-4000-8000-000000000003";
    await writeFile(join(outside, stage), "not ours");
    const linked = join(parent, "icons");
    await symlink(outside, linked);
    const disk = new SourceIconDisk(linked, vi.fn(), () => 0);
    expect(await disk.load()).toEqual([]);
    disk.save([row()]);
    await disk.settled();
    expect(await readdir(outside)).toEqual([stage]);
    expect(await readFile(join(outside, stage), "utf8")).toBe("not ours");
  });

  it.each(["directory", "symlink"] as const)(
    "fails closed when the pinned directory is replaced by a %s",
    async (kind) => {
      const parent = await directory();
      const root = join(parent, "icons");
      const disk = new SourceIconDisk(root, vi.fn(), () => 0);
      disk.save([row()]);
      await disk.settled();
      await rename(root, join(parent, "original"));
      const outside = join(parent, "outside");
      await mkdir(outside);
      const stage = ".cache-00000000-0000-4000-8000-000000000003";
      if (kind === "symlink") await symlink(outside, root);
      else await mkdir(root);
      const replacement = kind === "symlink" ? outside : root;
      await writeFile(join(replacement, stage), "not ours");
      expect(await disk.load()).toEqual([]);
      disk.save([row(2)]);
      await disk.settled();
      expect(await readdir(replacement)).toEqual([stage]);
      // Restoring the original name must not revive the lost authority.
      await rm(root, { recursive: true, force: true });
      await rename(join(parent, "original"), root);
      disk.save([row(2)]);
      await disk.settled();
      expect(JSON.parse(await readFile(join(root, "cache-v1.json"), "utf8")).entries[0].id).toBe(
        row().id,
      );
    },
  );

  it.each(["read", "write"] as const)(
    "rejects directory replacement between pinning and child cwd during %s",
    async (operation) => {
      const parent = await directory();
      const root = join(parent, "icons");
      await mkdir(root);
      const outside = join(parent, "outside");
      await mkdir(outside);
      const stage = ".cache-00000000-0000-4000-8000-000000000003";
      await writeFile(join(outside, stage), "not ours");
      const original = directoryIo.pinnedSourceIconIo;
      vi.spyOn(directoryIo, "pinnedSourceIconIo").mockImplementationOnce(async (...args) => {
        await rename(root, join(parent, "original"));
        await symlink(outside, root);
        // Real child / inherited fd / cwd verification, not a filesystem fake.
        return original(...args);
      });
      const disk = new SourceIconDisk(root, vi.fn(), () => 0);
      if (operation === "read") expect(await disk.load()).toEqual([]);
      else {
        disk.save([row()]);
        await disk.settled();
      }
      expect(await readdir(outside)).toEqual([stage]);
      expect(await readFile(join(outside, stage), "utf8")).toBe("not ours");
    },
  );

  it("coalesces repeated saves and publishes the last complete bounded snapshot", async () => {
    const root = await directory();
    const disk = new SourceIconDisk(root, vi.fn(), () => 0);
    for (let i = 1; i <= 500; i++) disk.save([row(i)]);
    await disk.settled();
    const entries = await disk.load();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.id).toBe(row(500).id);
  });

  it("preserves unknown-owner records without delivery and automatically retries delayed same-account restoration", async () => {
    vi.useFakeTimers();
    let restoring = true;
    let owner: string | null = null;
    let epoch = "current-epoch";
    const save = vi.fn();
    const held = new SourceIconCache({
      now: () => 0,
      authorityForSession: () => epoch,
      persistentAuthorityForSession: () => owner,
      restorationPendingForSession: () => restoring,
      persistence: { load: async () => [row()], save },
    });
    caches.push(held);
    await held.hydrated;
    expect(held.picture("session", row().id).data).toBeNull();
    const emit = vi.fn();
    const stop = held.watch({ sessionId: "session", origins: [row().origin] }, emit);
    expect(emit.mock.calls.at(-1)![0].icons[0].pictureId).toBeNull();
    expect(save).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: row().id, authority: OWNER }),
    ]);
    save.mockClear();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(save).not.toHaveBeenCalled(); // no offline polling write loop
    owner = OWNER;
    restoring = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(held.picture("session", row().id).data).toBe(PNG.toString("base64"));
    expect(emit.mock.calls.at(-1)![0].icons[0].pictureId).toBe(row().id);
    epoch = "revoked";
    held.invalidate();
    expect(emit.mock.calls.at(-1)![0].icons[0].pictureId).toBeNull();
    const emissions = emit.mock.calls.length;
    epoch = "new-grant";
    held.put("session", epoch, row().origin, PNG);
    expect(emit).toHaveBeenCalledTimes(emissions); // never rebind a previously known watch
    stop();
  });

  it.each(["mismatch", "revocation", "expiry"] as const)(
    "does not restore inert records after %s",
    async (reason) => {
      vi.useFakeTimers();
      let restoring = true;
      let owner: string | null = null;
      let now = 0;
      const save = vi.fn();
      const held = new SourceIconCache({
        now: () => now,
        authorityForSession: () => (owner === null ? null : "live"),
        persistentAuthorityForSession: () => owner,
        restorationPendingForSession: () => restoring,
        persistence: { load: async () => [row()], save },
      });
      caches.push(held);
      await held.hydrated;
      restoring = false;
      owner = reason === "mismatch" ? OTHER : reason === "revocation" ? null : OWNER;
      if (reason === "expiry") now = row().expiresAt;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(held.picture("session", row().id).data).toBeNull();
      expect(save).toHaveBeenLastCalledWith([]);
      owner = OWNER;
      held.invalidate();
      expect(held.picture("session", row().id).data).toBeNull();
    },
  );

  it("merges concurrent unrelated live writes without deleting unresolved saved records", async () => {
    let restoring = true;
    const reading = Promise.withResolvers<StoredSourceIcon[]>();
    const save = vi.fn();
    const held = new SourceIconCache({
      now: () => 0,
      createId: () => row(2).id,
      authorityForSession: () => "live",
      persistentAuthorityForSession: () => OWNER,
      restorationPendingForSession: (sessionId) => sessionId === "session" && restoring,
      persistence: { load: () => reading.promise, save },
    });
    caches.push(held);
    held.put("other-session", "live", "https://new.example.com", PNG);
    expect(save).not.toHaveBeenCalled();
    reading.resolve([row()]);
    await held.hydrated;
    expect(save.mock.calls.at(-1)![0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: row().id }),
        expect.objectContaining({ id: row(2).id }),
      ]),
    );
    expect(held.picture("session", row().id).data).toBeNull();
    restoring = false;
    held.invalidate();
    expect(held.picture("session", row().id).data).not.toBeNull();
    expect(held.picture("other-session", row(2).id).data).not.toBeNull();
  });

  it("keeps previously delivered persisted bytes inert during temporary identity uncertainty", async () => {
    let restoring = false;
    let epoch = "first-epoch";
    const save = vi.fn();
    const held = new SourceIconCache({
      now: () => 0,
      authorityForSession: () => epoch,
      persistentAuthorityForSession: () => (restoring ? null : OWNER),
      restorationPendingForSession: () => restoring,
      persistence: { load: async () => [row()], save },
    });
    caches.push(held);
    await held.hydrated;
    expect(held.picture("session", row().id).data).not.toBeNull();
    restoring = true;
    held.invalidate();
    expect(held.picture("session", row().id).data).toBeNull();
    expect(save).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: row().id, authority: OWNER }),
    ]);
    restoring = false;
    epoch = "first-epoch";
    held.invalidate();
    expect(held.picture("session", row().id).data).not.toBeNull();
  });

  it.each(["loading", "deferred"] as const)(
    "retains irreversible refusal evidence while cold rows are %s, even without a prior live grant",
    async (phase) => {
      let pending = true;
      let generation = "generation-1";
      const reading = Promise.withResolvers<StoredSourceIcon[]>();
      const save = vi.fn();
      const held = new SourceIconCache({
        now: () => 0,
        createId: () => row(2).id,
        authorityForSession: () => "recovered-live-grant",
        persistentAuthorityForSession: () => OWNER,
        restorationPendingForSession: () => pending,
        revocationGeneration: () => generation,
        persistence: { load: () => reading.promise, save },
      });
      caches.push(held);
      if (phase === "deferred") {
        reading.resolve([row()]);
        await held.hydrated;
      }
      expect(held.picture("session", row().id).data).toBeNull();
      generation = "generation-2";
      held.invalidate(); // refusal evidence exists even with zero loaded rows
      pending = false;
      held.invalidate(); // same stable sign-in is known again before load resolves
      const fresh = held.put(
        "other-session",
        "recovered-live-grant",
        "https://new.example.com",
        PNG,
      );
      expect(fresh).toBe(row(2).id);
      reading.resolve([row()]);
      await held.hydrated;
      expect(held.picture("session", row().id).data).toBeNull();
      expect(held.picture("other-session", row(2).id).data).not.toBeNull();
      expect(save).toHaveBeenLastCalledWith([expect.objectContaining({ id: row(2).id })]);
    },
  );

  it("does not resurrect a disk snapshot over a live put during rehydration", async () => {
    const reading = Promise.withResolvers<StoredSourceIcon[]>();
    const save = vi.fn();
    const held = new SourceIconCache({
      authorityForSession: () => OWNER,
      now: () => 0,
      createId: () => row(2).id,
      persistence: { load: () => reading.promise, save },
    });
    caches.push(held);
    held.put("session", OWNER, "https://new.example.com", PNG);
    reading.resolve([{ ...row(), origin: "https://new.example.com" }]);
    await held.hydrated;
    expect(held.picture("session", row().id).data).toBeNull();
    expect(held.picture("session", row(2).id).data).not.toBeNull();
    expect(save).toHaveBeenLastCalledWith([expect.objectContaining({ id: row(2).id })]);
  });
});
