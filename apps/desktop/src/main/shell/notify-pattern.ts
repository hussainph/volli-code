import type { ShellNotifyPattern } from "@volli/shared";

export type { ShellNotifyPattern } from "@volli/shared";

export const SHELL_NOTIFY_PATTERN_MAX_CHARS = 200;
/** Only this prefix of a line is examined, in UTF-16 code units. */
export const SHELL_NOTIFY_LINE_MAX_CHARS = 1_000;
/** Includes the accepting state and every expanded bounded repeat. */
export const SHELL_NOTIFY_REGEX_MAX_STATES = 512;

export type CompiledNotifyPattern =
  | { ok: true; test: (line: string) => boolean }
  | { ok: false; reason: string };

/**
 * Synchronous matching on main must never run an attacker-supplied expression
 * in JavaScript's backtracking engine. This is a Thompson NFA, not a ReDoS
 * heuristic: at each input position each state is visited at most once,
 * including epsilon cycles and the newly injected unanchored search start.
 *
 * Supported: literals, dot, classes/ranges/negation, \d/\s/\w and their
 * complements, escaped metacharacters and control/hex escapes, ^/$, alternation,
 * plain/noncapturing groups, *, +, ?, {n}, {n,}, {n,m}. Lazy modifiers have
 * the same boolean result and are accepted. Anchors mean strict start/end of
 * the bounded prefix; there are no flags or capture results. Lookaround,
 * backreferences, word boundaries, named groups and other escapes are refused.
 *
 * P <= 200 source units, S <= 512 expanded states, L <= 1000 input units.
 * Compilation checks subtree state costs BEFORE expanding repeats (and skips
 * zero-state subtrees), so even nested huge/empty repeats cannot explode the
 * compiler. Matching uses O(S) working space and O((L+1)*S*log(P+1)) work:
 * at most 512 * 1001 state visits, with at most two edges per state. Classes
 * use binary search over normalized intervals (at most 11 comparisons for
 * P <= 200). No retry from every possible substring and no
 * backtracking. Both literal and regex callers enforce the input bound here,
 * independently of the shell host's line handling.
 */
export function compileNotifyPattern(input: ShellNotifyPattern): CompiledNotifyPattern {
  const { pattern, regex } = input;
  if (pattern.length === 0) return { ok: false, reason: "the pattern is empty" };
  if (pattern.length > SHELL_NOTIFY_PATTERN_MAX_CHARS) {
    return {
      ok: false,
      reason: `the pattern is ${pattern.length} characters; the bound is ${SHELL_NOTIFY_PATTERN_MAX_CHARS}`,
    };
  }
  if (pattern.includes("\r") || pattern.includes("\n")) {
    return {
      ok: false,
      reason: "output is matched one line at a time, so a pattern cannot contain a newline",
    };
  }
  if (!regex) {
    return {
      ok: true,
      test: (line) => line.slice(0, SHELL_NOTIFY_LINE_MAX_CHARS).includes(pattern),
    };
  }
  try {
    const expression = new PatternParser(pattern).parse();
    const { states, start } = buildNfa(expression);
    return {
      ok: true,
      test: (line) => testNfa(states, start, line.slice(0, SHELL_NOTIFY_LINE_MAX_CHARS)),
    };
  } catch (error) {
    return {
      ok: false,
      reason: `the regular expression is refused (${error instanceof Error ? error.message : String(error)})`,
    };
  }
}

type Range = readonly [number, number];
type Ranges = readonly Range[];

const DIGIT: Ranges = [[48, 57]];
const WORD: Ranges = [
  [48, 57],
  [65, 90],
  [95, 95],
  [97, 122],
];
// ECMAScript whitespace, not locale-dependent or ASCII-only.
const SPACE: Ranges = [
  [9, 13],
  [32, 32],
  [160, 160],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x2028, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
  [0xfeff, 0xfeff],
];
const DOT = complement([
  [10, 10],
  [13, 13],
  [0x2028, 0x2029],
]);
const ESCAPE_CLASSES: Readonly<Record<string, Ranges>> = {
  d: DIGIT,
  D: complement(DIGIT),
  w: WORD,
  W: complement(WORD),
  s: SPACE,
  S: complement(SPACE),
};
const CONTROL_ESCAPES: Readonly<Record<string, number>> = {
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
};

