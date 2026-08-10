/**
 * A small shell lexer, ported from pi-automode.
 *
 * Rules need the program separated from its operands, because the dangerous
 * cases are operand-shaped: `rm -rf /` and `rm -rf ./build` differ in one word.
 * A regex over the whole command line cannot make that distinction, and it
 * cannot see past the oldest bypass there is — a safe prefix hiding a risky
 * suffix behind `&&`, `|`, or `;`.
 *
 * What this is worth, stated plainly: it handles quoting, escaping, operators,
 * and redirects, and it is defeated by `eval`, `base64`, command substitution,
 * `xargs`, and any other construct that produces a command line the lexer never
 * sees. It is sound as a layer beneath the Seatbelt sandbox — which denies the
 * network, strips credentials from the child environment, and scopes writes to
 * the workspace whatever the lexer concluded — and unsound as a standalone
 * boundary. It is only ever used as the former.
 *
 * See `./README.md` for the upstream revision and the divergences.
 */

/** One command in a pipeline or operator chain, with its redirects pulled out. */
export interface LexedSegment {
  /** The segment's own text, before tokenizing. */
  text: string;
  /** Tokens that are neither redirect operators nor redirect targets. */
  words: readonly string[];
  /** Targets of output redirects: `>`, `>>`, `2>`, `>&file`. */
  writeTargets: readonly string[];
  /** Targets of input redirects: `<`. */
  readTargets: readonly string[];
}

/** A leading `NAME=value` assignment, which scopes an environment variable to one command. */
const ASSIGNMENT = /^\w+=/;

/** Whether a token sets an environment variable rather than naming an operand. */
export function isAssignment(token: string): boolean {
  return ASSIGNMENT.test(token);
}

/** Redirect operators this tokenizer can emit, with the optional file descriptor. */
const REDIRECT = /^\d*(?:>>|>&|>\||>|<&|<)$/;

function count(value: string, character: string): number {
  return [...value].filter((each) => each === character).length;
}

/**
 * Shell keywords that can stand at the head of a command without being one.
 *
 * `if true; then rm -rf ~; fi` splits on `;` into a segment beginning `then`,
 * and a segment whose program reads as `then` misses every rule that dispatches
 * on the program. A conditional is the most ordinary thing an agent writes, so
 * these are stripped the way grouping punctuation is. Only a leading run is
 * removed: `echo then` still passes `then` as an argument.
 */
const KEYWORDS = new Set([
  "!",
  "case",
  "do",
  "done",
  "elif",
  "else",
  "esac",
  "fi",
  "for",
  "function",
  "if",
  "in",
  "select",
  "then",
  "until",
  "while",
]);

/**
 * Strip the grouping punctuation a subshell or brace group leaves welded to its
 * neighbours, so `( rm -rf ~ )` and `(rm -rf ~)` both report `rm` and `~`.
 *
 * Counted rather than trimmed, because `${HOME}` closes its own brace and
 * `$(date)` its own paren; only unbalanced punctuation is the group's.
 */
function stripGrouping(token: string): string {
  let value = token;
  while (value.startsWith("(") && count(value, "(") > count(value, ")")) value = value.slice(1);
  while (value.startsWith("{") && count(value, "{") > count(value, "}")) value = value.slice(1);
  while (value.endsWith(")") && count(value, ")") > count(value, "(")) value = value.slice(0, -1);
  while (value.endsWith("}") && count(value, "}") > count(value, "{")) value = value.slice(0, -1);
  return value;
}

/** Split a command line on the operators that start a new command. */
function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | "`" | undefined;
  let escaped = false;
  let depth = 0;

  const flush = () => {
    if (current.trim() !== "") segments.push(current.trim());
    current = "";
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command.charAt(index);
    const next = command.charAt(index + 1);
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      current += char;
      escaped = true;
      continue;
    }
    if (quote !== undefined) {
      current += char;
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      current += char;
      continue;
    }
    if ((char === "&" && next === "&") || (char === "|" && next === "|")) {
      flush();
      index += 1;
      continue;
    }
    // `>|`, `2>&1` and `&>log` each spell one redirect operator. Splitting
    // inside one would strand its target on the far side, and a stranded target
    // is a write the caller is never told about.
    if ((char === "|" || char === "&") && /[<>]$/.test(current.trimEnd())) {
      current += char;
      continue;
    }
    if (char === "&" && next === ">") {
      current += char;
      continue;
    }
    if (char === "(") depth += 1;
    // An unbalanced `)` closes something this segment never opened, which is
    // `case pattern)` starting its command list. A balanced one belongs to a
    // subshell or `$(…)` and is left for `stripGrouping`.
    if (char === ")") {
      if (depth === 0) {
        flush();
        continue;
      }
      depth -= 1;
    }
    if (char === ";" || char === "\n" || char === "|" || char === "&") {
      flush();
      continue;
    }
    current += char;
  }
  flush();
  return segments;
}

/** Split one segment into words and redirect operators, dropping quotes and escapes. */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | "`" | undefined;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current !== "") tokens.push(current);
      current = "";
      continue;
    }
    if (char === ">" || char === "<") {
      let operator = char;
      if (/^\d+$/.test(current)) operator = current + char;
      else if (current !== "") tokens.push(current);
      const following = text.charAt(index + 1);
      if (following === ">" || following === "&" || following === "|") {
        operator += following;
        index += 1;
      }
      tokens.push(operator);
      current = "";
      continue;
    }
    current += char;
  }
  if (current !== "") tokens.push(current);
  return tokens;
}

/**
 * Lex a command line into its segments, in the order the shell would run them.
 *
 * Throws on a redirect whose target it cannot see. Dropping one is the exact
 * fail-open this layer promises not to have — the caller would be told the
 * command writes nowhere, which is the answer that gets it allowed.
 */
export function lexCommandLine(command: string): LexedSegment[] {
  return splitSegments(command).map((text) => {
    const words: string[] = [];
    const writeTargets: string[] = [];
    const readTargets: string[] = [];
    const tokens = tokenize(text);
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (!REDIRECT.test(token)) {
        const word = stripGrouping(token);
        if (word !== "") words.push(word);
        continue;
      }
      index += 1;
      if (index === tokens.length) {
        throw new Error(`Redirect "${token}" in "${text}" names no target.`);
      }
      const target = tokens[index];
      // `2>&1` and `0<&3` name a descriptor, not a file, and duplicating one
      // opens nothing this policy can be asked about.
      if (token.endsWith("&") && /^\d+$/.test(target)) continue;
      (token.includes(">") ? writeTargets : readTargets).push(stripGrouping(target));
    }
    while (words.length > 0 && KEYWORDS.has(words[0].toLowerCase())) words.shift();
    return { text, words, writeTargets, readTargets };
  });
}

/**
 * Separate a segment's leading `NAME=value` prefixes from its program and args.
 *
 * A segment with nothing but assignments, or nothing but redirects, has no
 * program; it reports an empty one rather than being dropped, because its
 * environment and its redirect targets are still facts about the command line.
 */
export function splitProgram(words: readonly string[]): {
  env: string[];
  program: string;
  args: string[];
} {
  const env: string[] = [];
  const args: string[] = [];
  let program = "";
  let found = false;
  for (const word of words) {
    if (found) args.push(word);
    else if (ASSIGNMENT.test(word)) env.push(word);
    else {
      program = word;
      found = true;
    }
  }
  return { env, program, args };
}
