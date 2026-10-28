/**
 * The move's object store in production: every request is presigned by the
 * backend for the move's own keys (`projectImports.presignPut`, write-once,
 * pinned to the object's exact length and SHA-256; `projectImports.presignRead`
 * for a HEAD or GET), and the bytes go straight between this Mac and the
 * store. Bodies are streamed from disk, so an upload holds no object in
 * memory.
 *
 * What the store answers decides the retry: 412 is a key already holding an
 * object (`"exists"`; the engine compares it), another 4xx is a refusal that
 * reaches the step as `object_refused`, and a 5xx, 408, 429 or a lost
 * connection is the network, retried by the engine.
 */
import { Readable } from "node:stream";

import type { MoveBackend, MoveObjectStore, StoredObject } from "./ports";

interface SignedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
}

/** Long enough for a large blob on a slow uplink; the URL itself is checked when the request starts. */
const MIN_TIMEOUT_MS = 2 * 60_000;
const BYTES_PER_MS = 64; // 64 KB/s, the slowest uplink a move waits for.

function refused(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/** An error the engine reads as a refusal (`data.code`), not as the network. */
function refusal(status: number): Error {
  return Object.assign(new Error(`The object store refused the request (${status}).`), {
    data: { code: "object_refused", message: `The object store answered ${status}.`, status },
  });
}

/** The hex SHA-256 a store reports as base64 (`x-amz-checksum-sha256`), or null. */
function checksumOf(header: string | null): string | null {
  if (header === null || header === "") return null;
  const bytes = Buffer.from(header, "base64");
  return bytes.length === 32 ? bytes.toString("hex") : null;
}

export function presignedMoveObjects(options: {
  backend: MoveBackend;
  fetch?: typeof globalThis.fetch;
}): MoveObjectStore {
  const fetchImpl = options.fetch ?? globalThis.fetch;

  const signedRead = async (moveId: string, key: string, method: "HEAD" | "GET") =>
    (
      (await options.backend.action("projectImports:presignRead", { moveId, key, method })) as {
        request: SignedRequest;
      }
    ).request;

  return {
    async put(moveId, object, body) {
      const { request } = (await options.backend.action("projectImports:presignPut", {
        moveId,
        key: object.key,
        bytes: object.bytes,
        sha256: object.sha256,
      })) as { request: SignedRequest };
      const source = await body();
      const payload =
        source instanceof Uint8Array
          ? new Uint8Array(source.buffer as ArrayBuffer, source.byteOffset, source.length)
          : (Readable.toWeb(Readable.from(source as AsyncIterable<Uint8Array>)) as ReadableStream);
      const response = await fetchImpl(request.url, {
        method: "PUT",
        headers: request.headers,
        body: payload,
        signal: AbortSignal.timeout(Math.max(MIN_TIMEOUT_MS, object.bytes / BYTES_PER_MS)),
        ...(source instanceof Uint8Array ? {} : { duplex: "half" }),
      } as RequestInit);
      await response.arrayBuffer().catch(() => undefined);
      if (response.ok) return "stored";
      if (response.status === 412) return "exists";
      if (refused(response.status)) throw refusal(response.status);
      throw new Error(`The object store answered ${response.status}.`);
    },

    async head(moveId, key): Promise<StoredObject | null> {
      const request = await signedRead(moveId, key, "HEAD");
      const response = await fetchImpl(request.url, {
        method: "HEAD",
        headers: request.headers,
        signal: AbortSignal.timeout(MIN_TIMEOUT_MS),
      });
      if (response.status === 404) return null;
      if (refused(response.status)) throw refusal(response.status);
      if (!response.ok) throw new Error(`The object store answered ${response.status}.`);
      return {
        bytes: Number(response.headers.get("content-length") ?? -1),
        sha256: checksumOf(response.headers.get("x-amz-checksum-sha256")),
      };
    },

    async get(moveId, key) {
      const request = await signedRead(moveId, key, "GET");
      const response = await fetchImpl(request.url, {
        method: "GET",
        headers: request.headers,
        signal: AbortSignal.timeout(MIN_TIMEOUT_MS * 5),
      });
      if (response.status === 404) {
        await response.arrayBuffer().catch(() => undefined);
        return null;
      }
      if (refused(response.status)) throw refusal(response.status);
      if (!response.ok) throw new Error(`The object store answered ${response.status}.`);
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}
