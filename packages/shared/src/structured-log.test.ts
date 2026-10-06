import { describe, expect, it } from "vite-plus/test";

import {
  hexOfBytes,
  isLogLevel,
  isSensitiveLogKey,
  isSpanId,
  isTraceId,
  LOG_FIELD_BOUNDS,
  LOG_LEVEL_RANK,
  LOG_LEVELS,
  LOG_REDACTED,
  logLevelFrom,
  logLevelPasses,
  readTraceContext,
  redactLogFields,
  redactLogText,
  redactLogValue,
} from "./structured-log";

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN = "00f067aa0ba902b7";

describe("log levels", () => {
  it("ranks debug < info < warn < error", () => {
    expect(LOG_LEVELS.map((level) => LOG_LEVEL_RANK[level])).toEqual([10, 20, 30, 40]);
    expect(logLevelPasses("warn", "info")).toBe(true);
    expect(logLevelPasses("debug", "info")).toBe(false);
    expect(logLevelPasses("info", "info")).toBe(true);
  });

  it("reads a level from the environment, or the fallback", () => {
    expect(logLevelFrom("debug")).toBe("debug");
    expect(logLevelFrom(undefined)).toBe("info");
    expect(logLevelFrom("loud")).toBe("info");
    expect(logLevelFrom("nope", "warn")).toBe("warn");
    expect(isLogLevel("error")).toBe(true);
    expect(isLogLevel(4)).toBe(false);
  });
});

describe("trace context", () => {
  it("accepts W3C-shaped trace and span ids, never all-zero or upper case", () => {
    expect(isTraceId(TRACE)).toBe(true);
    expect(isTraceId(TRACE.toUpperCase())).toBe(false);
    expect(isTraceId("0".repeat(32))).toBe(false);
    expect(isTraceId(`${TRACE}0`)).toBe(false);
    expect(isTraceId(7)).toBe(false);
    expect(isSpanId(SPAN)).toBe(true);
    expect(isSpanId("0".repeat(16))).toBe(false);
    expect(isSpanId(TRACE)).toBe(false);
  });

  it("reads a peer's trace only when both ids are well formed", () => {
    expect(readTraceContext({ traceId: TRACE, spanId: SPAN, extra: 1 })).toEqual({
      traceId: TRACE,
      spanId: SPAN,
    });
    expect(readTraceContext({ traceId: TRACE })).toBeNull();
    expect(readTraceContext({ traceId: "x", spanId: SPAN })).toBeNull();
    expect(readTraceContext(null)).toBeNull();
    expect(readTraceContext("trace")).toBeNull();
  });

  it("writes bytes as lowercase hex", () => {
    expect(hexOfBytes(new Uint8Array([0, 15, 255]))).toBe("000fff");
  });
});

