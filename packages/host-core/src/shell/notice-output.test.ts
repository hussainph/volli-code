import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { pemSecretSpans, redactPayloadSecrets } from "@volli/shared";
import { pendingNoticeSecretStart, SecretStore } from "../secrets/index";
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

/** The whole-buffer snapshot exactly as it was computed before VC-1083. */
function wholeSnapshot(raw: string, redact: (text: string) => string): string {
  const spans = pemSecretSpans(raw, true);
  let from = pendingNoticeSecretStart(raw);
  for (let i = spans.length - 1; i >= 0; i -= 1) {
    const span = spans[i]!;
    if (span.end === raw.length || (from !== null && span.end > from))
      from = from === null ? span.start : Math.min(from, span.start);
  }
  return from === null ? redact(raw) : `${redact(raw.slice(0, from))}[redacted]`;
}

/** The whole-snapshot watch exactly as it was before VC-1083. */
function wholeWatch(test: (line: string) => boolean, onMatch: (line: string) => void) {
  let previous = "";
  return (safe: string): void => {
    let common = 0;
    const limit = Math.min(previous.length, safe.length);
    while (common < limit && previous[common] === safe[common]) common += 1;
    if (common === safe.length && common === previous.length) return;
    previous = safe;
    const from = common === 0 ? 0 : safe.lastIndexOf("\n", common - 1) + 1;
    for (const rawLine of safe.slice(from).split("\n")) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (!test(line.slice(0, 1_000))) continue;
      onMatch(line);
      return;
    }
  };
}

const chunksOf = (...parts: string[]) => parts.map((part) => Buffer.from(part));

/**
 * Settled lines (VC-1083) must change nothing a reader can see: every
 * snapshot and every line the watch tests is compared with the whole-buffer
 * algorithm the pipe used before lines could settle, reproduced verbatim here.
 */
