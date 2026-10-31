import { describe, expect, it } from "vite-plus/test";
import {
  CredentialRedactionError,
  CredentialRedactionStream,
  ExactValueByteRedactor,
  type CredentialStreamStep,
  type CredentialStreamStepper,
} from "./credential-stream-redaction";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytes = (text: string): Uint8Array => encoder.encode(text);
const marker = (name: string): string => `‹secret:${name}›`;

/**
 * The whole-string exact redactor's contract, restated naively: every
 * occurrence, overlapping occurrences merged into one span, and the marker of
 * the longest value at the span's start.
 */
function reference(text: string, values: ReadonlyMap<string, string>): string {
  const lengths = Array.from({ length: text.length }, () => 0);
  for (const value of values.keys()) {
    for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at + 1)) {
      lengths[at] = Math.max(lengths[at]!, value.length);
    }
  }
  let out = "";
  let copied = 0;
  for (let at = 0; at < text.length; at += 1) {
    if (lengths[at] === 0) continue;
    let end = at + lengths[at]!;
    for (let next = at + 1; next < end; next += 1) end = Math.max(end, next + lengths[next]!);
    out += text.slice(copied, at) + marker(values.get(text.slice(at, at + lengths[at]!))!);
    copied = end;
    at = end - 1;
  }
  return out + text.slice(copied);
}

function redactorFor(values: ReadonlyMap<string, string>): ExactValueByteRedactor {
  return new ExactValueByteRedactor([...values].map(([value, name]) => [value, marker(name)]));
}

function streamed(
  input: Uint8Array,
  cuts: readonly number[],
  step: CredentialStreamStepper,
  options?: { maxRetainedBytes?: number },
): { output: Uint8Array; maxRetained: number } {
  let maxRetained = 0;
  const observed: CredentialStreamStepper = (window, from, final) => {
    const answer = step(window, from, final);
    maxRetained = Math.max(maxRetained, window.length - answer.consumed + answer.context);
    return answer;
  };
  const stream = new CredentialRedactionStream(observed, options);
  const parts: Uint8Array[] = [];
  let at = 0;
  for (const cut of [...cuts, input.length]) {
    parts.push(stream.push(input.subarray(at, cut)));
    at = cut;
  }
  parts.push(stream.end());
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return { output, maxRetained };
}