describe("redaction (a merge gate: no secret, key or credential reaches a line)", () => {
  it("redacts fields named like credentials, recursively", () => {
    const out = redactLogFields({
      token: "abc",
      apiKey: "k-123",
      key: "raw-key-bytes",
      privateKey: "pem",
      hostKeys: ["a", "b"],
      password: "hunter2",
      passphrase: "open sesame",
      authorization: "Bearer xyz",
      Cookie: "sid=1",
      credential: { kind: "device", value: "v" },
      clientSecret: "s",
      nested: { deeper: { refreshToken: "r", sessionId: "s-1" } },
      list: [{ secret: "x" }, { ok: 1 }],
    });
    expect(out).toEqual({
      token: LOG_REDACTED,
      apiKey: LOG_REDACTED,
      key: LOG_REDACTED,
      privateKey: LOG_REDACTED,
      hostKeys: LOG_REDACTED,
      password: LOG_REDACTED,
      passphrase: LOG_REDACTED,
      authorization: LOG_REDACTED,
      Cookie: LOG_REDACTED,
      credential: LOG_REDACTED,
      clientSecret: LOG_REDACTED,
      nested: { deeper: { refreshToken: LOG_REDACTED, sessionId: "s-1" } },
      list: [{ secret: LOG_REDACTED }, { ok: 1 }],
    });
    expect(JSON.stringify(out)).not.toMatch(/abc|k-123|hunter2|sesame|xyz|sid=1|raw-key/u);
  });

  it("keeps counts under a sensitive name: a count is not a secret", () => {
    expect(redactLogFields({ inputTokens: 120, tokenRefreshed: true, keyCount: null })).toEqual({
      inputTokens: 120,
      tokenRefreshed: true,
      keyCount: null,
    });
  });

  it("scrubs credential-shaped text from any string, the message included", () => {
    const leaked =
      "push failed: https://user:ghp_abcdefghijklmnop@github.com/x Authorization: Bearer eyJa.eyJb.sig sk-live_123";
    const scrubbed = redactLogText(leaked);
    expect(scrubbed).not.toContain("ghp_abcdefghijklmnop");
    expect(scrubbed).not.toContain("eyJa.eyJb.sig");
    expect(scrubbed).not.toContain("sk-live_123");
    expect(scrubbed).toContain("push failed");
    expect(redactLogFields({ reason: leaked })["reason"]).toBe(scrubbed);
  });

  it("removes a PEM block wherever it appears", () => {
    const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAB3Nza\n-----END OPENSSH PRIVATE KEY-----";
    expect(redactLogText(`key: ${pem}`)).not.toContain("AAAAB3Nza");
  });

  it("writes an error as its name, scrubbed message and code; never its cause", () => {
    const error = Object.assign(new TypeError("token=abc123 refused"), {
      code: "EAUTH",
      cause: new Error("secret cause"),
    });
    const out = redactLogValue(error) as Record<string, unknown>;
    expect(out).toEqual({ name: "TypeError", message: expect.any(String), code: "EAUTH" });
    expect(String(out["message"])).not.toContain("abc123");
    expect(JSON.stringify(out)).not.toContain("secret cause");
    expect(redactLogValue(new Error("plain"))).toEqual({ name: "Error", message: "plain" });
    expect(redactLogValue(Object.assign(new Error("n"), { code: 7 }))).toEqual({
      name: "Error",
      message: "n",
      code: 7,
    });
  });

  it("makes every value JSON", () => {
    expect(redactLogValue(undefined)).toBeNull();
    expect(redactLogValue(Number.NaN)).toBe("NaN");
    expect(redactLogValue(Infinity)).toBe("Infinity");
    expect(redactLogValue(10n)).toBe("10");
    expect(redactLogValue(Symbol("s"))).toBe("[symbol]");
    expect(redactLogValue(() => 1)).toBe("[function]");
    expect(redactLogValue(new Date("2026-10-07T00:00:00.000Z"))).toBe("2026-10-07T00:00:00.000Z");
    expect(redactLogValue(new Date(Number.NaN))).toBe("Invalid Date");
    expect(redactLogValue(new Map([["a", 1]]))).toEqual({ a: 1 });
    expect(redactLogValue(new Set([1, 2]))).toEqual([1, 2]);
    expect(redactLogFields({ skipped: undefined, kept: 1 })).toEqual({ kept: 1 });
  });

  it("bounds an accidental payload: strings, depth, arrays and keys", () => {
    const long = "x".repeat(LOG_FIELD_BOUNDS.maxString + 10);
    expect(redactLogText(long)).toHaveLength(LOG_FIELD_BOUNDS.maxString);
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let level = 0; level < 10; level += 1) deep = { deep };
    expect(JSON.stringify(redactLogValue(deep))).toContain("[object]");
    expect(JSON.stringify(redactLogValue([[[[[[[1]]]]]]]))).toContain("[array]");
    const many = Array.from({ length: LOG_FIELD_BOUNDS.maxArray + 3 }, (_, index) => index);
    const items = redactLogValue(many) as unknown[];
    expect(items).toHaveLength(LOG_FIELD_BOUNDS.maxArray + 1);
    expect(items.at(-1)).toBe("[+3 more]");
    const wide = Object.fromEntries(
      Array.from({ length: LOG_FIELD_BOUNDS.maxKeys + 2 }, (_, index) => [`f${index}`, index]),
    );
    const kept = redactLogFields(wide);
    expect(Object.keys(kept)).toHaveLength(LOG_FIELD_BOUNDS.maxKeys + 1);
    expect(kept["…"]).toBe("[+2 more]");
  });

  it("names the sensitive keys a log adds to the shared rule", () => {
    for (const name of ["cookie", "setCookie", "key", "sshKeys", "passphrase", "access_token"]) {
      expect(isSensitiveLogKey(name)).toBe(true);
    }
    for (const name of ["sessionId", "traceId", "path", "component", "count"]) {
      expect(isSensitiveLogKey(name)).toBe(false);
    }
  });
});

describe("the renderer's forwarded lines", () => {
  it("reads a well-formed entry and drops a malformed trace", async () => {
    const { readRendererLogEntry } = await import("./structured-log");
    expect(readRendererLogEntry({ level: "warn", area: "console", msg: "m" })).toEqual({
      level: "warn",
      area: "console",
      msg: "m",
    });
    expect(
      readRendererLogEntry({
        level: "info",
        area: "host-link",
        msg: "m",
        fields: { to: "ready" },
        traceId: TRACE,
      }),
    ).toEqual({
      level: "info",
      area: "host-link",
      msg: "m",
      fields: { to: "ready" },
      traceId: TRACE,
    });
    expect(
      readRendererLogEntry({ level: "error", area: "window", msg: "m", traceId: "nope" }),
    ).toEqual({
      level: "error",
      area: "window",
      msg: "m",
    });
  });

  it("refuses anything else", async () => {
    const { readRendererLogEntry } = await import("./structured-log");
    for (const value of [
      null,
      [],
      "line",
      { level: "loud", area: "a", msg: "m" },
      { level: "warn", area: "Bad Area", msg: "m" },
      { level: "warn", area: 3, msg: "m" },
      { level: "warn", area: "a", msg: 3 },
      { level: "warn", area: "a", msg: "m", fields: [] },
      { level: "warn", area: "a", msg: "m", fields: null },
      { level: "warn", area: "a", msg: "m", fields: "x" },
    ]) {
      expect(readRendererLogEntry(value)).toBeNull();
    }
  });
});
