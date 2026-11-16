/**
 * Relational-selector guard (VC-1231). Runs with check:glass-design.
 *
 * WHAT IT STOPS: a `:has()` whose argument reaches every descendant of the
 * element it is tested on — `X:has(.y)`, `X:has(> a .y)`, Tailwind's
 * `has-[.y]:`, `has-data-[…]:`, `has-checked:` — on an element that holds the
 * chat transcript. Chromium tests such an argument by walking the whole subtree
 * and flags every element in it. From then on, ANY element inserted anywhere in
 * that subtree (a streamed row, a tool card, a "Show earlier" page) walks back
 * up to the tested element. If any `:has()` rule sits left of a combinator on
 * that element, Chromium restyles everything in the subtree that ANY such rule
 * could select: one invalidation set is shared by all of them. Measured on a
 * 300-exchange transcript (1,200 rows): one rule,
 * `.chat-transcript:has([data-slot="conversation-scroll-button"]) …`, made
 * every insertion restyle ~7,300 elements, about 20 ms each, against ~1.5 ms
 * with it gone.
 *
 * WHAT PASSES WITHOUT REVIEW: an argument that starts with `>`, `+` or `~` and
 * never steps to a descendant (`:has(> a)`, `:has(> * > a)`, `:has(+ a)`).
 * Chromium bounds that walk to the depth written, so it cannot reach into a
 * transcript from above it.
 *
 * WHAT NEEDS REVIEW: every unbounded argument is listed in
 * relational-selector-allowlist.json with why the element it is tested on
 * cannot hold the transcript. Prefer, cheapest first: write the argument with
 * `>`; mark the element from the component that knows (a data attribute, as
 * the scroll button does); test the `:has()` on a smaller element.
 *
 * Static and therefore partial: it cannot tell what a class will be put on.
 * Tests, fixtures and the browser-only lab do not ship and are excluded.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseAst } from "vite";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const RENDERER = "apps/desktop/src/renderer/";
const ALLOWLIST = resolve(HERE, "relational-selector-allowlist.json");

/** The text from `open` (an opening bracket) to its matching close, exclusive. */
function balanced(text, open) {
  const pairs = { "(": ")", "[": "]" };
  const stack = [];
  for (let i = open; i < text.length; i += 1) {
    const char = text[i];
    if (char === "\\") {
      i += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      const end = text.indexOf(char, i + 1);
      if (end < 0) return null;
      i = end;
      continue;
    }
    if (char in pairs) stack.push(pairs[char]);
    else if (char === ")" || char === "]") {
      if (stack.pop() !== char) return null;
      if (stack.length === 0) return text.slice(open + 1, i);
    }
  }
  return null;
}

/** Split at top-level commas (outside brackets and quotes). */
function splitList(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === "\\") i += 1;
    else if (char === "(" || char === "[") depth += 1;
    else if (char === ")" || char === "]") depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

/**
 * Whether a `:has()` argument stays within a written depth: every relative
 * selector in it starts with `>`, `+` or `~`, and no compound after that is
 * joined by a descendant (whitespace) combinator.
 */
export function boundedHasArgument(argument) {
  return splitList(argument).every((branch) => {
    if (!/^[>+~]/.test(branch)) return false;
    // Blank out bracketed and parenthesised content, then normalise combinators.
    let flat = "";
    let depth = 0;
    for (let i = 0; i < branch.length; i += 1) {
      const char = branch[i];
      if (char === "\\") {
        flat += "x";
        i += 1;
        continue;
      }
      if (char === "(" || char === "[") depth += 1;
      if (depth === 0) flat += char;
      else if (char === "(" || char === "[") flat += "x";
      if (char === ")" || char === "]") depth -= 1;
    }
    const compounds = flat
      .replace(/\s*([>+~])\s*/g, "$1")
      .trim()
      .slice(1);
    return !/\s/.test(compounds);
  });
}

/** Every `:has(` argument in a CSS selector text. */
function hasArguments(selector) {
  const found = [];
  for (let at = selector.indexOf(":has("); at >= 0; at = selector.indexOf(":has(", at + 1)) {
    const argument = balanced(selector, at + 4);
    if (argument !== null) found.push(argument);
  }
  return found;
}

/**
 * The `:has()` arguments a Tailwind class token generates. `_` is a space in
 * arbitrary values; named variants (`has-checked:`, `has-data-[…]:`,
 * `has-aria-…:`) all test descendants.
 */
