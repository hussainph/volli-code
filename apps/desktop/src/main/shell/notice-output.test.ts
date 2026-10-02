import { describe, expect, it } from "vite-plus/test";
import { redactPayloadSecrets } from "@volli/shared";
import { NoticeMatchWatch, NoticeOutput } from "./notice-output";

const output = (redact = redactPayloadSecrets, bytes = 256_000) => new NoticeOutput(redact, bytes);

describe("notice output context", () => {
  it("redacts a complete multiline credential before selecting its lines", () => {
    const secret = "Ready ALMOND123\nWALNUT456";
    const stream = output((text) => redactPayloadSecrets(text.replaceAll(secret, "[redacted]")));
    stream.feed(Buffer.from(`log\n${secret}\nready\n`));
    expect(stream.snapshot()).toBe("log\n[redacted]\nready\n");
  });

  it("withholds PEM bodies across chunks, including an unfinished block at exit", () => {
    const stream = output();
    stream.feed(Buffer.from("safe\n-----BEGIN PRIVATE KEY-----\nMII_SYNTHETIC"));
    expect(stream.snapshot()).toBe("safe\n[redacted]");
    stream.feed(Buffer.from("_PRIVATE_BODY\n-----END PRIVATE KEY-----\nready"));
    expect(stream.snapshot()).toBe("safe\n[redacted]\nready");
    const unfinished = output();
    unfinished.feed(Buffer.from("-----BEGIN PRIVATE KEY-----\nMII_SECRET_BODY"));
    unfinished.finish();
    expect(unfinished.snapshot()).toBe("[redacted]");
  });

  it("keeps an incomplete overlapping PEM hidden beyond an outer block's end", () => {
    const stream = output();
    stream.feed(
      Buffer.from(
        "safe\n-----BEGIN A-----\nOUTER_BODY\n-----BEGIN B-----\n-----END A-----\nOPAQUE_BODY\n",
      ),
    );
    expect(stream.snapshot()).toBe("safe\n[redacted]");
    stream.feed(Buffer.from("-----END B-----\nready\n"));
    expect(stream.snapshot()).toBe("safe\n[redacted]\nready\n");
  });

  it("decodes independently fragmented UTF-8 without cross-pipe corruption", () => {
    const stdout = output();
    const stderr = output();
    const bytes = Buffer.from("🟢 listening on :1");
    stdout.feed(bytes.subarray(0, 2));
    stderr.feed(Buffer.from("diagnostic\n"));
    expect(stdout.snapshot()).toBe("");
    stdout.feed(bytes.subarray(2));
    stdout.finish();
    expect(stdout.snapshot()).toBe("🟢 listening on :1");
    expect(stderr.snapshot()).toBe("diagnostic\n");
  });

  it("fails closed instead of evicting the beginning of raw redaction context", () => {
    const stream = output(redactPayloadSecrets, 20);
    stream.feed(Buffer.from("-----BEGIN PRIVATE KEY-----\nMII_BODY"));
    stream.feed(Buffer.from("tail fragment\n"));
    stream.finish();
    expect(stream.exceeded).toBe(true);
    expect(stream.snapshot()).toBe(
      "[Output withheld: secure redaction context exceeded its bound.]\n",
    );
    expect(stream.snapshot()).not.toContain("MII_BODY");
    expect(stream.snapshot()).not.toContain("tail fragment");
  });

  it.each(["Bearer \n", "Basic\n"])("retains %s across newline chunks", (prefix) => {
    const stream = output();
    stream.feed(Buffer.from(prefix));
    stream.snapshot();
    stream.feed(Buffer.from("SYNTHETIC_CREDENTIAL\n"));
    expect(stream.snapshot()).not.toContain("SYNTHETIC_CREDENTIAL");
    expect(stream.snapshot()).toContain("[redacted]");
  });

  it.each([
    ["ready https://alice:opaque-value", "@example.test/path\n", "opaque-value"],
    ["ready eyJheader.payload", ".signature\n", "eyJheader.payload"],
    ["ready AKIA012345", "6789ABCDEF\n", "AKIA012345"],
  ])("never quotes an unfinished shared credential from %s", (first, rest, secret) => {
    const stream = output();
    stream.feed(Buffer.from(first));
    expect(stream.snapshot()).not.toContain(secret);
    expect(stream.snapshot()).toContain("ready");
    stream.feed(Buffer.from(rest));
    expect(stream.snapshot()).not.toContain(secret);
  });

  it("finds an unfinished PEM opening before assignment redaction can erase it", () => {
    const stream = output();
    stream.feed(Buffer.from("TOKEN=-----BEGIN PRIVATE KEY-----\n"));
    expect(stream.snapshot()).not.toContain("BEGIN");
    stream.feed(Buffer.from("SYNTHETIC_BODY\n"));
    expect(stream.snapshot()).not.toContain("SYNTHETIC_BODY");
    stream.feed(Buffer.from("-----END PRIVATE KEY-----\nready\n"));
    expect(stream.snapshot()).not.toContain("SYNTHETIC_BODY");
    expect(stream.snapshot()).toContain("ready\n");
  });

  it("cannot recover lost redaction context after a transient redactor failure", () => {
    let fail = true;
    const stream = output((text) => {
      if (fail) throw new Error("synthetic failure");
      return redactPayloadSecrets(text);
    });
    stream.feed(Buffer.from("secret\n"));
    expect(stream.snapshot()).toContain("credential redaction failed");
    fail = false;
    stream.feed(Buffer.from("remaining fragment\n"));
    expect(stream.withheld).toBe(true);
    expect(stream.snapshot()).toBe("[Output withheld: credential redaction failed.]\n");
  });

  it("fails closed when the credential owner cannot redact", () => {
    const stream = output(() => {
      throw new Error("synthetic credential");
    });
    stream.feed(Buffer.from("secret"));
    expect(stream.snapshot()).toBe("[Output withheld: credential redaction failed.]\n");
  });
});

describe("matching sanitized snapshots", () => {
  it("matches a partial line before a newline and does not manufacture cross-pipe lines", () => {
    const lines: string[] = [];
    const stdout = new NoticeMatchWatch(
      (line) => line.includes("listening on"),
      (line) => lines.push(line),
      1_000,
    );
    const stderr = new NoticeMatchWatch(
      (line) => line.includes("listening on"),
      (line) => lines.push(line),
      1_000,
    );
    stdout.feed("listen");
    stderr.feed("diagnostic\n");
    expect(lines).toEqual([]);
    stdout.feed("listening on :1");
    expect(lines).toEqual(["listening on :1"]);
    stdout.feed("listening on :1");
    expect(lines).toHaveLength(1);
  });

  it("rescans a redacted multiline suffix and bounds regex input", () => {
    const tested: string[] = [];
    const matches: string[] = [];
    const watch = new NoticeMatchWatch(
      (line) => {
        tested.push(line);
        return line === "ready";
      },
      (line) => matches.push(line),
      5,
    );
    watch.feed("old\n[redacted]");
    watch.feed("old\n[redacted]\nready with a long tail");
    expect(matches).toEqual(["ready with a long tail"]);
    expect(tested.every((line) => [...line].length <= 5)).toBe(true);
  });

  it("strips CR from complete lines and handles replacement at the first character", () => {
    const lines: string[] = [];
    const watch = new NoticeMatchWatch(
      (line) => line === "ready",
      (line) => lines.push(line),
      1_000,
    );
    watch.feed("not ready\r\n");
    watch.feed("ready\r\n");
    expect(lines).toEqual(["ready"]);
  });
});
