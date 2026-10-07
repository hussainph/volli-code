import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  HOST_TRACE_FIELD,
  isTraceIdShaped,
  mintHostTrace,
  nextHostSpan,
  withHostTrace,
} from "./trace";

afterEach(() => vi.restoreAllMocks());

describe("request tracing on the wire", () => {
  it("mints W3C-shaped trace and span ids", () => {
    const trace = mintHostTrace();
    expect(trace.traceId).toMatch(/^[0-9a-f]{32}$/u);
    expect(trace.spanId).toMatch(/^[0-9a-f]{16}$/u);
    expect(isTraceIdShaped(trace.traceId)).toBe(true);
    expect(isTraceIdShaped(trace.spanId)).toBe(false);
    expect(isTraceIdShaped(7)).toBe(false);
  });

  it("keeps the trace and changes the span for the next request", () => {
    const trace = mintHostTrace();
    const next = nextHostSpan(trace);
    expect(next.traceId).toBe(trace.traceId);
    expect(next.spanId).not.toBe(trace.spanId);
  });

  it("never mints an all-zero id", () => {
    const real = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
    let first = true;
    vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(((
      array: Uint8Array<ArrayBuffer>,
    ) => {
      if (first) {
        first = false;
        return array.fill(0);
      }
      return real(array);
    }) as typeof globalThis.crypto.getRandomValues);
    expect(mintHostTrace().traceId).not.toBe("0".repeat(32));
  });

  it("sets the field beside the frame's id, and never replaces one already there", () => {
    const trace = mintHostTrace();
    const frame = withHostTrace({ id: 1, method: "query" }, trace);
    expect(frame).toStrictEqual({ id: 1, method: "query", [HOST_TRACE_FIELD]: trace });
    expect(withHostTrace(frame, mintHostTrace())).toBe(frame);
  });
});