export function tailwindHasArguments(token) {
  const found = [];
  let depth = 0;
  let start = 0;
  const variants = [];
  for (let i = 0; i < token.length; i += 1) {
    if (token[i] === "[" || token[i] === "(") depth += 1;
    if (token[i] === "]" || token[i] === ")") depth -= 1;
    if (token[i] === ":" && depth === 0) {
      variants.push(token.slice(start, i));
      start = i + 1;
    }
  }
  for (const variant of variants) {
    const named = /^(?:group-|peer-)?has-(.+)$/.exec(variant);
    if (named) {
      const rest = named[1];
      if (rest.startsWith("[") && rest.endsWith("]"))
        found.push(rest.slice(1, -1).replaceAll("_", " "));
      else if (rest.startsWith("data-[") || rest.startsWith("aria-["))
        found.push(`[${rest.slice(0, rest.indexOf("["))}${rest.slice(rest.indexOf("[") + 1, -1)}]`);
      else found.push(`:${rest}`);
    } else if (variant.startsWith("[") && variant.includes(":has(")) {
      found.push(...hasArguments(variant.replaceAll("_", " ")));
    }
  }
  return found;
}

/** One finding per unbounded `:has()` argument: `{ path, line, argument, context }`. */
export function inspectRelationalSelectors(path, source) {
  const found = [];
  const add = (offset, argument, context) => {
    const line = source.slice(0, offset).split("\n").length;
    found.push({ path, line, argument: argument.trim(), context: context.trim().slice(0, 200) });
  };
  if (path.endsWith(".css")) {
    // Preserve offsets while removing comments; selectors are the text before `{`.
    const css = source.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "));
    for (const match of css.matchAll(/(?:^|[{};])([^{};]*):has\(/g)) {
      let selectorStart = match.index + match[0].length - match[1].length - 5;
      while (/\s/.test(css[selectorStart])) selectorStart += 1;
      const brace = css.indexOf("{", selectorStart);
      const selector = css.slice(selectorStart, brace < 0 ? undefined : brace);
      for (const argument of hasArguments(selector)) {
        if (!boundedHasArgument(argument)) add(selectorStart, argument, selector);
      }
    }
    // The regex above finds each selector once per `{`-separated chunk; dedupe.
    const seen = new Set();
    return found.filter((item) => {
      const key = `${item.line}:${item.argument}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  if (!/has-|:has\(/.test(source)) return found;
  const ast = parseAst(source, { lang: path.endsWith("tsx") ? "tsx" : "ts" }, path);
  const visit = (node) => {
    if (!node || typeof node.type !== "string" || node.type.startsWith("TS")) return;
    const text =
      node.type === "Literal" && typeof node.value === "string"
        ? node.value
        : node.type === "TemplateElement"
          ? (node.value.cooked ?? node.value.raw)
          : null;
    if (text !== null) {
      for (const token of text.split(/\s+/)) {
        for (const argument of tailwindHasArguments(token)) {
          if (!boundedHasArgument(argument)) add(node.start, argument, token);
        }
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  };
  visit(ast);
  return found;
}

/** Findings not listed in the allowlist, and entries that no longer match anything. */
export function checkRelationalAllowlist(findings, entries) {
  for (const entry of entries) {
    if (
      typeof entry.path !== "string" ||
      !entry.path.startsWith(RENDERER) ||
      typeof entry.argument !== "string" ||
      typeof entry.reason !== "string" ||
      !entry.reason.trim()
    )
      throw new Error(`Malformed relational-selector allowlist entry: ${JSON.stringify(entry)}`);
  }
  const listed = (item) =>
    entries.some((entry) => entry.path === item.path && entry.argument === item.argument);
  const unexcused = findings.filter((item) => !listed(item));
  const stale = entries.filter(
    (entry) =>
      !findings.some((item) => item.path === entry.path && item.argument === entry.argument),
  );
  return { unexcused, stale };
}

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory())
      return /^(?:lab|__tests__|__fixtures__|fixtures|coverage|dist|node_modules)$/.test(entry.name)
        ? []
        : sourceFiles(path);
    return /\.(?:tsx?|css)$/.test(path) && !/\.(?:test|spec|test-support|bench)\./.test(path)
      ? [path]
      : [];
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const findings = sourceFiles(resolve(ROOT, RENDERER)).flatMap((path) =>
    inspectRelationalSelectors(relative(ROOT, path), readFileSync(path, "utf8")),
  );
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(findings, null, 1));
  } else {
    const { entries } = JSON.parse(readFileSync(ALLOWLIST, "utf8"));
    const { unexcused, stale } = checkRelationalAllowlist(findings, entries);
    for (const { path, line, argument, context } of unexcused)
      console.error(
        `${path}:${line} unbounded :has(${argument}) in ${context}\n` +
          "  Its argument reaches every descendant: on an element that holds the chat transcript,\n" +
          "  every insertion restyles the transcript. Start it with `>` or mark the element from its\n" +
          "  component; if the element cannot hold the transcript, list it in\n" +
          "  scripts/relational-selector-allowlist.json with why.",
      );
    for (const { path, argument } of stale)
      console.error(`${path} :has(${argument}): stale allowlist entry; remove it`);
    if (unexcused.length || stale.length) process.exitCode = 1;
    else
      console.log(
        `Relational selectors: PASS (${findings.length} reviewed unbounded :has() arguments).`,
      );
  }
}
