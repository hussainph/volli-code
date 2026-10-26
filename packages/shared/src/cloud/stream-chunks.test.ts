import { describe, expect, test } from "vite-plus/test";

import {
  STREAM_CHUNK_BASELINE_MAX_BYTES,
  STREAM_CHUNK_MAX_BYTES,
  parseStreamChunkOps,
} from "./stream-chunks";

const reset = { op: "reset", message: { id: "m", role: "assistant", parts: [] } };
const append = { op: "part.append", key: "t", text: "hi" };

/** `[first, an append]` padded to exactly `bytes` of JSON. */
function sized(bytes: number, first: object): string {
  const base = JSON.stringify([first, { op: "part.append", key: "t", text: "" }]);
  return JSON.stringify([
    first,
    { op: "part.append", key: "t", text: "x".repeat(bytes - base.length) },
  ]);
}

describe("parseStreamChunkOps", () => {
  test("accepts a baseline that starts with a reset and an increment that does not", () => {
    expect(parseStreamChunkOps(JSON.stringify([reset, append]), true)).toEqual({
      ok: true,
      ops: [reset, append],
    });
    expect(parseStreamChunkOps(JSON.stringify([append, reset]), false)).toEqual({
      ok: true,
      ops: [append, reset],
    });
  });

  test("a baseline must start with a reset, and a chunk that starts with one is a baseline", () => {
    expect(parseStreamChunkOps(JSON.stringify([append]), true)).toEqual({
      ok: false,
      reason: "a baseline starts with a reset",
    });
    expect(parseStreamChunkOps(JSON.stringify([reset]), false)).toEqual({
      ok: false,
      reason: "a reset starts a baseline",
    });
  });

  test("refuses text that is not a non-empty array of known ops", () => {
    expect(parseStreamChunkOps("{", false)).toMatchObject({
      ok: false,
      reason: "ops are not JSON",
    });
    expect(parseStreamChunkOps("[]", false)).toMatchObject({
      reason: "ops must be a non-empty array",
    });
    expect(parseStreamChunkOps('{"op":"reset"}', true)).toMatchObject({
      reason: "ops must be a non-empty array",
    });
    for (const entry of [null, 1, [append]]) {
      expect(parseStreamChunkOps(JSON.stringify([entry]), false)).toMatchObject({
        reason: "every op must be an object",
      });
    }
    expect(parseStreamChunkOps(JSON.stringify([{ op: "part.rewrite" }]), false)).toMatchObject({
      reason: "unknown op",
    });
    expect(parseStreamChunkOps(JSON.stringify([{ text: "x" }]), false)).toMatchObject({
      reason: "unknown op",
    });
  });

  test("an increment is capped at 16 KB and a baseline at 64 KB", () => {
    expect(parseStreamChunkOps(sized(STREAM_CHUNK_MAX_BYTES, append), false).ok).toBe(true);
    expect(parseStreamChunkOps(sized(STREAM_CHUNK_MAX_BYTES + 1, append), false)).toMatchObject({
      reason: `ops exceed ${STREAM_CHUNK_MAX_BYTES} bytes`,
    });
    expect(parseStreamChunkOps(sized(STREAM_CHUNK_BASELINE_MAX_BYTES, reset), true).ok).toBe(true);
    expect(
      parseStreamChunkOps(sized(STREAM_CHUNK_BASELINE_MAX_BYTES + 1, reset), true),
    ).toMatchObject({
      reason: `ops exceed ${STREAM_CHUNK_BASELINE_MAX_BYTES} bytes`,
    });
  });
});
