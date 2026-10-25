import { expect, test } from "vite-plus/test";

import { MAX_SSE_LINE_LENGTH, SseParser } from "./sse.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

function parseAll(chunks: (string | Uint8Array)[]) {
  const parser = new SseParser();
  const events = chunks.flatMap((chunk) =>
    parser.push(typeof chunk === "string" ? bytes(chunk) : chunk),
  );
  return [...events, ...parser.end()];
}

test("dispatches events on blank lines, with types and multi-line data", () => {
  expect(parseAll(['event: message_start\ndata: {"a":1}\n\ndata: one\ndata: two\n\n'])).toEqual([
    { event: "message_start", data: '{"a":1}' },
    { data: "one\ntwo" },
  ]);
});

test("the same events however the bytes are split, including inside a code point", () => {
  const text = "event: x\r\ndata: héllo\r\n\r\ndata: b\r\rdata:c\n\n";
  const encoded = bytes(text);
  const whole = parseAll([encoded]);
  for (let cut = 1; cut < encoded.length; cut += 1) {
    expect(parseAll([encoded.subarray(0, cut), encoded.subarray(cut)])).toEqual(whole);
  }
  expect(whole).toEqual([{ event: "x", data: "héllo" }, { data: "b" }, { data: "c" }]);
});

test("ignores comments, unknown fields, and events without data", () => {
  expect(parseAll([": keep-alive\nid: 7\nretry: 10\nevent: ping\n\nfield\ndata\n\n"])).toEqual([
    { data: "" },
  ]);
});

test("end() dispatches a final event with no trailing blank line", () => {
  expect(parseAll(["data: tail"])).toEqual([{ data: "tail" }]);
  expect(parseAll(["data: tail\n"])).toEqual([{ data: "tail" }]);
});

test("a line beyond the bound stops parsing without throwing", () => {
  const parser = new SseParser();
  expect(parser.push(bytes(`data: ${"x".repeat(MAX_SSE_LINE_LENGTH)}`))).toEqual([]);
  expect(parser.overflowed).toBe(true);
  expect(parser.push(bytes("\n\ndata: later\n\n"))).toEqual([]);
  expect(parser.end()).toEqual([]);
});

test("an overlong line after a line end in the same chunk also stops parsing", () => {
  const parser = new SseParser();
  expect(parser.push(bytes(`data: a\n\ndata: ${"x".repeat(MAX_SSE_LINE_LENGTH)}`))).toEqual([
    { data: "a" },
  ]);
  expect(parser.overflowed).toBe(true);
});

test("one long line in many chunks is assembled once", () => {
  const parser = new SseParser();
  parser.push(bytes("data: "));
  for (let index = 0; index < 100; index += 1)
    expect(parser.push(bytes("x".repeat(1000)))).toEqual([]);
  expect(parser.push(bytes("\n\n"))).toEqual([{ data: "x".repeat(100_000) }]);
});
