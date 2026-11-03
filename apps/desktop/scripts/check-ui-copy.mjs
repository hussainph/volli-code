/**
 * Fails when renderer source puts off-system copy or markup on screen.
 *
 *     node apps/desktop/scripts/check-ui-copy.mjs             # the gate
 *     node apps/desktop/scripts/check-ui-copy.mjs --self-test # the matcher's own tests
 *     node apps/desktop/scripts/check-ui-copy.mjs --counts    # the gate, plus hits per rule
 *
 * WHY THIS EXISTS. `check-design-tokens.mjs` holds the class strings to the
 * ladder. The words and the element choices had nothing holding them: DESIGN.md
 * says "no ellipsis-as-loading", AGENTS.md says "let controls talk" and "never
 * `duotone`", the docs voice bans "seamless" — and each of those is a sentence
 * a convenient `Saving…` never has to read. A document cannot fail; this can.
 *
 * WHAT IT READS is the copy that reaches the screen, found by parsing each
 * `.tsx` file — Vite's `parseAst` (oxc's TypeScript parser, ESTree output),
 * the toolchain parser `profile-wiring.test.ts` already uses. The `typescript`
 * package this repo pins (7.x) is the native compiler: its JavaScript API is an
 * `unstable/` bridge to the compiler process rather than an in-process parser,
 * so it is not one a CI gate should stand on. A parse rather than a scan,
 * because copy lives in four shapes a regex cannot tell apart from code:
 *
 * - JSX text, joined across `{…}` holes and inline elements, so
 *   `Loading {name}…` is one string the way a reader sees it;
 * - strings in UI attributes ({@link UI_PROPS}: `title`, `aria-label`,
 *   `placeholder`, `label`, `description`, `hint`, … and any `…Label`,
 *   `…Title`, `…Message` prop), through `? :`, `&&`, `??` and templates;
 * - the same names as object-literal keys (`{ label: "Rename…" }` in a menu
 *   model), since that is how a list of rows carries its copy;
 * - message arguments to {@link MESSAGE_CALLS} (`toast.*`, `toastError`,
 *   `window.confirm`, `window.alert`), with their option objects.
 *
 * `copy-loading-ellipsis` alone reads every other string in the module too
 * (see its rule): its pattern is never anything but a caption, and copy that
 * reaches JSX through a variable is the common case.
 *
 * WHAT IT DOES NOT READ, said rather than implied: `.ts` modules (label maps
 * such as `SESSION_ACTIVITY_LABEL`, store-side messages); for every rule but
 * the loading one, copy routed through a variable before it reaches JSX; and
 * text inside `<code>`, `<pre>`, `<kbd>` and `<samp>` — those draw values (a
 * command, a path, a chord), not copy. Tests and the UI lab are skipped:
 * neither ships.
 *
 * THE ALLOWLIST (`ui-copy-allowlist.json`) works exactly like
 * `design-token-allowlist.json`: every entry carries a `reason`, and an entry
 * that no longer matches anything FAILS, so finishing a sweep includes
 * deleting its record. `contains` is matched against the offending text and
 * against its source line, so an entry may quote either the copy or the code.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { parseAst } from "vite";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(HERE, "../../..");
const SCAN_ROOT = resolvePath(HERE, "../src/renderer/src");
const ALLOWLIST = resolvePath(HERE, "ui-copy-allowlist.json");

/** Scratch space and tests: neither ships, so neither is held to product copy. */
const SKIP_DIRS = new Set(["lab", "__tests__"]);
const SKIP_FILE = /\.(?:test|spec|test-support)\.tsx$/;

/**
 * Attribute and object-key names whose string value is drawn as copy.
 *
 * `aria-*` text is read aloud, which is still copy. Ids that merely point at
 * copy (`aria-labelledby`, `aria-describedby`) are not, and `href`/`src` are
 * destinations rather than text, which is what lets `copy-url-in-ui` stay
 * quiet on a real link.
 */
const UI_PROPS = new Set([
  "title",
  "aria-label",
  "aria-description",
  "aria-roledescription",
  "aria-valuetext",
  "placeholder",
  "label",
  "description",
  "hint",
  "alt",
  "tooltip",
  "message",
  "heading",
  "caption",
  "subtitle",
]);

/** `confirmLabel`, `emptyTitle`, `errorMessage`: a prop named for the copy it carries. */
const UI_PROP_SUFFIX =
  /^[a-z][A-Za-z]*(?:Label|Title|Text|Message|Description|Hint|Placeholder|Tooltip|Heading|Caption)$/;