/** Deterministic, so a failing case is reproducible from its seed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("ExactValueByteRedactor", () => {
  it("passes every byte through, invalid UTF-8 included, when there is nothing to redact", () => {
    const binary = new Uint8Array([0xff, 0xfe, 0x00, 0xc3, 0x41, 0x80]);
    const empty = new ExactValueByteRedactor([["", marker("EMPTY")]]);
    const step = empty.step(binary, 2, false);
    expect(step).toEqual({ bytes: binary.subarray(2), consumed: binary.length, context: 0 });
    expect(streamed(binary, [1, 4], (w, f, final) => empty.step(w, f, final)).output).toEqual(
      binary,
    );
  });

  it("keeps binary bytes around a redacted value instead of decoding them", () => {
    const redactor = redactorFor(new Map([["tok", "T"]]));
    const input = new Uint8Array([0xff, ...bytes("tok"), 0xc3]);
    const { output } = streamed(input, [2], (w, f, final) => redactor.step(w, f, final));
    expect(output).toEqual(new Uint8Array([0xff, ...bytes(marker("T")), 0xc3]));
  });

  it("refuses an offset outside the window", () => {
    const redactor = redactorFor(new Map([["a", "A"]]));
    for (const from of [-1, 4, 0.5]) {
      expect(() => redactor.step(bytes("abc"), from, false)).toThrow(RangeError);
    }
  });

  it("emits nothing again from the context, even a value wholly inside it", () => {
    const redactor = redactorFor(new Map([["abc", "A"]]));
    const step = redactor.step(bytes("abcxyz"), 4, false);
    expect(decoder.decode(step.bytes)).toBe("yz");
    expect(step).toMatchObject({ consumed: 6, context: 0 });
  });

  it("redacts a value split at every byte boundary, multibyte characters included", () => {
    const value = "sk-é€😀-tail";
    const values = new Map([[value, "API_TOKEN"]]);
    const redactor = redactorFor(values);
    const input = bytes(`before ${value} after`);
    const expected = bytes(`before ${marker("API_TOKEN")} after`);
    for (let cut = 0; cut <= input.length; cut += 1) {
      const { output } = streamed(input, [cut], (w, f, final) => redactor.step(w, f, final));
      expect(output).toEqual(expected);
    }
    // One byte at a time, every boundary at once.
    const singles = Array.from({ length: input.length }, (_, index) => index + 1);
    expect(streamed(input, singles, (w, f, final) => redactor.step(w, f, final)).output).toEqual(
      expected,
    );
  });

  it("withholds an undecided prefix and releases it unchanged when the stream ends", () => {
    const redactor = redactorFor(new Map([["secret-value", "S"]]));
    const stream = new CredentialRedactionStream((w, f, final) => redactor.step(w, f, final));
    expect(decoder.decode(stream.push(bytes("ok secret-va")))).toBe("ok ");
    // Exact matching only: a prefix that never completes is not a credential.
    expect(decoder.decode(stream.end())).toBe("secret-va");
  });

  it("decides the longest value starting at a span before marking it", () => {
    const values = new Map([
      ["abc", "SHORT"],
      ["abcdef", "LONG"],
    ]);
    const redactor = redactorFor(values);
    const step = (w: Uint8Array, f: number, final: boolean) => redactor.step(w, f, final);
    expect(decoder.decode(streamed(bytes("xabcdefy"), [4], step).output)).toBe(
      `x${marker("LONG")}y`,
    );
    expect(decoder.decode(streamed(bytes("xabcdy"), [4], step).output)).toBe(
      `x${marker("SHORT")}dy`,
    );
  });

  it("merges overlapping and nested values into one protected span across chunks", () => {
    const values = new Map([
      ["abc", "A"],
      ["bcd", "B"],
      ["c", "C"],
    ]);
    const redactor = redactorFor(values);
    const step = (w: Uint8Array, f: number, final: boolean) => redactor.step(w, f, final);
    for (let cut = 0; cut <= 6; cut += 1) {
      expect(decoder.decode(streamed(bytes("xabcdy"), [cut], step).output)).toBe(
        reference("xabcdy", values),
      );
    }
  });

  it("stays bounded on a long chain of self-overlapping matches", () => {
    const values = new Map([["aa", "RUN"]]);
    const redactor = redactorFor(values);
    const text = `x${"a".repeat(10_000)}y`;
    const cuts = Array.from({ length: 1000 }, (_, index) => (index + 1) * 10);
    const { output, maxRetained } = streamed(bytes(text), cuts, (w, f, final) =>
      redactor.step(w, f, final),
    );
    expect(decoder.decode(output)).toBe(reference(text, values));
    expect(decoder.decode(output)).toBe(`x${marker("RUN")}y`);
    expect(maxRetained).toBeLessThanOrEqual(2);
  });

  it("matches the whole-string redactor for random text, values and chunking", () => {
    const alphabet = ["a", "b", "é", "€", "😀", "\n"];
    for (let seed = 1; seed <= 400; seed += 1) {
      const next = random(seed);
      const pick = (length: number): string =>
        Array.from({ length }, () => alphabet[Math.floor(next() * alphabet.length)]).join("");
      const values = new Map<string, string>();
      const count = 1 + Math.floor(next() * 3);
      for (let index = 0; values.size < count && index < 20; index += 1) {
        const value = pick(1 + Math.floor(next() * 4));
        if (!values.has(value)) values.set(value, `V${values.size}`);
      }
      const text = pick(Math.floor(next() * 60));
      const input = bytes(text);
      const cuts: number[] = [];
      for (let at = 0; at < input.length; at += 1) if (next() < 0.3) cuts.push(at);
      const redactor = redactorFor(values);
      const { output, maxRetained } = streamed(input, cuts, (w, f, final) =>
        redactor.step(w, f, final),
      );
      const longest = Math.max(...[...values.keys()].map((value) => bytes(value).length));
      expect({ seed, output: decoder.decode(output) }).toEqual({
        seed,
        output: reference(text, values),
      });
      // At most one value's context plus one undecided prefix.
      expect(maxRetained).toBeLessThanOrEqual(2 * (longest - 1));
    }
  });

  it("reuses its scratch between steps without carrying a match from one into the next", () => {
    const redactor = new ExactValueByteRedactor([["secret", marker("S")]]);
    const step = (text: string) => decoder.decode(redactor.step(bytes(text), 0, true).bytes);
    // A long window first, so later short ones reuse (and must clear) its scratch.
    expect(step(`${"x".repeat(100)}secret`)).toBe(`${"x".repeat(100)}${marker("S")}`);
    expect(step("plain")).toBe("plain");
    expect(step("secret!")).toBe(`${marker("S")}!`);
    // A larger window than any before grows it; one past what is kept has its own.
    expect(step(`${"y".repeat(1000)}secret`)).toBe(`${"y".repeat(1000)}${marker("S")}`);
    const huge = `${"z".repeat(4 * 1024 * 1024)}secret`;
    expect(step(huge)).toBe(`${"z".repeat(4 * 1024 * 1024)}${marker("S")}`);
    expect(step("a secret")).toBe(`a ${marker("S")}`);
  });

  it("hides the rest of a value added after its first bytes were written", () => {
    let redactor = redactorFor(new Map());
    const stream = new CredentialRedactionStream((w, f, final) => redactor.step(w, f, final));
    const parts = [decoder.decode(stream.push(bytes("x".repeat(2000) + "tok-")))];
    redactor = redactorFor(new Map([["tok-value", "NEW"]]));
    parts.push(decoder.decode(stream.push(bytes("value done"))));
    parts.push(decoder.decode(stream.end()));
    expect(parts).toEqual(["x".repeat(2000) + "tok-", " done", ""]);
    // Beyond the bounded lookbehind, a value begun earlier cannot be recognised.
    redactor = redactorFor(new Map());
    const far = new CredentialRedactionStream((w, f, final) => redactor.step(w, f, final));
    const long = "long-" + "y".repeat(1100);
    far.push(bytes(long));
    redactor = redactorFor(new Map([[`${long}-tail`, "FAR"]]));
    expect(decoder.decode(far.push(bytes("-tail"))) + decoder.decode(far.end())).toBe("-tail");
  });

  it("applies a value added mid-stream to every byte not yet decided", () => {
    let redactor = redactorFor(new Map([["nexus", "OLD"]]));
    const stream = new CredentialRedactionStream((w, f, final) => redactor.step(w, f, final));
    // `ne` may begin the known value, so it is still undecided when NEW arrives.
    const parts = [decoder.decode(stream.push(bytes("new-token ne")))];
    redactor = redactorFor(
      new Map([
        ["nexus", "OLD"],
        ["new-token", "NEW"],
      ]),
    );
    parts.push(decoder.decode(stream.push(bytes("w-token nexus"))));
    parts.push(decoder.decode(stream.end()));
    // The first occurrence was decided before the value was known; the held
    // prefix and everything after the addition are redacted with it.
    expect(parts).toEqual(["new-token ", `${marker("NEW")} ${marker("OLD")}`, ""]);
  });
});

const passthrough: CredentialStreamStepper = (window, from) => ({
  bytes: window.subarray(from),
  consumed: window.length,
  context: 0,
});

describe("CredentialRedactionStream", () => {
  it("returns nothing for an empty chunk without asking the redactor", () => {
    let calls = 0;
    const stream = new CredentialRedactionStream((window, from, final) => {
      calls += 1;
      return passthrough(window, from, final);
    });
    expect(stream.push(new Uint8Array(0))).toHaveLength(0);
    expect(calls).toBe(0);
    expect(stream.end()).toHaveLength(0);
    expect(calls).toBe(1);
  });

  it("copies what it retains, so the caller's chunk is not kept or mutated", () => {
    const redactor = redactorFor(new Map([["abcd", "K"]]));
    const stream = new CredentialRedactionStream((w, f, final) => redactor.step(w, f, final));
    const chunk = bytes("xxab");
    expect(decoder.decode(stream.push(chunk))).toBe("xx");
    chunk.fill(0);
    expect(decoder.decode(stream.push(bytes("cd")))).toBe(marker("K"));
    expect(stream.end()).toHaveLength(0);
  });

  it("fails closed with a fixed message when the redactor throws, and stays failed", () => {
    const stream = new CredentialRedactionStream(() => {
      throw new Error("raw secret-value in the cause");
    });
    let thrown: unknown;
    try {
      stream.push(bytes("secret-value"));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CredentialRedactionError);
    expect((thrown as Error).message).toBe("Credential redaction failed.");
    expect((thrown as Error).cause).toBeUndefined();
    expect(() => stream.push(bytes("more"))).toThrow(CredentialRedactionError);
    expect(() => stream.end()).toThrow(CredentialRedactionError);
  });

  it.each<[string, (window: Uint8Array, from: number, final: boolean) => unknown]>([
    ["no answer", () => undefined],
    ["text instead of bytes", (w) => ({ bytes: "x", consumed: w.length, context: 0 })],
    ["a missing offset", () => ({ bytes: new Uint8Array(0), context: 0 })],
    ["a missing context", (w) => ({ bytes: new Uint8Array(0), consumed: w.length })],
    ["a fractional offset", () => ({ bytes: new Uint8Array(0), consumed: 0.5, context: 0 })],
    [
      "a fractional context",
      (w) => ({ bytes: new Uint8Array(0), consumed: w.length, context: 0.5 }),
    ],
    [
      "an offset past the window",
      (w) => ({ bytes: new Uint8Array(0), consumed: w.length + 1, context: 0 }),
    ],
    [
      "a held tail at the end",
      (_w, _f, final) => ({ bytes: new Uint8Array(0), consumed: final ? 1 : 0, context: 0 }),
    ],
    ["a negative context", (w) => ({ bytes: new Uint8Array(0), consumed: w.length, context: -1 })],
    ["a context past the offset", () => ({ bytes: new Uint8Array(0), consumed: 1, context: 2 })],
  ])("fails closed on a malformed answer: %s", (_name, answer) => {
    const stream = new CredentialRedactionStream(answer as CredentialStreamStepper);
    expect(() => {
      stream.push(bytes("abc"));
      stream.end();
    }).toThrow(CredentialRedactionError);
    expect(() => stream.end()).toThrow(CredentialRedactionError);
  });

  it("fails closed rather than taking back decided bytes", () => {
    let calls = 0;
    const stream = new CredentialRedactionStream((window) => {
      calls += 1;
      // First keep one byte of context, then claim to have decided less than it.
      return calls === 1
        ? { bytes: window.subarray(0, 2), consumed: 2, context: 1 }
        : { bytes: new Uint8Array(0), consumed: 0, context: 0 };
    });
    expect(decoder.decode(stream.push(bytes("ab")))).toBe("ab");
    expect(() => stream.push(bytes("c"))).toThrow(CredentialRedactionError);
  });

  it("fails closed rather than retaining more than its bound", () => {
    const redactor = redactorFor(new Map([["x".repeat(64), "LONG"]]));
    const step = (w: Uint8Array, f: number, final: boolean) => redactor.step(w, f, final);
    expect(() => streamed(bytes("x".repeat(40)), [], step, { maxRetainedBytes: 32 })).toThrow(
      CredentialRedactionError,
    );
  });

  it("refuses use after the stream has ended", () => {
    const stream = new CredentialRedactionStream(passthrough);
    expect(decoder.decode(stream.push(bytes("done")))).toBe("done");
    expect(stream.end()).toHaveLength(0);
    expect(() => stream.push(bytes("late"))).toThrow(CredentialRedactionError);
  });

  it("hands the redactor the retained context as read-only lookbehind", () => {
    const calls: Array<{ window: string; from: number; final: boolean }> = [];
    const answers: CredentialStreamStep[] = [
      { bytes: bytes("abc"), consumed: 3, context: 1 },
      { bytes: bytes("d"), consumed: 4, context: 0 },
      { bytes: new Uint8Array(0), consumed: 4, context: 0 },
    ];
    const stream = new CredentialRedactionStream((window, from, final) => {
      calls.push({ window: decoder.decode(window), from, final });
      return answers[calls.length - 1]!;
    });
    stream.push(bytes("abc"));
    stream.push(bytes("d"));
    stream.end();
    expect(calls).toEqual([
      { window: "abc", from: 0, final: false },
      // The step's one byte of context, widened to the bounded written lookbehind.
      { window: "abcd", from: 3, final: false },
      { window: "abcd", from: 4, final: true },
    ]);
  });
});