describe("settled notice lines", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  function credentialStore(values: Record<string, string>): SecretStore {
    const directory = mkdtempSync(join(tmpdir(), "notice-settle-"));
    directories.push(directory);
    const store = new SecretStore(join(directory, "credentials.enc"), {
      isEncryptionAvailable: () => false,
      encryptString: () => {
        throw new Error("session-only fixture");
      },
      decryptString: () => {
        throw new Error("session-only fixture");
      },
    });
    for (const [name, value] of Object.entries(values))
      store.put({ name, value, scope: "session", sessionId: "session-1" });
    return store;
  }

  interface Run {
    snapshots: string[];
    tested: string[];
    matches: string[];
    settled: number;
  }

  /** Feed `chunks` to a settling pipe and to the whole-buffer algorithm side by side. */
  function compare(
    chunks: readonly Buffer[],
    store: SecretStore | null,
    matches: (line: string) => boolean,
    between?: (index: number) => void,
  ): { settling: Run; whole: Run } {
    const redact = (text: string) =>
      redactPayloadSecrets(store === null ? text : store.redactPartial(text));
    const settling: Run = { snapshots: [], tested: [], matches: [], settled: 0 };
    const whole: Run = { snapshots: [], tested: [], matches: [], settled: 0 };
    const stream = new NoticeOutput(redact, 256_000, () => store?.redactionVersion ?? 0);
    const watch = new NoticeMatchWatch(
      (line) => (settling.tested.push(line), matches(line)),
      (line) => settling.matches.push(line),
      1_000,
    );
    const reference = wholeWatch(
      (line) => (whole.tested.push(line), matches(line)),
      (line) => whole.matches.push(line),
    );
    const decoder = new StringDecoder("utf8");
    let raw = "";
    chunks.forEach((chunk, index) => {
      between?.(index);
      stream.feed(chunk);
      raw += decoder.write(chunk);
      const view = stream.view()!;
      if (settling.matches.length === 0) watch.feedView(view);
      settling.settled = Math.max(settling.settled, view.settledCount);
      settling.snapshots.push(stream.snapshot());
      const safe = wholeSnapshot(raw, redact);
      if (whole.matches.length === 0) reference(safe);
      whole.snapshots.push(safe);
    });
    return { settling, whole };
  }

  const PREAMBLE = Array.from({ length: 40 }, (_, i) => `[vite] hmr update /src/file-${i}.tsx\n`);

  it.each([
    [
      "a Bearer scheme left open over blank lines",
      ["Bearer\n", "\n", "SYNTHETIC_CREDENTIAL\n"],
      "SYNTHETIC_CREDENTIAL",
    ],
    ["an Authorization header split at its colon", ["Authorization:\n", " basic QUJD\n"], "QUJD"],
    ["a quoted assignment running across lines", ["TOKEN='first\n", "second' ready\n"], "second"],
    ["a quote opened in prose before an assignment", ["it's\n", "TOKEN=abc'def ready\n"], "abc"],
    ["command basic auth whose colon arrives later", ["curl -u 'name\n", "x:y' ready\n"], "x:y"],
    [
      "a PEM block across chunks",
      ["-----BEGIN PRIVATE KEY-----\n", "BODY\n", "-----END PRIVATE KEY-----\nready\n"],
      "BODY",
    ],
    ["an escaped newline inside an assignment", ["TOKEN=abc\\\n", "def ready\n"], "def"],
    ["a marker-free assignment the gate later turns on", ["TO_KEN=abc\n", "ready token\n"], "abc"],
    ["a stored value split across chunks", ["ready hunter2-the-", "stored-value\n"], "hunter2"],
    ["a multiline stored value across lines", ["ready multi\n", "line-secret\n"], "line-secret"],
  ])("matches the whole-buffer algorithm for %s", (_name, parts, secret) => {
    const store = credentialStore({
      TOKEN: "hunter2-the-stored-value",
      MULTI: "multi\nline-secret",
    });
    const chunks = chunksOf(...PREAMBLE, ...parts, ...PREAMBLE);
    const { settling, whole } = compare(chunks, store, (line) => line.includes("NEVER"));
    expect(settling.snapshots).toEqual(whole.snapshots);
    expect(settling.tested).toEqual(whole.tested);
    // Lines settle up to the structure; whatever it reaches across stays whole.
    expect(settling.settled).toBeGreaterThanOrEqual(PREAMBLE.length);
    expect(settling.snapshots.at(-1)).not.toContain(secret);
  });

  it("settles nothing while a stored value could begin at any line's newline", () => {
    const store = credentialStore({ LEAD: "\nlead-secret" });
    const chunks = chunksOf(...PREAMBLE, "ready\n", "lead-secret\n", ...PREAMBLE);
    const { settling, whole } = compare(chunks, store, (line) => line.includes("NEVER"));
    expect(settling.snapshots).toEqual(whole.snapshots);
    expect(settling.tested).toEqual(whole.tested);
    expect(settling.settled).toBe(0);
    expect(settling.snapshots.at(-1)).not.toContain("lead-secret");
  });

  it("redoes settled lines once the credential owner learns a value they contain", () => {
    const store = credentialStore({ TOKEN: "hunter2-the-stored-value" });
    const chunks = chunksOf("boot\n", "late-learned-value ready\n", ...PREAMBLE, "more\n");
    const { settling, whole } = compare(
      chunks,
      store,
      (line) => line.startsWith("‹secret:"),
      (index) => {
        if (index === 20)
          store.put({
            name: "LATE",
            value: "late-learned-value",
            scope: "session",
            sessionId: "s",
          });
      },
    );
    expect(settling.snapshots).toEqual(whole.snapshots);
    expect(settling.tested).toEqual(whole.tested);
    expect(settling.settled).toBeGreaterThan(0);
    expect(settling.matches).toEqual(["‹secret: [redacted] ready"]);
  });

  it("agrees with the whole-buffer algorithm on random output split at random bytes", () => {
    // Mostly ordinary output, so lines do settle, laced with every
    // structure that can reach across a line or a chunk.
    const ordinary = ["ready", " ", "\n", "\n", "\r\n", "abc", "x=1", "🟢", "\t", "#", "(", ")"];
    const hazards = [
      "'",
      '"',
      "\\",
      "TOKEN=",
      "token",
      "key",
      "pwd=",
      "-u ",
      "--user=",
      "a:b",
      "Bearer",
      "Basic ",
      "authorization",
      ":",
      "Cookie: ",
      "; Path=/",
      "-----BEGIN A-----",
      "-----END A-----",
      "-----BEGIN ",
      "https://user:pw",
      "@host/x",
      "eyJ",
      ".def",
      ".ghi",
      "AKIA",
      "0123456789ABCDEF",
      "sk-",
      "ghp_",
      "hunter2-",
      "the-stored-value",
      "multi",
      "line-secret",
      "q'uoted",
      "|",
      "&",
      ";",
    ];
    let seed = 1083;
    // mulberry32: a small seeded generator, so a failure replays exactly.
    const random = (bound: number) => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4_294_967_296) * bound);
    };
    let settled = 0;
    for (let round = 0; round < 600; round += 1) {
      // Every third round has only the fixed shared redactor.
      const store =
        round % 3 === 0
          ? null
          : credentialStore({
              TOKEN: "hunter2-the-stored-value",
              MULTI: "multi\nline-secret",
              QUOTED: "q'uoted",
            });
      let text = "";
      const count = 20 + random(80);
      for (let i = 0; i < count; i += 1)
        text +=
          random(6) === 0 ? hazards[random(hazards.length)] : ordinary[random(ordinary.length)];
      const bytes = Buffer.from(text);
      const chunks: Buffer[] = [];
      for (let at = 0; at < bytes.length;) {
        const size = 1 + random(24);
        chunks.push(bytes.subarray(at, at + size));
        at += size;
      }
      const learnAt = random(2) === 0 ? random(chunks.length) : -1;
      const { settling, whole } = compare(
        chunks,
        store,
        (line) => line.endsWith("ready"),
        (index) => {
          if (index === learnAt)
            store?.put({ name: "LATE", value: "abc", scope: "session", sessionId: "s" });
        },
      );
      expect(settling.snapshots).toEqual(whole.snapshots);
      expect(settling.tested).toEqual(whole.tested);
      expect(settling.matches).toEqual(whole.matches);
      settled += settling.settled;
    }
    expect(settled).toBeGreaterThan(0);
  }, 60_000);

  it("redacts a bounded amount per chunk however much output is retained", () => {
    const store = credentialStore({ TOKEN: "hunter2-the-stored-value" });
    let redacted = 0;
    const stream = new NoticeOutput(
      (text) => {
        redacted += text.length;
        return redactPayloadSecrets(store.redactPartial(text));
      },
      256_000,
      () => store.redactionVersion,
    );
    const watch = new NoticeMatchWatch(
      () => false,
      () => {},
      1_000,
    );
    const perChunk: number[] = [];
    for (let i = 0; i < 3_000; i += 1) {
      redacted = 0;
      stream.feed(Buffer.from(`[vite] hmr update "/src/file-${i}.tsx" (it's x${i})\n`));
      watch.feedView(stream.view()!);
      perChunk.push(redacted);
    }
    // Roughly 3 x one ~50-char line, never the ~150 KB retained.
    expect(Math.max(...perChunk.slice(10))).toBeLessThan(1_000);
  });

  it("settles nothing a redactor cannot verify, without withholding the pipe", () => {
    const stream = new NoticeOutput(
      (text) => {
        if (text.endsWith("key")) throw new Error("synthetic verification failure");
        return redactPayloadSecrets(text);
      },
      256_000,
      () => 0,
    );
    stream.feed(Buffer.from("one\ntwo\n"));
    expect(stream.view()).toMatchObject({ settledCount: 0, tail: "one\ntwo\n" });
    expect(stream.withheld).toBe(false);
  });

  it("redoes a snapshot whose redaction changed the version under it", () => {
    let version = 0;
    let calls = 0;
    const stream = new NoticeOutput(
      (text) => {
        calls += 1;
        // The owner reads its values on first use, and they redact this.
        if (calls === 1) version += 1;
        return version === 0 ? text : text.replaceAll("late", "[late]");
      },
      256_000,
      () => version,
    );
    stream.feed(Buffer.from("late\nready\n"));
    expect(stream.snapshot()).toBe("[late]\nready\n");
    let changes = 0;
    const always = new NoticeOutput(
      (text) => {
        changes += 1;
        version += 1;
        return text;
      },
      256_000,
      () => version,
    );
    always.feed(Buffer.from("a\nb\n"));
    // Bounded: two settling passes, then one whole redaction.
    expect(always.snapshot()).toBe("a\nb\n");
    expect(changes).toBeLessThan(10);
  });

  it("redacts the whole context per chunk without a version, as before", () => {
    let redacted = 0;
    const stream = new NoticeOutput((text) => {
      redacted += text.length;
      return redactPayloadSecrets(text);
    }, 256_000);
    for (let i = 0; i < 100; i += 1) stream.feed(Buffer.from(`line ${i}\n`));
    redacted = 0;
    expect(stream.view()!.settledCount).toBe(0);
    expect(redacted).toBe(stream.snapshot().length);
  });
});