const isUiProp = (name) => UI_PROPS.has(name) || UI_PROP_SUFFIX.test(name);

/**
 * Calls whose arguments are shown to a person verbatim. Keys of an options
 * object passed to them count too (`toast.promise`'s `loading`, an action's
 * `label`), on top of {@link UI_PROPS}.
 */
const MESSAGE_CALLS = new Set([
  "toast",
  "toastError",
  "alert",
  "confirm",
  "window.alert",
  "window.confirm",
]);
const MESSAGE_CALL_PREFIXES = ["toast."];
const MESSAGE_OPTION_KEYS = new Set(["loading", "success", "error"]);

/** Elements whose text is a value to copy or read, not product copy. */
const VALUE_ELEMENTS = new Set(["code", "pre", "kbd", "samp"]);

/** The settings kit's two shapes, and the names AGENTS.md uses for them. */
const SETTINGS_SHAPES = new Set(["PrefSection", "PrefRow", "SettingsSection", "SettingsRow"]);

/**
 * DESIGN.md "Loading": a progress verb trailed by an ellipsis is the loading
 * state spelled in punctuation.
 *
 * A progress verb is any `-ing` word, not a list. A list was the first draft
 * (Loading, Saving, Checking, Connecting, Starting, Signing in, Waiting, …) and
 * the renderer already spelled more than a dozen verbs it did not name —
 * Reading, Scanning, Exporting, Downloading, Signing out — so a list is stale
 * the day someone writes "Uploading…". The shape is what makes the rule safe: a menu
 * verb that opens a dialog is never progressive ("Rename…", "Open file…",
 * "Sign in…"), so it is untouched. {@link NOT_PROGRESS} names the `-ing`
 * words that are not verbs in the progressive at all.
 */
const NOT_PROGRESS = [
  "\\w*thing",
  "bring",
  "string",
  "spring",
  "swing",
  "sting",
  "sling",
  "cling",
  "fling",
  "wing",
  "king",
  "ring",
  "sing",
  "during",
  "morning",
  "evening",
  "ceiling",
];
/** The verb, then up to one clause (no sentence stop), then `…` or `...`. */
const LOADING_ELLIPSIS = new RegExp(
  `\\b(?!(?:${NOT_PROGRESS.join("|")})\\b)[a-z]+ing\\b[^.!?…]{0,80}?(?:…|\\.\\.\\.)`,
  "i",
);

/**
 * The banned words of the docs voice (`product-docs` voice.md), inflections
 * included. "harness" is a product term there and is deliberately absent.
 */
const BANNED_WORDS = new RegExp(
  "\\b(?:" +
    [
      "seamless(?:ly)?",
      "effortless(?:ly)?",
      "leverag(?:e|es|ed|ing)",
      "utili[sz](?:e|es|ed|ing|ation)",
      "robust(?:ly|ness)?",
      "powerful(?:ly)?",
      "unlock(?:s|ed|ing)?",
      "supercharg(?:e|es|ed|ing)",
      "elevat(?:e|es|ed|ing)",
      "streamlin(?:e|es|ed|ing)",
      "empower(?:s|ed|ing|ment)?",
      "cutting-edge",
      "next-level",
      "delv(?:e|es|ed|ing)",
      "foster(?:s|ed|ing)?",
      "facilitat(?:e|es|ed|ing)",
      "paradigm shift",
      "game[- ]changer",
      "this is huge",
      "this changes everything",
      "tapestry",
      "realms?",
      "beacons?",
      "multifaceted",
      "meticulous(?:ly)?",
      "intricate",
      "paramount",
      "transformative",
      "embark(?:s|ed|ing)?",
      "ever-evolving",
    ].join("|") +
    ")\\b",
  "i",
);

