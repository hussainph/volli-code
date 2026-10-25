import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";

import { canonicalJson, type SessionTranscriptArtifact } from "@volli/session-engine";

import { SpoolTranscriptArtifactStore, SpooledArtifactUnreadableError } from "./artifact-spool";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "volli-artifact-spool-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function artifact(text: string): SessionTranscriptArtifact {
  return {
    version: 1,
    threadId: "thread",
    branchId: "branch",
    attemptId: "attempt",
    turnId: "turn-1",
    message: { id: `m-${text.length}`, role: "assistant", parts: [{ type: "text", text }] },
  };
}

function fileOf(id: string): string {
  return join(root, `${id.slice("sha256:".length)}.spool`);
}

describe("SpoolTranscriptArtifactStore", () => {
  test("writes content-addressed bodies and reads them back verified", async () => {
    const store = new SpoolTranscriptArtifactStore(root);
    const value = artifact("hello");
    const reference = await store.write(value);
    expect(reference.id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(reference.digest).toBe(reference.id);
    await expect(store.read(reference)).resolves.toEqual(value);
    const canonical = canonicalJson(value);
    await expect(store.readCanonicalBytes(reference)).resolves.toEqual(Buffer.from(canonical));
    await expect(store.byteLength(reference)).resolves.toBe(Buffer.byteLength(canonical));
    // The same body again is the same file; nothing else lands beside it.
    await expect(store.write(value)).resolves.toEqual(reference);
    expect(await readdir(root)).toEqual([`${reference.id.slice(7)}.spool`]);
  });

  test("refuses malformed artifacts and references", async () => {
    const store = new SpoolTranscriptArtifactStore(root);
    const bad = [
      { ...artifact("x"), version: 2 },
      { ...artifact("x"), threadId: 1 },
      { ...artifact("x"), turnId: 3 },
      { ...artifact("x"), message: { id: "m" } },
      null,
    ];
    for (const value of bad) {
      await expect(store.write(value as never)).rejects.toThrow(/invalid/);
    }
    const reference = await store.write(artifact("x"));
    await expect(store.read({ ...reference, mediaType: "text/plain" })).rejects.toThrow(/invalid/);
    await expect(store.read({ ...reference, id: "sha256:zz" })).rejects.toThrow(/invalid/);
    await expect(store.byteLength({ ...reference, digest: null })).resolves.toBeNull();
  });

  test("a missing, torn, foreign or linked file reads as unreadable, and a write repairs it", async () => {
    const store = new SpoolTranscriptArtifactStore(root);
    const value = artifact("repair me");
    const reference = await store.write(value);
    const path = fileOf(reference.id);
    const good = await readFile(path);

    const unreadable = async (reason: "missing" | "corrupt") => {
      const error = await store.readCanonicalBytes(reference).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SpooledArtifactUnreadableError);
      expect((error as SpooledArtifactUnreadableError).reason).toBe(reason);
    };

    await rm(path);
    await unreadable("missing");
    await expect(store.byteLength(reference)).resolves.toBeNull();

    // Torn: the header survived, the body did not.
    await writeFile(path, good.subarray(0, 12));
    await unreadable("corrupt");
    await writeFile(path, Buffer.from("nope"));
    await unreadable("corrupt");
    await expect(store.byteLength(reference)).resolves.toBeNull();
    // A whole, valid frame of other bytes.
    const other = await store.write(artifact("other"));
    await writeFile(path, await readFile(fileOf(other.id)));
    await unreadable("corrupt");
    // The right length, the wrong bytes.
    const tampered = Buffer.from(good);
    tampered.writeUInt32BE(tampered.readUInt32BE(4) + 1, 4);
    await writeFile(path, tampered);
    await unreadable("corrupt");

    await expect(store.write(value)).resolves.toEqual(reference);
    await expect(store.read(reference)).resolves.toEqual(value);

    await rm(path);
    await symlink(fileOf(other.id), path);
    await unreadable("corrupt");
    await expect(store.byteLength(reference)).resolves.toBeNull();
    await rm(path);
    await writeFile(join(root, "elsewhere"), good);
    await symlink(join(root, "elsewhere"), path);
    await expect(store.write(value)).resolves.toEqual(reference);
    await expect(store.read(reference)).resolves.toEqual(value);
  });

  test("a directory at the name is unreadable, and a verified-shape body that is not an artifact is corrupt", async () => {
    const store = new SpoolTranscriptArtifactStore(root);
    const reference = await store.write(artifact("dir"));
    const path = fileOf(reference.id);
    await rm(path);
    await mkdir(path);
    await expect(store.readCanonicalBytes(reference)).rejects.toBeInstanceOf(
      SpooledArtifactUnreadableError,
    );
    await expect(store.byteLength(reference)).resolves.toBeNull();

    // Bytes that verify against their name but are not an artifact.
    const bytes = Buffer.from('{"x":1}');
    const id = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const head = Buffer.alloc(8);
    head.write("VSP1", 0, "latin1");
    head.writeUInt32BE(bytes.length, 4);
    await writeFile(fileOf(id), Buffer.concat([head, zstdCompressSync(bytes)]));
    const foreign = { id, digest: id, mediaType: reference.mediaType };
    await expect(store.readCanonicalBytes(foreign)).resolves.toEqual(bytes);
    await expect(store.read(foreign)).rejects.toBeInstanceOf(SpooledArtifactUnreadableError);
  });

  test("flush syncs what was written since the last flush, and tolerates a file gone since", async () => {
    const store = new SpoolTranscriptArtifactStore(root);
    await expect(store.flush()).resolves.toBeUndefined();
    const first = await store.write(artifact("one"));
    await store.write(artifact("two"));
    await rm(fileOf(first.id));
    await expect(store.flush()).resolves.toBeUndefined();
    await expect(store.flush()).resolves.toBeUndefined();
  });

  test("the first flush syncs what an earlier process left unflushed", async () => {
    const earlier = new SpoolTranscriptArtifactStore(root);
    await earlier.write(artifact("before the crash"));
    // A new process: its in-memory list is empty, the spool is not.
    const later = new SpoolTranscriptArtifactStore(root);
    await writeFile(join(root, "unrelated.txt"), "");
    await expect(later.flush()).resolves.toBeUndefined();
    await expect(
      new SpoolTranscriptArtifactStore(join(root, "absent")).flush(),
    ).resolves.toBeUndefined();
  });

  test("a failed flush keeps its files for the next one", async () => {
    const directory = join(root, "spool");
    const store = new SpoolTranscriptArtifactStore(directory);
    await store.write(artifact("kept"));
    // The directory sync fails: the directory is gone.
    await rm(directory, { recursive: true });
    await expect(store.flush()).rejects.toThrow();
    await mkdir(directory);
    await expect(store.flush()).resolves.toBeUndefined();
  });

  test("a write fails while its directory cannot exist, and succeeds once it can", async () => {
    const blocker = join(root, "blocked");
    await writeFile(blocker, "");
    const store = new SpoolTranscriptArtifactStore(join(blocker, "spool"));
    await expect(store.write(artifact("x"))).rejects.toThrow();
    await rm(blocker);
    await expect(store.write(artifact("x"))).resolves.toMatchObject({ id: expect.any(String) });
  });
});