type Expression = { cost: number } & (
  | { kind: "empty" }
  | { kind: "char"; ranges: Ranges }
  | { kind: "start" | "end" }
  | { kind: "sequence" | "alternate"; children: Expression[] }
  | { kind: "repeat"; child: Expression; min: number; max: number | null }
);

/** Reserve one state for acceptance; arithmetic is bounded before expansion. */
function checkedCost(cost: number): number {
  if (cost >= SHELL_NOTIFY_REGEX_MAX_STATES) {
    throw new Error(
      `the expanded expression exceeds the ${SHELL_NOTIFY_REGEX_MAX_STATES}-state bound`,
    );
  }
  return cost;
}

class PatternParser {
  private at = 0;

  constructor(private readonly source: string) {}

  parse(): Expression {
    const result = this.alternation();
    if (this.at !== this.source.length) throw new Error(`unexpected ')' at ${this.at}`);
    return result;
  }

  private alternation(): Expression {
    const children = [this.sequence()];
    while (this.source[this.at] === "|") {
      this.at += 1;
      children.push(this.sequence());
    }
    if (children.length === 1) return children[0]!;
    return {
      kind: "alternate",
      children,
      cost: checkedCost(children.reduce((sum, child) => sum + child.cost, children.length - 1)),
    };
  }

  private sequence(): Expression {
    const children: Expression[] = [];
    while (this.at < this.source.length && !")|".includes(this.source[this.at]!)) {
      children.push(this.repetition());
    }
    if (children.length === 0) return { kind: "empty", cost: 0 };
    if (children.length === 1) return children[0]!;
    return {
      kind: "sequence",
      children,
      cost: checkedCost(children.reduce((sum, child) => sum + child.cost, 0)),
    };
  }

  private repetition(): Expression {
    const child = this.atom();
    const token = this.source[this.at];
    let min: number;
    let max: number | null;
    switch (token) {
      case "*":
        min = 0;
        max = null;
        this.at += 1;
        break;
      case "+":
        min = 1;
        max = null;
        this.at += 1;
        break;
      case "?":
        min = 0;
        max = 1;
        this.at += 1;
        break;
      case "{":
        this.at += 1;
        min = this.count();
        max = min;
        if (this.source[this.at] === ",") {
          this.at += 1;
          max = this.source[this.at] === "}" ? null : this.count();
        }
        if (this.source[this.at] !== "}") throw new Error("unterminated bounded repeat");
        this.at += 1;
        if (max !== null && max < min)
          throw new Error("repeat maximum is smaller than its minimum");
        break;
      default:
        return child;
    }
    if (child.kind === "start" || child.kind === "end")
      throw new Error("an anchor cannot be repeated");
    // Greediness affects captures/order, neither of which a boolean matcher returns.
    if (this.source[this.at] === "?") this.at += 1;
    if ("*+?{".includes(this.source[this.at] ?? "\0"))
      throw new Error("multiple quantifiers on one atom");
    const cost = max === null ? (min + 1) * child.cost + 1 : max * child.cost + (max - min);
    return { kind: "repeat", child, min, max, cost: checkedCost(cost) };
  }

  /** Read the WHOLE integer; leading zeroes never hide a quantifier. */
  private count(): number {
    const start = this.at;
    let value = 0;
    while (isDigit(this.source[this.at])) {
      value = value * 10 + Number(this.source[this.at]);
      this.at += 1;
      if (value > SHELL_NOTIFY_REGEX_MAX_STATES) {
        throw new Error(`a repeat count exceeds the ${SHELL_NOTIFY_REGEX_MAX_STATES}-state bound`);
      }
    }
    if (this.at === start) throw new Error("a bounded repeat needs a decimal count");
    return value;
  }