const URL_IN_TEXT = /\bhttps?:\/\/[^\s"'`<>)]*/i;

/**
 * One rule. Copy rules test a string a person reads (`test(text)` returns the
 * offending excerpt or null); markup rules are decided while walking JSX and
 * only carry their words here.
 */
const RULES = [
  {
    id: "copy-loading-ellipsis",
    // DESIGN.md system rule 7. An ellipsis cannot stop, fail or announce
    // itself; `Spinner` (replacing the leading icon where there is one) and
    // `LoadingLabel` can.
    //
    // The one copy rule that reads EVERY string in a `.tsx` module, not only
    // the ones the walk can follow to the screen: `const label = busy ?
    // "Saving…" : "Save"` reaches JSX through a variable, and a progress verb
    // with an ellipsis is never anything but a loading caption. `console.*`
    // arguments and type positions are still skipped.
    summary: "ellipsis-as-loading",
    fix: "show a Spinner / LoadingLabel and drop the ellipsis",
    anyString: true,
    test: (text) => LOADING_ELLIPSIS.exec(text)?.[0] ?? null,
  },
  {
    id: "copy-banned-word",
    // The docs voice's banned words are banned on screen for the same reason:
    // each is a claim about the product instead of a fact about it. Read only
    // where the string reaches the screen, because `"unlock"` is also an
    // action id.
    summary: "banned word (docs voice)",
    fix: "say the concrete fact the word was standing in for",
    test: (text) => BANNED_WORDS.exec(text)?.[0] ?? null,
  },
  {
    id: "copy-url-in-ui",
    // A raw URL is a value nobody proof-read on a product surface: it wraps
    // badly, cannot be translated and says where rather than what. Name the
    // destination and put the URL in an `href`. Read only where the string
    // reaches the screen, because a URL is also a fetch target. A field's
    // `placeholder` is exempt: in a URL field the example address IS the
    // format, which is the control explaining itself.
    summary: "literal URL rendered as text",
    fix: "name the destination and link it (the URL belongs in href)",
    ignores: new Set(["placeholder"]),
    test: (text) => URL_IN_TEXT.exec(text)?.[0] ?? null,
  },
  {
    id: "markup-native-select",
    // A native `<select>` draws the OS menu: off the control ladder, off the
    // menu recipe and unthemed by the canvas.
    summary: "native <select>",
    fix: "use ui/select (Select / SelectTrigger / SelectContent)",
  },
  {
    id: "markup-settings-description",
    // AGENTS.md "let controls talk": no prose under a settings control. The
    // kit's `hint` (the (i)) carries an explanation; `description` is reserved
    // for trust boundaries, and each such row is a recorded exception.
    summary: "description under a settings row/section",
    fix: "cut it, or move it into `hint`; trust boundaries are allowlisted",
  },
  {
    id: "icon-duotone",
    // AGENTS.md icon weight: outline by default, `fill` for the one
    // exception, `bold` at small sizes, `duotone` never.
    summary: 'weight="duotone"',
    fix: "outline (no prop), or fill/bold per the icon-weight rule",
  },
];

const COPY_RULES = RULES.filter((rule) => rule.test);

/** Every `.tsx` file under `dir`, minus tests, test support and the lab. */
function sourceFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) found.push(...sourceFiles(path));
    } else if (entry.endsWith(".tsx") && !SKIP_FILE.test(entry)) {
      found.push(path);
    }
  }
  return found;
}

const ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  middot: "·",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
};

