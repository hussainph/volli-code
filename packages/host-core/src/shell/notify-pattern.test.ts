import { describe, expect, it } from "vite-plus/test";
import type { ShellNotifyPattern } from "@volli/shared";

import {
  compileNotifyPattern,
  SHELL_NOTIFY_LINE_MAX_CHARS,
  SHELL_NOTIFY_PATTERN_MAX_CHARS,
  SHELL_NOTIFY_REGEX_MAX_STATES,
} from "./notify-pattern";

function compile(pattern: string, regex = true): (line: string) => boolean {
  const result = compileNotifyPattern({ pattern, regex });
  expect(result.ok, result.ok ? undefined : result.reason).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  return result.test;
}

function refusal(pattern: string, regex = true): string {
  const result = compileNotifyPattern({ pattern, regex });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a refusal");
  return result.reason;
}

describe("bounded shell notice patterns", () => {
  it("keeps the portable shared type and the synchronous boolean API", () => {
    const input: ShellNotifyPattern = { pattern: "ready", regex: false };
    const result = compileNotifyPattern(input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.test("ready")).toBe(true);
  });

  it.each([
    ["FAIL \\d+ tests", "FAIL 123 tests", "FAIL no tests"],
    ["error|FAIL|panic", "process: panic", "process: ready"],
    ["listening on :\\d+", "server listening on :5174", "server listening on localhost"],
    ["(Compiled )?successfully", "Compiled successfully", "unsuccessful"],
    ["[+*]{2}", "a+*b", "a+b"],
    ["^ready$", "ready", "not ready"],
    ["^foo(bar|baz){1,2}$", "foobarbaz", "foobarqux"],
    ["ab{2,}c", "abbc", "abc"],
    ["a.+?b", "acb", "ab"],
    ["^a??b$", "ab", "aab"],
  ])("matches ordinary pattern %s", (pattern, hit, miss) => {
    const test = compile(pattern);
    expect(test(hit)).toBe(true);
    expect(test(miss)).toBe(false);
    expect(test(hit)).toBe(true); // There is no global lastIndex or other per-call state.
  });

  it("handles noncapturing groups, optional groups, and empty alternatives", () => {
    expect(compile("(?:Compiled )?successfully")("successfully")).toBe(true);
    expect(compile("^(ab|)$")("ab")).toBe(true);
    expect(compile("^(ab|)$")("")).toBe(true);
    expect(compile("^()$")("")).toBe(true);
    expect(compile("^()$")("x")).toBe(false);
  });

  it("supports classes, ranges, complements, whitespace and control/hex escapes", () => {
    const test = compile("^[a-zA-Z_][\\w.-]*\\s[\\d]{2}[^a-c]$");
    expect(test("Build_42.x\t19!")).toBe(true);
    expect(test("Build_42.x\u200319!")).toBe(true);
    expect(test("Build_42.x\t19b")).toBe(false);
    expect(compile("^\\D\\W\\S$")("a!x")).toBe(true);
    expect(compile("^\\D\\W\\S$")("1!x")).toBe(false);
    expect(compile("^[\\D\\d]$")("9")).toBe(true);
    expect(compile("^[^\\D]$")("9")).toBe(true);
    expect(compile("^[^\\D]$")("x")).toBe(false);
    expect(compile("^[^]$")("\n")).toBe(true);
    expect(compile("[]")("x")).toBe(false);
    expect(compile("^[a-cb-d]$")("d")).toBe(true);
    expect(compile("^[-a]$")("-")).toBe(true);
    expect(compile("^[a-]$")("-")).toBe(true);
    expect(compile("^\\x41\\u0042[\\b]\\t\\v\\f\\r\\n$")("AB\b\t\v\f\r\n")).toBe(true);
  });

  it("uses UTF-16 units, dot excludes line terminators, and anchors are strict", () => {
    expect(compile("^.$")("é")).toBe(true);
    expect(compile("^.$")("😀")).toBe(false);
    expect(compile("^..$")("😀")).toBe(true);
    for (const terminator of ["\r", "\n", "\u2028", "\u2029"]) {
      expect(compile(".")(terminator)).toBe(false);
      expect(compile("^a$")(`a${terminator}`)).toBe(false);
    }
    expect(compile("^ready")("not ready")).toBe(false);
    expect(compile("ready$")("ready now")).toBe(false);
    expect(compile("a^b")("ab")).toBe(false);
  });

  it("treats metacharacters literally when regex is false or they are escaped", () => {
    const metacharacters = "\\^$.*+?()[]{}|-/";
    const escaped = [...metacharacters].map((character) => `\\${character}`).join("");
    expect(compile(`^${escaped}$`)(metacharacters)).toBe(true);
    expect(compile(metacharacters, false)(`prefix ${metacharacters} suffix`)).toBe(true);
    expect(compile("(a+)+$", false)("aaa")).toBe(false);
    expect(compile("(a+)+$", false)("literal (a+)+$")).toBe(true);
    expect(compile("[+*]", false)("+*")).toBe(false);
    expect(compile("[+*]", false)("[+*]")).toBe(true);
  });

  it.each([
    ["(", "unterminated group"],
    ["a)", "unexpected ')'"],
    ["[abc", "unterminated character class"],
    ["[a-", "range endpoint"],
    ["[z-a]", "reversed"],
    ["[a-\\d]", "literal endpoints"],
    ["\\", "trailing backslash"],
    ["\\x0z", "invalid hex escape"],
    ["\\u00", "invalid hex escape"],
    ["a{", "decimal count"],
    ["a{,2}", "decimal count"],
    ["a{2,1}", "smaller"],
    ["a{1,2", "unterminated bounded repeat"],
    ["a{1,x}", "decimal count"],
    ["*a", "unexpected '*'"],
    ["a**", "multiple quantifiers"],
    ["a*+", "multiple quantifiers"],
    ["a???", "multiple quantifiers"],
    ["^+", "anchor cannot be repeated"],
    ["(?=a)", "unsupported group syntax"],
    ["(?!a)", "unsupported group syntax"],
    ["(?<=a)", "unsupported group syntax"],
    ["(?<!a)", "unsupported group syntax"],
    ["(?<name>a)", "unsupported group syntax"],
    ["(?i:a)", "unsupported group syntax"],
    ["(a)\\1", "unsupported escape"],
    ["\\k<name>", "unsupported escape"],
    ["\\bready\\b", "word boundaries"],
    ["\\p{Letter}", "unsupported escape"],
    ["\\q", "unsupported escape"],
    ["\\0", "unsupported escape"],
    ["a}", "escape literal metacharacters"],
    ["a]", "escape literal metacharacters"],
  ])("plainly refuses malformed/unsupported syntax %s", (pattern, reason) => {
    expect(refusal(pattern)).toContain(reason);
  });

  it("enforces the pattern cap for both literal and regex input", () => {
    for (const regex of [true, false]) {
      expect(compile("a".repeat(SHELL_NOTIFY_PATTERN_MAX_CHARS), regex)("a".repeat(200))).toBe(
        true,
      );
      expect(refusal("a".repeat(SHELL_NOTIFY_PATTERN_MAX_CHARS + 1), regex)).toContain(
        "bound is 200",
      );
      expect(refusal("", regex)).toContain("empty");
      expect(refusal("a\nb", regex)).toContain("newline");
      expect(refusal("a\rb", regex)).toContain("newline");
    }
  });

  it("bounds input even when called without the host, for literals and regexes", () => {
    const prefix = "a".repeat(SHELL_NOTIFY_LINE_MAX_CHARS);
    const huge = `${prefix}hit${"b".repeat(1_000_000)}`;
    for (const regex of [true, false]) {
      expect(compile("hit", regex)(huge)).toBe(false);
      expect(compile("hit", regex)(`${prefix.slice(3)}hit`)).toBe(true);
      expect(compile("hit", regex)(`${prefix.slice(2)}hit`)).toBe(false);
    }
    // Anchors refer to the bounded prefix, not text we deliberately do not examine.
    expect(compile("^a+$")(huge)).toBe(true);
    expect(compile("^a+$")(`${prefix.slice(1)}😀`)).toBe(false);
  });

  it("bounds fully expanded state count, including alternatives and accepting state", () => {
    const copies = SHELL_NOTIFY_REGEX_MAX_STATES - 3; // ^, $, and accepting state.
    const test = compile(`^a{${copies}}$`);
    expect(test("a".repeat(copies))).toBe(true);
    expect(test("a".repeat(copies - 1))).toBe(false);
    expect(refusal(`^a{${copies + 1}}$`)).toContain("512-state bound");
    expect(refusal("(ab{10}){50}")).toContain("512-state bound");
    expect(refusal("(?:a|aa){200}")).toContain("512-state bound");
    expect(refusal("a{9999999999999999999999999999}")).toContain("repeat count");
  });

  it("reads arbitrarily zero-padded counts completely instead of treating them as literals", () => {
    const test = compile(`^a{${"0".repeat(180)}9}$`);
    expect(test("a".repeat(9))).toBe(true);
    expect(test("a".repeat(8))).toBe(false);
    expect(refusal(`a{${"0".repeat(160)}513}`)).toContain("repeat count");
    expect(refusal(`a{${"9".repeat(180)}}`)).toContain("repeat count");
  });

  it("bounds compilation of nested zero-state repeats, not just emitted states", () => {
    const pattern = `^${"(".repeat(12)}a{0}${"){512}".repeat(12)}$`;
    const test = compile(pattern);
    expect(test("")).toBe(true);
    expect(test("a")).toBe(false);
    expect(compile("^(?:(){512})*$")("")).toBe(true);
  });

  it("safely accepts formerly heuristic-refused nested/branching/open repeats", () => {
    for (const pattern of ["(a+)+$", "(a|aa)*b", "(?:a?)*b", "(?:a*)*b", ".*a.*b.*c"]) {
      const test = compile(pattern);
      expect(test("a".repeat(SHELL_NOTIFY_LINE_MAX_CHARS - 1) + "!")).toBe(false);
    }
    expect(compile("(a+)+$")("a".repeat(999))).toBe(true);
    expect(compile("(a|aa)*b")("a".repeat(998) + "b")).toBe(true);
    expect(compile("(?:a?)*b")("b")).toBe(true);
    expect(compile(".*a.*b.*c")("abc")).toBe(true);
  });

  it.each([`^${"a{0,9}".repeat(20)}$`, "(?:a|aa){00000000000000000000000100}$"])(
    "matches adversarial bounded repeats without backtracking: %s",
    (pattern) => {
      const test = compile(pattern);
      const miss = "a".repeat(180) + "b";
      const hit = "a".repeat(180);
      // A regression tripwire, not the safety proof: the old engine could spend
      // >500ms on just ONE such line; the algorithm above visits <= S*(L+1) states.
      // So budget EACH line against that documented 500ms (VC-656): one shared
      // 500ms wall across all 40 matches measured 639ms under coverage on a
      // loaded runner, while each line cost ~16ms there — and a backtracking
      // engine still trips this on its first line, not only in aggregate.
      let slowest = 0;
      for (let i = 0; i < 20; i += 1) {
        let started = performance.now();
        expect(test(miss)).toBe(false);
        slowest = Math.max(slowest, performance.now() - started);
        started = performance.now();
        expect(test(hit)).toBe(true);
        slowest = Math.max(slowest, performance.now() - started);
      }
      expect(slowest, `slowest single line took ${slowest.toFixed(1)}ms`).toBeLessThan(500);
    },
  );

  it("agrees with native regex boolean results on a small supported-grammar corpus", () => {
    // Keep the reference engine's corpus unambiguous too: adversarial and
    // nested repetition is tested ONLY against the bounded matcher above.
    const atoms = ["a", "b", ".", "[ab]", "[^a]", "\\d", "\\w", "\\s", "(?:ab)"];
    const patterns = atoms.flatMap((atom) => [atom, `${atom}?`, `${atom}*`, `^${atom}{0,2}b$`]);
    patterns.push("^(a|b)+$", "^a{2,}b?$", "a|", "()", "^[a-cb-d]+$", "(Compiled )?successfully");
    const lines = [""];
    let frontier = [""];
    for (let length = 1; length <= 4; length += 1) {
      frontier = frontier.flatMap((prefix) =>
        ["a", "b", "0", " "].map((suffix) => prefix + suffix),
      );
      lines.push(...frontier);
    }
    for (const pattern of patterns) {
      const test = compile(pattern);
      const native = new RegExp(pattern);
      for (const line of lines)
        expect(test(line), `${pattern} on ${JSON.stringify(line)}`).toBe(native.test(line));
    }
  });
});