  private atom(): Expression {
    const token = this.source[this.at++]!;
    switch (token) {
      case "(": {
        if (this.source[this.at] === "?") {
          if (this.source[this.at + 1] !== ":") {
            throw new Error(
              "unsupported group syntax; use plain (...) or noncapturing (?:...) groups",
            );
          }
          this.at += 2;
        }
        const group = this.alternation();
        if (this.source[this.at] !== ")") throw new Error("unterminated group");
        this.at += 1;
        return group;
      }
      case "[":
        return { kind: "char", ranges: this.characterClass(), cost: 1 };
      case "\\":
        return { kind: "char", ranges: this.escape(false), cost: 1 };
      case ".":
        return { kind: "char", ranges: DOT, cost: 1 };
      case "^":
        return { kind: "start", cost: 1 };
      case "$":
        return { kind: "end", cost: 1 };
      case "*":
      case "+":
      case "?":
      case "{":
      case "}":
      case "]":
        throw new Error(`unexpected '${token}'; escape literal metacharacters`);
      default:
        return { kind: "char", ranges: singleton(token.charCodeAt(0)), cost: 1 };
    }
  }

  private characterClass(): Ranges {
    const negate = this.source[this.at] === "^";
    if (negate) this.at += 1;
    const ranges: Range[] = [];
    while (this.at < this.source.length && this.source[this.at] !== "]") {
      const first = this.classUnit();
      if (this.source[this.at] === "-" && this.source[this.at + 1] !== "]") {
        this.at += 1;
        const last = this.classUnit();
        if (
          first.length !== 1 ||
          last.length !== 1 ||
          first[0]![0] !== first[0]![1] ||
          last[0]![0] !== last[0]![1]
        ) {
          throw new Error("a character-class range needs two literal endpoints");
        }
        if (first[0]![0] > last[0]![0]) throw new Error("a character-class range is reversed");
        ranges.push([first[0]![0], last[0]![0]]);
      } else {
        ranges.push(...first);
      }
    }
    if (this.source[this.at] !== "]") throw new Error("unterminated character class");
    this.at += 1;
    const normalized = normalize(ranges);
    return negate ? complement(normalized) : normalized;
  }

  private classUnit(): Ranges {
    const token = this.source[this.at++];
    if (token === undefined || token === "]")
      throw new Error("missing character-class range endpoint");
    return token === "\\" ? this.escape(true) : singleton(token.charCodeAt(0));
  }

  private escape(inClass: boolean): Ranges {
    const token = this.source[this.at++];
    if (token === undefined) throw new Error("trailing backslash");
    // Own-key checks keep names such as 'constructor' out of these tables.
    if (Object.hasOwn(ESCAPE_CLASSES, token)) return ESCAPE_CLASSES[token]!;
    if (Object.hasOwn(CONTROL_ESCAPES, token)) return singleton(CONTROL_ESCAPES[token]!);
    if (token === "b" && inClass) return singleton(8);
    if (token === "x" || token === "u") {
      const length = token === "x" ? 2 : 4;
      const hex = this.source.slice(this.at, this.at + length);
      if (hex.length !== length || ![...hex].every(isHexDigit))
        throw new Error("invalid hex escape");
      this.at += length;
      return singleton(Number.parseInt(hex, 16));
    }
    if ("\\^$.*+?()[]{}|-/".includes(token)) return singleton(token.charCodeAt(0));
    throw new Error(
      `unsupported escape \\${token}; backreferences and word boundaries are not supported`,
    );
  }
}

function isDigit(token: string | undefined): boolean {
  return token !== undefined && token >= "0" && token <= "9";
}

function isHexDigit(token: string): boolean {
  return isDigit(token) || (token >= "a" && token <= "f") || (token >= "A" && token <= "F");
}

function singleton(code: number): Ranges {
  return [[code, code]];
}