/** JSX text arrives with its entities undecoded; `Loading&hellip;` is still `…`. */
function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === "#") {
      const code =
        name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return String.fromCodePoint(code);
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/**
 * TypeScript's type level: a string here is a type, not copy, and nothing
 * under it is walked.
 */
const TYPE_LEVEL = new Set([
  "TSTypeAnnotation",
  "TSTypeAliasDeclaration",
  "TSInterfaceDeclaration",
  "TSTypeParameterInstantiation",
  "TSTypeParameterDeclaration",
  "TSLiteralType",
]);

/** How a dynamic part of a string is drawn, so `Loading {name}…` stays one clause. */
const HOLE = "{x}";

const normalize = (text) => text.replace(/\s+/g, " ").trim();

/** The 1-based line of a UTF-16 offset. */
function lineAt(lineStarts, offset) {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (lineStarts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

/** `foo`, `foo.bar`, `window.confirm` — the dotted name of a callee, or null. */
function calleeName(node) {
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression" && !node.computed) {
    const object = calleeName(node.object);
    return object && node.property.type === "Identifier" ? `${object}.${node.property.name}` : null;
  }
  return null;
}

function jsxName(node) {
  if (node.type === "JSXIdentifier") return node.name;
  if (node.type === "JSXNamespacedName") return `${node.namespace.name}:${node.name.name}`;
  if (node.type === "JSXMemberExpression") return `${jsxName(node.object)}.${node.property.name}`;
  return null;
}

function propertyKey(node) {
  if (node.computed) return null;
  if (node.key.type === "Identifier") return node.key.name;
  if (node.key.type === "Literal" && typeof node.key.value === "string") return node.key.value;
  return null;
}

/**
 * Every static string an expression can evaluate to, each with its start.
 *
 * Branches are followed (`busy ? "Saving…" : "Save"` is two strings), type
 * wrappers are seen through, and a template's substitutions become holes.
 * Anything else — a call, an identifier — is not static copy and yields
 * nothing.
 */
function staticStrings(node, found = []) {
  if (!node) return found;
  switch (node.type) {
    case "Literal":
      if (typeof node.value === "string") found.push({ text: node.value, start: node.start + 1 });
      break;
    case "TemplateLiteral":
      found.push({
        text: node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join(HOLE),
        start: node.start + 1,
      });
      break;
    case "ConditionalExpression":
      staticStrings(node.consequent, found);
      staticStrings(node.alternate, found);
      break;
    case "LogicalExpression":
      if (node.operator !== "&&") staticStrings(node.left, found);
      staticStrings(node.right, found);
      break;
    case "ParenthesizedExpression":
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSNonNullExpression":
    case "JSXExpressionContainer":
      staticStrings(node.expression, found);
      break;
    default:
      break;
  }
  return found;
}

/**
 * A JSX element's children as runs of text, the way a reader meets them.
 *
 * Text and static string children join; a dynamic `{…}` or an inline element
 * is a hole inside the run rather than its end, so `Loading <b>{name}</b>…`
 * reads as `Loading {x}…`. The inline element's own text is a run of its own,
 * found when the walk reaches it. Strings inside a branching child
 * (`{busy ? "Saving…" : "Save"}`) are reported on their own, because a reader
 * only ever sees one branch.
 */
function childRuns(children) {
  let text = "";
  let start = null;
  const separate = [];
  for (const child of children) {
    if (child.type === "JSXText") {
      const decoded = decodeEntities(child.value);
      if (start === null && decoded.trim()) start = child.start + child.value.search(/\S/);
      text += decoded;
    } else if (child.type === "JSXExpressionContainer") {
      const expression = child.expression;
      if (expression.type === "JSXEmptyExpression") continue;
      if (expression.type === "Literal" && typeof expression.value === "string") {
        if (start === null && expression.value.trim()) start = expression.start + 1;
        text += expression.value;
      } else if (expression.type === "TemplateLiteral") {
        const [only] = staticStrings(expression);
        if (start === null) start = only.start;
        text += only.text;
      } else {
        separate.push(...staticStrings(expression));
        text += HOLE;
      }
    } else {
      text += HOLE;
    }
  }
  const runs = [];
  const joined = normalize(text);
  if (start !== null && joined.replaceAll(HOLE, "").trim()) runs.push({ text: joined, start });
  return [...runs, ...separate];
}

/**
 * Every copy string and every markup violation in one file.
 *
 * One walk over the whole tree. Copy sites are collected with the offset of
 * their first character (deduplicated, since a toast option's `description`
 * is both a UI key and a message argument); markup rules are decided at the
 * opening element.
 */
function inspect(source, path) {
  const program = parseAst(source, { lang: "tsx" }, path);
  const sites = new Map();
  const loose = new Map();
  const markup = [];

  /** `origin` is the attribute or key the strings sit under, or null. */
  const addStrings = (strings, origin = null) => {
    for (const { text, start } of strings) {
      const normalized = normalize(text);
      if (normalized && !sites.has(start)) sites.set(start, { text: normalized, origin });
    }
  };

  const visit = (node, context) => {
    if (!node || typeof node.type !== "string") return;
    if (TYPE_LEVEL.has(node.type)) return;
    const inValue = context.value;

    if (!inValue && !context.quiet) {
      if (node.type === "Literal" && typeof node.value === "string") {
        loose.set(node.start + 1, node.value);
      } else if (node.type === "TemplateLiteral") {
        for (const { start, text } of staticStrings(node)) loose.set(start, text);
      }
    }

    if (node.type === "JSXElement" || node.type === "JSXFragment") {
      const opening = node.openingElement;
      const name = opening ? jsxName(opening.name) : null;
      const valueElement = inValue || (name !== null && VALUE_ELEMENTS.has(name));
      if (opening) {
        if (name === "select")
          markup.push({ rule: "markup-native-select", start: opening.start, text: "<select>" });
        for (const attribute of opening.attributes) {
          if (attribute.type !== "JSXAttribute") continue;
          const attributeName = jsxName(attribute.name);
          const values = attribute.value ? staticStrings(attribute.value) : [];
          if (SETTINGS_SHAPES.has(name) && attributeName === "description") {
            markup.push({
              rule: "markup-settings-description",
              start: attribute.start,
              text:
                values.length > 0
                  ? normalize(values[0].text)
                  : normalize(source.slice(attribute.start, attribute.end)).slice(0, 120),
            });
          }
          if (attributeName === "weight" && values.some(({ text }) => text === "duotone")) {
            markup.push({ rule: "icon-duotone", start: attribute.start, text: 'weight="duotone"' });
          }
          if (!valueElement && isUiProp(attributeName)) addStrings(values, attributeName);
        }
      }
      if (!valueElement) addStrings(childRuns(node.children));
      const inner = { ...context, value: valueElement };
      if (opening) for (const attribute of opening.attributes) visit(attribute, inner);
      for (const child of node.children) visit(child, inner);
      return;
    }

    if (!inValue && node.type === "Property" && node.kind === "init") {
      const key = propertyKey(node);
      if (key && isUiProp(key)) addStrings(staticStrings(node.value), key);
      if (key === "weight" && staticStrings(node.value).some(({ text }) => text === "duotone")) {
        markup.push({ rule: "icon-duotone", start: node.start, text: 'weight: "duotone"' });
      }
    }

    let next = context;
    if (node.type === "CallExpression") {
      const callee = calleeName(node.callee);
      if (callee?.startsWith("console.")) next = { ...context, quiet: true };
    }

    if (!inValue && node.type === "CallExpression") {
      const callee = calleeName(node.callee);
      if (
        callee &&
        (MESSAGE_CALLS.has(callee) ||
          MESSAGE_CALL_PREFIXES.some((prefix) => callee.startsWith(prefix)))
      ) {
        for (const argument of node.arguments) {
          addStrings(staticStrings(argument));
          if (argument.type === "ObjectExpression") {
            for (const property of argument.properties) {
              if (property.type !== "Property") continue;
              const key = propertyKey(property);
              if (key && (isUiProp(key) || MESSAGE_OPTION_KEYS.has(key))) {
                addStrings(staticStrings(property.value), key);
              }
            }
          }
        }
      }
    }

    for (const key of Object.keys(node)) {
      if (key === "type" || key === "start" || key === "end") continue;
      const value = node[key];
      if (Array.isArray(value)) for (const item of value) visit(item, next);
      else if (value && typeof value === "object") visit(value, next);
    }
  };

  visit(program, { value: false, quiet: false });

  const copy = [...sites].map(([start, { text, origin }]) => ({
    start,
    text,
    origin,
    onScreen: true,
  }));
  for (const [start, text] of loose) {
    const normalized = normalize(text);
    if (normalized && !sites.has(start)) {
      copy.push({ start, text: normalized, origin: null, onScreen: false });
    }
  }
  return { copy, markup };
}

/** Every rule violation in one file. */
function violations(path, source) {
  const lines = source.split("\n");
  const lineStarts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") lineStarts.push(index + 1);
  }
  const { copy, markup } = inspect(source, path);
  const found = [];
  for (const { start, text, origin, onScreen } of copy) {
    for (const rule of COPY_RULES) {
      if (!onScreen && !rule.anyString) continue;
      if (origin !== null && rule.ignores?.has(origin)) continue;
      const excerpt = rule.test(text);
      if (excerpt === null) continue;
      const line = lineAt(lineStarts, start);
      found.push({ path, line, rule: rule.id, text, excerpt, content: lines[line - 1] ?? "" });
    }
  }
  for (const { rule, start, text } of markup) {
    const line = lineAt(lineStarts, start);
    found.push({ path, line, rule, text, excerpt: text, content: lines[line - 1] ?? "" });
  }
  return found.toSorted((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}

/**
 * Reads the allowlist, failing loudly on a malformed entry.
 *
 * Every field is required, `reason` included: an entry without one is an
 * escape nobody has to defend.
 */
function readAllowlist() {
  const parsed = JSON.parse(readFileSync(ALLOWLIST, "utf8"));
  parsed.entries.forEach((entry, index) => {
    for (const field of ["path", "rule", "contains", "reason"]) {
      if (typeof entry[field] !== "string" || entry[field].length === 0) {
        throw new Error(`allowlist entry ${index} is missing a non-empty \`${field}\``);
      }
    }
    if (!RULES.some((rule) => rule.id === entry.rule)) {
      throw new Error(`allowlist entry ${index} names an unknown rule \`${entry.rule}\``);
    }
  });
  return parsed.entries;
}

const excuses = (entry, violation) =>
  entry.path === violation.path &&
  entry.rule === violation.rule &&
  (violation.text.includes(entry.contains) || violation.content.includes(entry.contains));

function main() {
  const entries = readAllowlist();
  const used = new Set();
  const unexcused = [];
  const counts = process.argv.includes("--counts") ? new Map() : null;

  for (const path of sourceFiles(SCAN_ROOT)) {
    const relativePath = relative(REPO_ROOT, path);
    for (const violation of violations(relativePath, readFileSync(path, "utf8"))) {
      counts?.set(violation.rule, (counts.get(violation.rule) ?? 0) + 1);
      const index = entries.findIndex((entry) => excuses(entry, violation));
      if (index === -1) unexcused.push(violation);
      else used.add(index);
    }
  }

  const stale = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ index }) => !used.has(index));

  if (unexcused.length > 0) {
    console.error(`${unexcused.length} off-system UI copy or markup use(s):\n`);
    for (const { path, line, rule, excerpt } of unexcused) {
      const { summary, fix } = RULES.find(({ id }) => id === rule);
      console.error(
        `  ${path}:${line}  ${rule}  ${JSON.stringify(excerpt)}\n      ${summary} — ${fix}`,
      );
    }
    console.error(`\nFix each, or record it in ${relative(REPO_ROOT, ALLOWLIST)} with a reason.`);
  }

  if (stale.length > 0) {
    console.error(`\n${stale.length} stale allowlist entr(ies) — nothing matches them any more:\n`);
    for (const { entry } of stale) {
      console.error(`  ${entry.path}  ${entry.rule}  "${entry.contains}"`);
    }
    console.error("\nThe escape is gone, so its record should be too — delete these entries.");
  }

  if (counts) {
    for (const rule of RULES) console.log(`${rule.id}: ${counts.get(rule.id) ?? 0}`);
  }
  if (unexcused.length > 0 || stale.length > 0) process.exit(1);
  console.log(`UI copy: nothing off-system (${entries.length} recorded exception(s)).`);
}

