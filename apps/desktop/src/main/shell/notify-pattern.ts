/**
 * The pattern a `shell_start` may ask to be told about (VC-495): a literal, or
 * a regular expression, bounded before it ever runs.
 *
 * Why a regex needs a guard at all. The host runs it in the main process, on
 * every line a shell prints, and the shell's output is whatever the command
 * and the repository feed it — an attacker's text as often as not. A backtracking
 * engine given `(a+)+$` and a line of `a`s followed by a `b` does not return in
 * this lifetime, and main has one thread. So a pattern is refused up front
 * when it has the shapes that blow up, and matched only against a bounded
 * line ({@link SHELL_NOTIFY_LINE_MAX_CHARS}).
 *
 * What is refused, and what is deliberately not:
 *
 * - a repeated group that already repeats or branches inside itself — `(a+)+`,
 *   `(a|aa)*` — the exponential shape;
 * - a back-reference, which defeats every other bound;
 * - more than {@link SHELL_NOTIFY_MAX_OPEN_REPEATS} open-ended repeats in one
 *   pattern (`.*a.*b.*c`), the polynomial shape;
 * - a pattern longer than {@link SHELL_NOTIFY_PATTERN_MAX_CHARS}.
 *
 * This is a conservative scan, not a proof: it will refuse a few patterns that
 * are in fact safe, and says so in words the model can act on — use a literal,
 * or a simpler expression. Anything it lets through still only ever sees one
 * line of at most {@link SHELL_NOTIFY_LINE_MAX_CHARS} characters.
 */

export const SHELL_NOTIFY_PATTERN_MAX_CHARS = 200;
/** How much of one line a pattern is tested against. */
export const SHELL_NOTIFY_LINE_MAX_CHARS = 1_000;
/** `*`, `+` and `{n,}` — repeats with no upper bound — a regex may hold. */
export const SHELL_NOTIFY_MAX_OPEN_REPEATS = 2;

export interface ShellNotifyPattern {
  pattern: string;
  /** True when `pattern` is a regular expression; false when it is a literal. */
  regex: boolean;
}

export type CompiledNotifyPattern =
  | { ok: true; test: (line: string) => boolean }
  | { ok: false; reason: string };

export function compileNotifyPattern(input: ShellNotifyPattern): CompiledNotifyPattern {
  const { pattern, regex } = input;
  if (pattern.length === 0) return { ok: false, reason: "the pattern is empty" };
  if (pattern.length > SHELL_NOTIFY_PATTERN_MAX_CHARS) {
    return {
      ok: false,
      reason: `the pattern is ${pattern.length} characters; the bound is ${SHELL_NOTIFY_PATTERN_MAX_CHARS}`,
    };
  }
  if (!regex) {
    if (/[\r\n]/.test(pattern)) {
      return {
        ok: false,
        reason: "output is matched one line at a time, so a pattern cannot contain a newline",
      };
    }
    return { ok: true, test: (line) => line.includes(pattern) };
  }
  let compiled: RegExp;
  try {
    compiled = new RegExp(pattern);
  } catch (error) {
    return {
      ok: false,
      reason: `the regular expression does not compile (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  const unsafe = unsafeRegexReason(pattern);
  if (unsafe !== null) return { ok: false, reason: unsafe };
  return { ok: true, test: (line) => compiled.test(line) };
}

interface Group {
  /** Some atom inside it carries a quantifier. */
  repeated: boolean;
  /** It branches with `|`. */
  alternates: boolean;
}

interface Quantifier {
  length: number;
  /** It can repeat its atom more than once. */
  repeats: boolean;
  /** It has no practical upper bound. */
  open: boolean;
}

function readQuantifier(source: string, at: number): Quantifier | null {
  const c = source[at];
  if (c === "*" || c === "+") return { length: 1, repeats: true, open: true };
  if (c === "?") return { length: 1, repeats: false, open: false };
  if (c !== "{") return null;
  const braces = /^\{(\d+)(?:(,)(\d*))?\}/.exec(source.slice(at, at + 24));
  if (braces === null) return null;
  const min = Number(braces[1]);
  const max = braces[2] === undefined ? min : braces[3] === "" ? Infinity : Number(braces[3]);
  return { length: braces[0].length, repeats: max > 1, open: max >= 10 };
}

/** The first reason `source` is refused, or `null`. `source` already compiles. */
function unsafeRegexReason(source: string): string | null {
  const stack: Group[] = [];
  let openRepeats = 0;
  /** The group that just closed, while a quantifier may still apply to it. */
  let closed: Group | null = null;
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    if (c === "\\") {
      const next = source[i + 1];
      if (next !== undefined && (/[1-9]/.test(next) || next === "k")) {
        return "it holds a back-reference, which cannot be bounded";
      }
      i += 2;
      closed = null;
    } else if (c === "[") {
      i += 1;
      while (i < source.length && source[i] !== "]") i += source[i] === "\\" ? 2 : 1;
      i += 1;
      closed = null;
    } else if (c === "(") {
      stack.push({ repeated: false, alternates: false });
      i += 1;
      // `(?:`, `(?=`, `(?!`, `(?<=`, `(?<!`, `(?<name>`: the `?` is syntax, not a repeat.
      if (source[i] === "?") {
        i += 1;
        if (source[i] === "<" && source[i + 1] !== "=" && source[i + 1] !== "!") {
          while (i < source.length && source[i] !== ">") i += 1;
          i += 1;
        } else if (source[i] === "<") {
          i += 2;
        } else {
          i += 1;
        }
      }
      closed = null;
    } else if (c === ")") {
      const group = stack.pop() ?? null;
      const parent = stack.at(-1);
      if (group !== null && parent !== undefined) {
        if (group.repeated) parent.repeated = true;
        if (group.alternates) parent.alternates = true;
      }
      closed = group;
      i += 1;
    } else if (c === "|") {
      const top = stack.at(-1);
      if (top !== undefined) top.alternates = true;
      closed = null;
      i += 1;
    } else {
      const quantifier = readQuantifier(source, i);
      if (quantifier === null) {
        closed = null;
        i += 1;
        continue;
      }
      i += quantifier.length;
      // A lazy or possessive modifier is not a second repeat.
      if (source[i] === "?") i += 1;
      if (quantifier.repeats) {
        if (closed !== null && (closed.repeated || closed.alternates)) {
          return "it repeats a group that already repeats or branches inside itself, which can take exponential time";
        }
        if (quantifier.open) openRepeats += 1;
      }
      const top = stack.at(-1);
      if (top !== undefined) top.repeated = true;
      closed = null;
    }
  }
  if (openRepeats > SHELL_NOTIFY_MAX_OPEN_REPEATS) {
    return `it holds ${openRepeats} open-ended repeats (*, + or {n,}); the bound is ${SHELL_NOTIFY_MAX_OPEN_REPEATS}`;
  }
  return null;
}
