import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";

import {
  presignS3Request,
  sha256ChecksumHeader,
  transcriptPackKey,
  type S3Credentials,
} from "@volli/shared/cloud";

import { LocalObjectStore, ObjectUploadError, PresignedObjectStore } from "./object-store";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const KEY = transcriptPackKey({
  projectId: PROJECT,
  sessionId: SESSION,
  firstSequence: 1,
  lastSequence: 9,
});
const SCOPE = { sessionId: SESSION, claim: { runnerId: "r", generation: 1 } };

function object(text: string, key = KEY) {
  const body = Buffer.from(text);
  return { key, body, sha256: createHash("sha256").update(body).digest("hex") };
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "volli-object-store-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("LocalObjectStore", () => {
  test("lays objects out exactly as the bucket keys them, and re-puts are harmless", async () => {
    const store = new LocalObjectStore(root);
    await store.put(object("pack"));
    const path = join(
      root,
      "v1",
      "p",
      PROJECT,
      "s",
      SESSION,
      "tx",
      "000000000001-000000000009.pack.zst",
    );
    expect(store.pathOf(KEY)).toBe(path);
    await expect(readFile(path, "utf8")).resolves.toBe("pack");
    await store.put(object("pack"));
    await expect(readFile(path, "utf8")).resolves.toBe("pack");
  });

  test("refuses what the key grammar cannot produce, and bytes that do not match their hash", async () => {
    const store = new LocalObjectStore(root);
    for (const key of ["x/y", "v1", "v1/../etc", "v1//a", "v1/.hidden", "/v1/a"]) {
      await expect(store.put(object("x", key))).rejects.toThrow(/Not an object key/);
    }
    await expect(store.put({ ...object("x"), sha256: "0".repeat(64) })).rejects.toThrow(/hash/);
  });

  test("a key whose directory cannot be made fails the put", async () => {
    // A file where a directory of the key should be.
    await writeFile(join(root, "v1"), "");
    const store = new LocalObjectStore(root);
    await expect(store.put(object("x"))).rejects.toThrow();
  });
});

/** A stand-in S3 endpoint that checks each request's signature the way the store does. */
async function mockStore(credentials: S3Credentials, bucket: string, status = 200) {
  const received: Array<{ key: string; body: Buffer; checksum: string | undefined }> = [];
  const server: Server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(request.url!, `http://${request.headers.host}`);
      const query = url.searchParams;
      const stamp = query.get("X-Amz-Date")!;
      const now = Date.UTC(
        Number(stamp.slice(0, 4)),
        Number(stamp.slice(4, 6)) - 1,
        Number(stamp.slice(6, 8)),
        Number(stamp.slice(9, 11)),
        Number(stamp.slice(11, 13)),
        Number(stamp.slice(13, 15)),
      );
      const signedNames = query.get("X-Amz-SignedHeaders")!.split(";");
      const headers: Record<string, string> = {};
      for (const name of signedNames) {
        if (name !== "host") headers[name] = String(request.headers[name]);
      }
      const prefix = `/${bucket}/`;
      const key = decodeURIComponent(url.pathname.slice(prefix.length));
      const expected = presignS3Request({
        ...credentials,
        method: request.method as "PUT",
        endpoint: `http://${request.headers.host}`,
        bucket,
        key,
        now,
        expiresSeconds: Number(query.get("X-Amz-Expires")),
        headers,
      });
      const checksum = request.headers["x-amz-checksum-sha256"] as string | undefined;
      const valid =
        new URL(expected.url).searchParams.get("X-Amz-Signature") ===
          query.get("X-Amz-Signature") &&
        Number(request.headers["content-length"]) === body.length &&
        checksum === sha256ChecksumHeader(createHash("sha256").update(body).digest("hex"));
      if (!valid) {
        response.writeHead(403).end("SignatureDoesNotMatch");
        return;
      }
      received.push({ key, body, checksum });
      response.writeHead(status).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    endpoint,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("PresignedObjectStore", () => {
  const credentials = { accessKeyId: "AKID", secretAccessKey: "s3cret", region: "auto" };

  function storeFor(endpoint: string, secret = credentials.secretAccessKey) {
    const asked: unknown[] = [];
    const store = new PresignedObjectStore({
      presignPut: async (request) => {
        asked.push(request);
        // What `files.presignPut` signs.
        return presignS3Request({
          ...credentials,
          secretAccessKey: secret,
          method: "PUT",
          endpoint,
          bucket: "history",
          key: request.key,
          now: Date.now(),
          expiresSeconds: 300,
          headers: {
            "content-length": String(request.bytes),
            "x-amz-checksum-sha256": sha256ChecksumHeader(request.sha256),
          },
        });
      },
    });
    return { store, asked };
  }

  test("uploads exactly the signed bytes through a real HTTP request", async () => {
    const mock = await mockStore(credentials, "history");
    try {
      const { store, asked } = storeFor(mock.endpoint);
      const pack = object("compressed pack bytes");
      await store.put(pack, SCOPE);
      expect(asked).toEqual([{ ...SCOPE, key: KEY, bytes: pack.body.length, sha256: pack.sha256 }]);
      expect(mock.received).toEqual([
        { key: KEY, body: pack.body, checksum: sha256ChecksumHeader(pack.sha256) },
      ]);
    } finally {
      await mock.close();
    }
  });

  test("a refused upload is an error, retriable only for a transient answer", async () => {
    const forbidden = await mockStore(credentials, "history");
    try {
      const { store } = storeFor(forbidden.endpoint, "wrong secret");
      const error = await store.put(object("x"), SCOPE).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ObjectUploadError);
      expect(error).toMatchObject({ status: 403, retriable: false });
    } finally {
      await forbidden.close();
    }
    const busy = await mockStore(credentials, "history", 503);
    try {
      const { store } = storeFor(busy.endpoint);
      await expect(store.put(object("x"), SCOPE)).rejects.toMatchObject({
        status: 503,
        retriable: true,
      });
    } finally {
      await busy.close();
    }
    expect(new ObjectUploadError("k", 429).retriable).toBe(true);
  });

  test("refuses bytes that do not match their hash before asking for a URL", async () => {
    const { store, asked } = storeFor("http://127.0.0.1:1");
    await expect(store.put({ ...object("x"), sha256: "0".repeat(64) }, SCOPE)).rejects.toThrow(
      /hash/,
    );
    expect(asked).toEqual([]);
  });
});