/**
 * The matcher's tests, as fixtures beside the matcher, for the reason
 * `check-design-tokens.mjs` gives: nothing in the repo tests a script, and
 * every case that matters is a matching decision.
 */
function selfTest() {
  const cases = [
    // copy-loading-ellipsis: in text, attributes, branches, toasts and runs.
    ["<p>Loading…</p>", ["copy-loading-ellipsis"]],
    ["<p>Saving changes...</p>", ["copy-loading-ellipsis"]],
    ["<p>Loading&hellip;</p>", ["copy-loading-ellipsis"]],
    ["<p>Loading {name}…</p>", ["copy-loading-ellipsis"]],
    ["<p>Signing in <b>{account}</b>…</p>", ["copy-loading-ellipsis"]],
    ['<p>{"Fetching runners…"}</p>', ["copy-loading-ellipsis"]],
    ['<p>{busy ? "Checking…" : "Check"}</p>', ["copy-loading-ellipsis"]],
    ['<Button title="Waiting for approval…" />', ["copy-loading-ellipsis"]],
    ["<Button aria-label={`Removing ${name}…`} />", ["copy-loading-ellipsis"]],
    ['<Empty emptyLabel="Syncing…" />', ["copy-loading-ellipsis"]],
    ['toast("Copying…")', ["copy-loading-ellipsis"]],
    ['toast.promise(p, { loading: "Applying…", success: "Applied" })', ["copy-loading-ellipsis"]],
    ['const items = [{ label: "Moving…" }];', ["copy-loading-ellipsis"]],
    // ...but a dialog-opening verb keeps its ellipsis, and a stop ends a clause.
    // Any progressive verb, not a list of them.
    ["<p>Uploading 3 files…</p>", ["copy-loading-ellipsis"]],
    ['<Button>{busy ? "Signing out…" : "Sign out"}</Button>', ["copy-loading-ellipsis"]],
    // -ing words that are not progress, and no -ing word at all.
    ["<p>Nothing to show…</p>", []],
    ["<p>Something went wrong…</p>", []],
    ['<MenuItem label="Bring your own key…" />', []],
    ['<MenuItem label="Rename…" />', []],
    ["<p>Open file…</p>", []],
    ["<p>Sign in…</p>", []],
    ["<p>Loading failed. Retry…</p>", []],
    ["<p>Loading</p>", []],
    // Through a variable: the loading rule reads every string in the module.
    ['const label = busy ? "Saving…" : "Save";', ["copy-loading-ellipsis"]],
    ["function f() { return `Starting on ${name}…`; }", ["copy-loading-ellipsis"]],
    ['<ReadState loading="Reading members…" />', ["copy-loading-ellipsis"]],
    ['<p>{fixing ? "Fixing…" : "Fix"}</p>', ["copy-loading-ellipsis"]],
    // ...except logs, types, comments and values.
    ['console.warn("Loading… took too long");', []],
    ['type P = { label: "Loading…" }; const x = <T,>(a: T) => a;', []],
    ["// Loading… is banned on screen", []],
    ["<code>Loading…</code>", []],
    // The other copy rules read only strings that reach the screen.
    ['const action = "unlock"; fetchThing("https://volli.dev/api");', []],
    ['<div data-kind="unlock" className="x" />', []],
    // copy-banned-word.
    ["<p>A seamless way in.</p>", ["copy-banned-word"]],
    ['<Row description="Leverage your runners" />', ["copy-banned-word"]],
    ['toastError("Unlocked a robust path", { description: "x" })', ["copy-banned-word"]],
    ["<p>Elevated</p>", ["copy-banned-word"]],
    ["<p>Elevation, unlockable, harness</p>", []],
    // copy-url-in-ui: text yes, href no, code no.
    ["<p>See https://volli.dev/docs for more.</p>", ["copy-url-in-ui"]],
    ['<Input title="Opens https://mcp.example.com" />', ["copy-url-in-ui"]],
    ['toast("Saved to https://volli.dev/r/1")', ["copy-url-in-ui"]],
    // A URL field's placeholder is its format, not copy.
    ['<Input type="url" placeholder="https://mcp.example.com" />', []],
    ['<a href="https://volli.dev">Docs</a>', []],
    ["<pre>curl -fsSL https://volli.dev/install | sh</pre>", []],
    // markup-native-select, and the primitive that replaces it.
    ["<select value={v}><option>A</option></select>", ["markup-native-select"]],
    ["<Select value={v} />", []],
    // markup-settings-description, on the kit's shapes only.
    [
      '<PrefRow label="Retention" description="Deletes after 30 days">x</PrefRow>',
      ["markup-settings-description"],
    ],
    ['<PrefSection title="Display" description={note} />', ["markup-settings-description"]],
    ['<SettingsRow label="A" description="B" />', ["markup-settings-description"]],
    ['<PrefRow label="Retention" hint="Deletes after 30 days">x</PrefRow>', []],
    ["<DialogDescription>Run this command.</DialogDescription>", []],
    ['<Sheet description="Run this command." />', []],
    // icon-duotone, as an attribute, a branch, or an IconContext value.
    ['<Gear weight="duotone" />', ["icon-duotone"]],
    ['<Gear weight={on ? "fill" : "duotone"} />', ["icon-duotone"]],
    ['<IconContext.Provider value={{ weight: "duotone" }} />', ["icon-duotone"]],
    ['<><Gear weight="fill" /><Gear weight="bold" /></>', []],
    // One string, one report, even when two contexts reach it.
    ['toast.error("x", { description: "Loading…" })', ["copy-loading-ellipsis"]],
  ];

  let failures = 0;
  for (const [source, expected] of cases) {
    let actual;
    try {
      actual = violations("fixture.tsx", source).map(({ rule }) => rule);
    } catch (error) {
      actual = [`threw: ${error.message}`];
    }
    const same =
      actual.length === expected.length && expected.every((rule, index) => actual[index] === rule);
    if (!same) {
      failures += 1;
      console.error(
        `FAIL ${JSON.stringify(source)}\n  expected [${expected}]\n  actual   [${actual}]`,
      );
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} of ${cases.length} matcher case(s) failed.`);
    process.exit(1);
  }
  console.log(`UI-copy matcher: ${cases.length} cases pass.`);
}

if (process.argv.includes("--self-test")) selfTest();
else main();