function normalize(ranges: Range[]): Ranges {
  ranges.sort((a, b) => a[0] - b[0]);
  const result: Range[] = [];
  for (const range of ranges) {
    const previous = result.at(-1);
    if (previous !== undefined && range[0] <= previous[1] + 1) {
      result[result.length - 1] = [previous[0], Math.max(previous[1], range[1])];
    } else {
      result.push(range);
    }
  }
  return result;
}

/** Input ranges are already sorted, disjoint intervals of UTF-16 units. */
function complement(ranges: Ranges): Ranges {
  const result: Range[] = [];
  let from = 0;
  for (const [low, high] of ranges) {
    if (from < low) result.push([from, low - 1]);
    from = high + 1;
  }
  if (from <= 0xffff) result.push([from, 0xffff]);
  return result;
}

type State =
  | { kind: "match" }
  | { kind: "char"; ranges: Ranges; out: number }
  | { kind: "start" | "end"; out: number }
  | { kind: "split"; out: number; other: number };

/** Compile backwards into a continuation; only star loops need patching. */
function buildNfa(expression: Expression): { states: State[]; start: number } {
  const states: State[] = [{ kind: "match" }];
  function add(state: State): number {
    if (states.length >= SHELL_NOTIFY_REGEX_MAX_STATES) {
      throw new Error(
        `the expanded expression exceeds the ${SHELL_NOTIFY_REGEX_MAX_STATES}-state bound`,
      );
    }
    return states.push(state) - 1;
  }
  function build(node: Expression, next: number): number {
    // Essential for nested empty finite repeats: state cost alone does not
    // bound an expansion loop that emits zero states at every level.
    if (node.cost === 0) return next;
    switch (node.kind) {
      case "empty":
        return next;
      case "char":
        return add({ kind: "char", ranges: node.ranges, out: next });
      case "start":
      case "end":
        return add({ kind: node.kind, out: next });
      case "sequence": {
        let out = next;
        for (let i = node.children.length - 1; i >= 0; i -= 1) out = build(node.children[i]!, out);
        return out;
      }
      case "alternate": {
        let out = build(node.children.at(-1)!, next);
        for (let i = node.children.length - 2; i >= 0; i -= 1) {
          out = add({ kind: "split", out: build(node.children[i]!, next), other: out });
        }
        return out;
      }
      case "repeat": {
        let out = next;
        if (node.max === null) {
          const loop: State & { kind: "split" } = { kind: "split", out: next, other: next };
          out = add(loop);
          loop.out = build(node.child, out);
        } else {
          for (let i = node.min; i < node.max; i += 1) {
            out = add({ kind: "split", out: build(node.child, out), other: out });
          }
        }
        for (let i = 0; i < node.min; i += 1) out = build(node.child, out);
        return out;
      }
    }
  }
  return { states, start: build(expression, 0) };
}

function contains(ranges: Ranges, code: number): boolean {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const range = ranges[mid]!;
    if (code < range[0]) high = mid - 1;
    else if (code > range[1]) low = mid + 1;
    else return true;
  }
  return false;
}

function testNfa(states: readonly State[], start: number, line: string): boolean {
  const seen = new Uint32Array(states.length);
  const stack: number[] = [];
  const active: number[] = [];
  for (let position = 0; position <= line.length; position += 1) {
    const epoch = position + 1;
    stack.push(start); // Search all starts together, never restart the scan.
    active.length = 0;
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (seen[id] === epoch) continue;
      seen[id] = epoch;
      const state = states[id]!;
      switch (state.kind) {
        case "match":
          return true;
        case "char":
          active.push(id);
          break;
        case "split":
          stack.push(state.out, state.other);
          break;
        case "start":
          if (position === 0) stack.push(state.out);
          break;
        case "end":
          if (position === line.length) stack.push(state.out);
          break;
      }
    }
    if (position === line.length) return false;
    const code = line.charCodeAt(position);
    for (const id of active) {
      const state = states[id]!;
      if (state.kind === "char" && contains(state.ranges, code)) stack.push(state.out);
    }
  }
  return false;
}
