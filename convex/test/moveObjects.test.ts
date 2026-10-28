/**
 * The move engine's production object store (host-core `presignedMoveObjects`)
 * against the real `projectImports.presignPut` / `presignRead` and an
 * S3 stand-in that checks every signature: write-once uploads, streamed
 * bodies, HEADs that report the stored checksum, and keys the move does not
 * own refused before anything is signed.
 */
import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import { makeFunctionReference } from "convex/server";
import { migrationKey, projectBlobKey } from "@volli/shared/cloud";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { presignedMoveObjects } from "../../packages/host-core/src/cloud-move/objects";
import type { MoveBackend } from "../../packages/host-core/src/cloud-move/ports";
import { api } from "../functions/_generated/api";
import { MOVED, beginArgs, importWorld, type ImportWorld } from "./projectImport-fixtures";
import { S3StandIn } from "./s3-standin";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

type Untyped = Record<
  "query" | "mutation" | "action",
  (reference: unknown, args: Record<string, unknown>) => Promise<unknown>
>;

function backendOf(world: ImportWorld): MoveBackend {
  const as = world.alice.as as unknown as Untyped;
  return {
    query: (path, args) => as.query(makeFunctionReference(path), args),
    mutation: (path, args) => as.mutation(makeFunctionReference(path), args),
    action: (path, args) => as.action(makeFunctionReference(path), args),
  };
}

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function open() {
  const store = new S3StandIn().install();
  const world = await importWorld();
  await world.alice.as.mutation(api.projectImports.begin, beginArgs(world));
  const objects = presignedMoveObjects({
    backend: backendOf(world),
    fetch: store.fetch as unknown as typeof globalThis.fetch,
  });
  return { store, world, objects };
}

describe("presignedMoveObjects", () => {
  test("uploads once, answers a second upload as already there, and reads back length and checksum", async () => {
    const { store, world, objects } = await open();
    const bytes = new TextEncoder().encode("an attachment");
    const object = {
      key: projectBlobKey(MOVED.projectId, sha(bytes)),
      bytes: bytes.length,
      sha256: sha(bytes),
    };
    expect(await objects.put(world.moveId, object, async () => bytes)).toBe("stored");
    expect(await objects.put(world.moveId, object, async () => bytes)).toBe("exists");
    expect(await objects.head(world.moveId, object.key)).toEqual({
      bytes: bytes.length,
      sha256: object.sha256,
    });
    expect(Buffer.from((await objects.get(world.moveId, object.key))!).toString()).toBe(
      "an attachment",
    );
    expect(store.keys()).toEqual([object.key]);
  });

  test("streams a body from disk", async () => {
    const { store, world, objects } = await open();
    const bytes = new TextEncoder().encode("x".repeat(70_000));
    const object = {
      key: migrationKey(world.moveId, "chunk.ndjson"),
      bytes: bytes.length,
      sha256: sha(bytes),
    };
    expect(
      await objects.put(world.moveId, object, async () =>
        Readable.from([bytes.slice(0, 10), bytes.slice(10)]),
      ),
    ).toBe("stored");
    expect(sha(store.objects.get(object.key)!)).toBe(object.sha256);
  });

  test("a missing object reads as nothing", async () => {
    const { world, objects } = await open();
    const key = migrationKey(world.moveId, "absent.json");
    expect(await objects.head(world.moveId, key)).toBeNull();
    expect(await objects.get(world.moveId, key)).toBeNull();
  });

  test("bytes that are not what was signed are refused by the store", async () => {
    const { world, objects } = await open();
    const bytes = new TextEncoder().encode("signed");
    const object = {
      key: migrationKey(world.moveId, "a.json"),
      bytes: bytes.length,
      sha256: sha(bytes),
    };
    await expect(
      objects.put(world.moveId, object, async () => new TextEncoder().encode("other!")),
    ).rejects.toMatchObject({ data: { code: "object_refused", status: 400 } });
  });

  test("a key outside the move is refused before anything is signed, for writes and reads", async () => {
    const { store, world, objects } = await open();
    const other = migrationKey(crypto.randomUUID(), "manifest.json");
    await expect(
      objects.put(
        world.moveId,
        { key: other, bytes: 1, sha256: "a".repeat(64) },
        async () => new Uint8Array(1),
      ),
    ).rejects.toMatchObject({ data: { code: "invalid_key" } });
    await expect(objects.head(world.moveId, other)).rejects.toMatchObject({
      data: { code: "invalid_key" },
    });
    expect(store.log).toEqual([]);
  });

  test("a closed move reads nothing back", async () => {
    const { world, objects } = await open();
    await world.alice.as.mutation(api.projectImports.abort, { moveId: world.moveId });
    await expect(
      objects.head(world.moveId, migrationKey(world.moveId, "manifest.json")),
    ).rejects.toMatchObject({ data: { code: "import_closed" } });
  });

  test("another person cannot read a move's objects", async () => {
    const { world } = await open();
    await expect(
      world.bob.as.action(api.projectImports.presignRead, {
        moveId: world.moveId,
        key: migrationKey(world.moveId, "manifest.json"),
        method: "GET",
      }),
    ).rejects.toMatchObject({ data: { code: "not_found" } });
  });
});
