/** Run after the desktop build: uses its actual emitted worker and chunks. */
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { test } from "node:test";
import sharp from "sharp";
import { createWorkerSourceIconDecoder } from "../../../packages/agent-runtime/src/web/source-icon-decoder.ts";

const entry = new URL("../dist-electron/source-icon-worker.cjs", import.meta.url);

test("the desktop's shipped source-icon-worker.cjs decodes through the production parent gate", async () => {
  // Missing packaging is a failure, not a skipped test or a substitute bundle.
  await access(entry);
  const decode = createWorkerSourceIconDecoder(entry);
  const bytes = await sharp({
    create: { width: 128, height: 64, channels: 4, background: "#c07a42" },
  })
    .png()
    .toBuffer();
  const result = await decode({ bytes, mime: "image/png" }, new AbortController().signal);
  assert.notEqual(result, null, "The shipped decoder failed or exceeded its one-second deadline");
  const metadata = await sharp(result).metadata();
  assert.equal(metadata.format, "png");
  assert.equal(metadata.width, 64);
  assert.equal(metadata.height, 32);
  assert.ok(result.byteLength <= 64 * 1024);
});

test("the shipped entry remains an optional fallback on cancellation or invalid content", async () => {
  await access(entry);
  const decode = createWorkerSourceIconDecoder(entry);
  const stopped = new AbortController();
  stopped.abort();
  assert.equal(
    await decode({ bytes: new Uint8Array([1]), mime: "image/png" }, stopped.signal),
    null,
  );
  assert.equal(
    await decode({ bytes: new Uint8Array([1]), mime: "image/png" }, new AbortController().signal),
    null,
  );
});
