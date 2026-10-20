import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { blobUrl } from "@volli/shared";

import { blobProtocolResponse } from "./blob-protocol";
import { writeBlob } from "./blob-store";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "volli-blob-protocol-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function deps(mime?: string) {
  return { blobsRoot: root, lookupMime: () => mime };
}

describe("blobProtocolResponse", () => {
  it("serves stored bytes with the recorded media type", async () => {
    const hash = writeBlob(root, BYTES);
    const response = blobProtocolResponse(deps("image/png"), blobUrl(hash));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
  });

  it("serves the slash-normalized URL Electron delivers for a standard scheme", async () => {
    const hash = writeBlob(root, BYTES);
    const response = blobProtocolResponse(deps("image/png"), `volli-blob://${hash}/`);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
  });

  it("falls back to octet-stream when no row names the hash", () => {
    const hash = writeBlob(root, BYTES);
    expect(blobProtocolResponse(deps(), blobUrl(hash)).headers.get("Content-Type")).toBe(
      "application/octet-stream",
    );
  });

  it("answers 400 for a URL that is not a blob URL", () => {
    expect(blobProtocolResponse(deps(), "https://example.com/x.png").status).toBe(400);
  });

  it("answers 400 for a blob URL whose host is not a hash", () => {
    expect(blobProtocolResponse(deps(), "volli-blob://not-a-hash/").status).toBe(400);
  });

  it("answers 404 when the store has no such bytes", () => {
    expect(blobProtocolResponse(deps(), blobUrl("a".repeat(64))).status).toBe(404);
  });

  it("locks every response down to a CSP that permits nothing", () => {
    const hash = writeBlob(root, BYTES);
    for (const url of [blobUrl(hash), "https://example.com", blobUrl("b".repeat(64))]) {
      const response = blobProtocolResponse(deps("image/png"), url);
      expect(response.headers.get("Content-Security-Policy")).toBe("default-src 'none'");
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    }
  });

  it("marks bytes immutable, since a content-addressed URL cannot go stale", () => {
    const hash = writeBlob(root, BYTES);
    expect(
      blobProtocolResponse(deps("image/png"), blobUrl(hash)).headers.get("Cache-Control"),
    ).toBe("public, max-age=31536000, immutable");
  });
});
