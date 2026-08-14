/**
 * Fails when a source file paints an off-ladder utility.
 *
 *     node apps/desktop/scripts/check-design-tokens.mjs             # the gate
 *     node apps/desktop/scripts/check-design-tokens.mjs --self-test # the matcher's own tests
 *
 * WHY THIS EXISTS. The design system's system of record is the token ladder in
 * `globals.css @theme` and the class constants in `ui/`, not a document. A
 * document cannot fail. Every dimension this repo has collapsed — the radius
 * rungs, the type scale, the status family — was collapsed once by hand and
 * would re-scatter one convenient `rounded-2xl` at a time, because a stock
 * Tailwind utility is always in reach and never announces that it has left the
 * ladder. `docs/DESIGN.md` said "no arbitrary `text-[Npx]`" and that held; it
 * said nothing enforceable about radius, and radius drifted to eleven values.
 * The difference was a check, so this is the check.
 *
 * WHAT IT BANS is deliberately narrow: a rule earns its place by naming a
 * utility the ladder already answers, so the fix is always a rename and never a
 * design decision. {@link RULES} carries the reasoning per rule.
 *
 * WHAT IT SCANS is class strings — string literals shaped like class lists (see
 * {@link classLists}). Comments and prose never match, so a comment may discuss
 * `rounded-2xl` and a test may be named "shares the composer stack's rounded
 * shell" without either becoming a violation. Nothing here parses TypeScript;
 * a class list is recognised by its shape, which is the only property that
 * survives `cn()`, `cva()`, template literals and shared class constants alike.
 *
 * THE ALLOWLIST (`design-token-allowlist.json`) is how an escape becomes a
 * recorded decision instead of a blind spot. Every entry carries a `reason`,
 * and an entry that no longer matches anything FAILS — retiring a sweep's
 * entries is part of finishing the sweep, not a cleanup someone might notice
 * later. That is the property that keeps the file from becoming a graveyard.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(HERE, "../../..");
const SCAN_ROOT = resolvePath(HERE, "../src");
const ALLOWLIST = resolvePath(HERE, "design-token-allowlist.json");

/**
 * The lab is browser-only scratch space that MEMORY records as disposable, and
 * its whole job is trying values the app has not adopted — a guard over it
 * would be a guard against the one thing it exists for. `icon-weight-audit`
 * names the case sharpest: it paints off-ladder values ON PURPOSE, as recorded
 * measurement evidence, and "fixing" it would delete the measurement.
 */
const SKIP_DIRS = new Set(["lab"]);

const SOURCE_EXTENSIONS = [".ts", ".tsx"];

/**
 * One banned utility family.
 *
 * `match` receives a class token with its variants already stripped (see
 * {@link baseUtility}), so a rule never has to spell `hover:` or `dark:` and
 * cannot miss a banned utility merely because it arrived behind a variant.
 */
const RULES = [
  {
    id: "radius-stock-2xl",
    // 16px, and stock: `@theme inline` overrides sm/md/lg/xl only, so this one
    // reads Tailwind's unauthored 1rem and a change to the ladder cannot move
    // it. The container rung (`rounded-container`, 20px) is the answer.
    summary: "rounded-2xl is stock Tailwind (16px) and does not ride the radius ladder",
    match: (base) => /^-?rounded(-(?:t|r|b|l|tl|tr|br|bl|s|e|ss|se|es|ee))?-2xl$/.test(base),
  },
  {
    id: "radius-arbitrary",
    // Every arbitrary radius in this app was a literal restatement of a rung
    // that already existed (`rounded-[10px]` for `rounded-lg`) or a fourth
    // derivation of the ladder invented in one file.
    summary: "arbitrary radius — name a rung instead",
    match: (base) => /^-?rounded(-(?:t|r|b|l|tl|tr|br|bl|s|e|ss|se|es|ee))?-\[.*\]$/.test(base),
  },
  {
    id: "radius-bare",
    // Bare `rounded` is `border-radius: .25rem` written as a literal, not a
    // theme key — the single largest escape from `--radius` in the app.
    // `rounded-full`, `rounded-control` and the rest are untouched.
    summary: "bare `rounded` is a 4px literal outside the ladder",
    match: (base) => base === "rounded" || base === "-rounded",
  },
  {
    id: "type-text-base",
    // 16px, and the six-step scale has no such rung. It survived only behind a
    // `md:` fallback that a 940px minimum window can never reach.
    summary: "text-base is off the type scale",
    match: (base) => base === "text-base",
  },
  {
    id: "status-raw-palette",
    // The status family is generated and hue-locked (`--positive`,
    // `--attention`, `--info`). A raw palette rung ignores the workspace canvas
    // and drags a hand-written `dark:` twin along with it — the exact drift the
    // generator's two-block rule exists to prevent.
    summary: "raw status palette — use --positive / --attention / --info",
    match: (base) => /(^|-)(emerald|amber|sky)-\d{2,3}(\/\d{1,3})?$/.test(base),
  },
  {
    id: "shadow-stock-tier",
    // Tailwind's stock shadows are untinted black — `rgb(0 0 0 / 0.05…0.25)` —
    // on a canvas whose own three tiers are tinted to it (`rgb(2 0 0)` in dark,
    // `rgb(72 42 30)` in light). The tiers are registered utilities now, so the
    // fix is always a rename by ROLE: a control, field or active tab is
    // `shadow-raised`, a panel or a dragged tile is `shadow-card`, and anything
    // that portals to the body is `shadow-overlay`.
    //
    // `shadow-none` and the arbitrary form are both untouched. The first is a
    // reset and resets nothing else spells; the second is currently three
    // zero-blur `shadow-[0_0_0_Npx_…]` rings, which are the focus idiom in
    // disguise and belong to the focus pass, not to a rung this ladder answers.
    summary: "stock shadow tier — use shadow-raised / shadow-card / shadow-overlay",
    match: (base) => /^-?shadow-(2xs|xs|sm|md|lg|xl|2xl)$/.test(base),
  },
  {
    id: "focus-ring-loud",
    // shadcn's 3px halo is tuned for a 36px control; this app's default is 28px
    // and its smallest is 20px, where 3px is a third of the shape. The one
    // focus recipe lives in `ui/field-classes.ts`.
    summary: "loud focus ring — the focus recipe lives in ui/field-classes.ts",
    match: (base) => /^ring-\[3px\]$/.test(base),
  },
];

/** Every `.ts`/`.tsx` file under `dir`, minus {@link SKIP_DIRS}. */
function sourceFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) found.push(...sourceFiles(path));
    } else if (SOURCE_EXTENSIONS.some((extension) => entry.endsWith(extension))) {
      found.push(path);
    }
  }
  return found;
}

/**
 * A class token's base utility: variants and the important marker removed.
 *
 * Splits on `:` only at bracket depth zero, because an arbitrary value is
 * allowed to contain one (`supports-[display:grid]:flex`, `[&:hover]:bg-x`) and
 * a naive split would cut those in the wrong place and answer with a fragment.
 */
function baseUtility(token) {
  let depth = 0;
  let start = 0;
  for (let index = 0; index < token.length; index += 1) {
    const character = token[index];
    if (character === "[" || character === "(") depth += 1;
    else if (character === "]" || character === ")") depth -= 1;
    else if (character === ":" && depth === 0) start = index + 1;
  }
  return token.slice(start).replace(/^!/, "");
}

/** The characters a Tailwind class token is built from — notably NOT `'`. */
const CLASS_TOKEN = /^[A-Za-z0-9_\-:./[\]()%,=&<>!*+#@~^$|{}]+$/;

/**
 * Whether a string literal is a class list rather than prose.
 *
 * Two signals, and both are about shape rather than vocabulary. Every token
 * must be built from the class charset — which an apostrophe is not, so
 * "shares the composer stack's rounded shell" is out on the first test. And at
 * least one token must show utility shape (a `-`, a variant `:`, an opacity `/`
 * or an arbitrary `[`) — which rules out the all-lowercase prose that survives
 * the charset test. A single-token literal is exempt from the second signal,
 * because `className="rounded"` is exactly the escape this guard is for.
 */
function isClassList(tokens) {
  if (!tokens.every((token) => CLASS_TOKEN.test(token))) return false;
  if (tokens.length === 1) return true;
  return tokens.some((token) => /[-:/[]/.test(token));
}

/**
 * Every class-list literal in a source file, with the line it starts on.
 *
 * A hand-rolled scan rather than a parse, for the reason the whole file is
 * dependency-free — but it is a scan that knows what it is skipping. Comments
 * are stepped over, so a comment naming a banned utility is documentation
 * rather than a violation.
 *
 * The one trap in TSX is the apostrophe in JSX text (`<p>Don't</p>`), which
 * opens a quote that never closes and would swallow the rest of the file. A
 * single- or double-quoted JS string cannot contain a raw newline, so hitting
 * one means this was never a string: the scan rewinds and carries on. That
 * single rule is what makes an unparsed scan safe here.
 */
function classLists(source) {
  const found = [];
  let line = 1;
  let index = 0;

  const advance = (to) => {
    for (let step = index; step < to; step += 1) if (source[step] === "\n") line += 1;
    index = to;
  };

  while (index < source.length) {
    const character = source[index];

    if (character === "/" && source[index + 1] === "/") {
      const stop = source.indexOf("\n", index);
      advance(stop === -1 ? source.length : stop);
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      const stop = source.indexOf("*/", index + 2);
      advance(stop === -1 ? source.length : stop + 2);
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      const startLine = line;
      const startIndex = index;
      let cursor = index + 1;
      let text = "";
      let closed = false;
      while (cursor < source.length) {
        const inner = source[cursor];
        if (inner === "\\") {
          cursor += 2;
          text += " ";
          continue;
        }
        if (inner === character) {
          closed = true;
          break;
        }
        // A raw newline ends any non-template literal: it was not one.
        if (inner === "\n" && character !== "`") break;
        // Template substitutions are holes in the class list, not tokens.
        if (character === "`" && inner === "$" && source[cursor + 1] === "{") {
          let depth = 1;
          cursor += 2;
          while (cursor < source.length && depth > 0) {
            if (source[cursor] === "{") depth += 1;
            else if (source[cursor] === "}") depth -= 1;
            cursor += 1;
          }
          text += " ";
          continue;
        }
        text += inner;
        cursor += 1;
      }
      if (closed) {
        advance(cursor + 1);
        found.push({ line: startLine, text });
      } else {
        advance(startIndex + 1);
      }
      continue;
    }
    advance(index + 1);
  }

  return found;
}

/** Every rule violation in one file's class strings. */
function violations(path, source) {
  const found = [];
  const lines = source.split("\n");
  for (const { line, text } of classLists(source)) {
    const tokens = text.split(/\s+/).filter(Boolean);
    if (!isClassList(tokens)) continue;
    for (const token of tokens) {
      const base = baseUtility(token);
      for (const rule of RULES) {
        if (rule.match(base)) {
          found.push({ path, line, token, rule: rule.id, content: lines[line - 1] ?? "" });
        }
      }
    }
  }
  return found;
}

/**
 * Reads the allowlist, failing loudly on a malformed entry.
 *
 * Every field is required, `reason` included: an entry without one is an escape
 * nobody has to defend, which is the state this file exists to prevent.
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

function main() {
  const entries = readAllowlist();
  const used = new Set();
  const unexcused = [];

  for (const path of sourceFiles(SCAN_ROOT)) {
    const relativePath = relative(REPO_ROOT, path);
    for (const violation of violations(relativePath, readFileSync(path, "utf8"))) {
      const index = entries.findIndex(
        (entry) =>
          entry.path === violation.path &&
          entry.rule === violation.rule &&
          violation.content.includes(entry.contains),
      );
      if (index === -1) unexcused.push(violation);
      else used.add(index);
    }
  }

  const stale = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ index }) => !used.has(index));

  if (unexcused.length > 0) {
    console.error(`${unexcused.length} off-ladder utility use(s):\n`);
    for (const { path, line, token, rule } of unexcused) {
      const summary = RULES.find(({ id }) => id === rule).summary;
      console.error(`  ${path}:${line}  ${token}\n      ${summary}`);
    }
    console.error(
      "\nMove each to the ladder, or record it in" +
        ` ${relative(REPO_ROOT, ALLOWLIST)} with a reason.`,
    );
  }

  if (stale.length > 0) {
    console.error(`\n${stale.length} stale allowlist entr(ies) — nothing matches them any more:\n`);
    for (const { entry } of stale) {
      console.error(`  ${entry.path}  ${entry.rule}  "${entry.contains}"`);
    }
    console.error("\nThe escape is gone, so its record should be too — delete these entries.");
  }

  if (unexcused.length > 0 || stale.length > 0) process.exit(1);
  console.log(`Design tokens: no off-ladder utilities (${entries.length} recorded exception(s)).`);
}

/**
 * The matcher's tests, as fixtures rather than a spec file.
 *
 * `vitest` reaches `src/renderer` and `src/main`; nothing in the repo tests a
 * script, and standing a third project up to reach `scripts/` would be more
 * machinery than the thing being tested. The cases that matter are all
 * matching decisions, so they live beside the matcher.
 */
function selfTest() {
  const cases = [
    // The bans.
    ['"rounded-2xl border"', ["radius-stock-2xl"]],
    ['"rounded-t-2xl"', ["radius-stock-2xl"]],
    ['"rounded-[10px] bg-card"', ["radius-arbitrary"]],
    ['"rounded-[calc(var(--radius)-5px)] p-2"', ["radius-arbitrary"]],
    ['"rounded-tl-[3px] p-2"', ["radius-arbitrary"]],
    ['"shrink-0 rounded border"', ["radius-bare"]],
    ['"rounded"', ["radius-bare"]],
    ['"hover:rounded bg-card"', ["radius-bare"]],
    ['"text-base md:text-sm"', ["type-text-base"]],
    ['"text-emerald-400 gap-1"', ["status-raw-palette"]],
    ['"dark:bg-amber-500/70 gap-1"', ["status-raw-palette"]],
    ['"text-sky-900 gap-1"', ["status-raw-palette"]],
    ['"focus-visible:ring-[3px] ring-ring/50"', ["focus-ring-loud"]],
    ['"rounded-lg bg-popover shadow-md"', ["shadow-stock-tier"]],
    ['"shadow-2xl"', ["shadow-stock-tier"]],
    ['"hover:shadow-lg transition-shadow"', ["shadow-stock-tier"]],
    ['"group-data-[variant=floating]:shadow-sm"', ["shadow-stock-tier"]],
    ['"shadow-xs shadow-2xs"', ["shadow-stock-tier", "shadow-stock-tier"]],
    // The ladder itself is never a violation.
    ['"rounded-full rounded-none rounded-sm rounded-md rounded-lg rounded-xl"', []],
    ['"rounded-control rounded-container rounded-row"', []],
    ['"rounded-t-lg rounded-r-none"', []],
    ['"text-label text-xs text-ui text-sm text-heading text-title"', []],
    ['"ring-2 ring-1 ring-ring/45"', []],
    ['"bg-positive text-attention-foreground border-info"', []],
    ['"shadow-raised shadow-card shadow-overlay shadow-none"', []],
    // Neighbouring namespaces this ladder has no rung for, and one zero-blur
    // box-shadow that is a focus ring wearing a shadow's name.
    ['"text-shadow-md drop-shadow-lg inset-shadow-sm"', []],
    ['"shadow-[0_0_0_1px_var(--sidebar-border)]"', []],
    // Colors that merely contain a banned word are not the banned utility.
    ['"bg-amberglow text-skyline"', []],
    ['"rounded-2xlarge"', []],
    // Prose is not a class list, in a string or out of one.
    ['it("shares the composer stack\'s rounded shell", () => {})', []],
    ['"Rounded corners"', []],
    ['"the rounded shell"', []],
    // Comments are documentation, including the ones naming a banned utility.
    ["// rounded-2xl was the composer's radius before the ladder", []],
    ["/* text-base is dead behind md:text-sm */", []],
    // An apostrophe in JSX text must not swallow the file.
    ['<p>Don\'t</p>\nconst a = "rounded-2xl";', ["radius-stock-2xl"]],
    // A template literal's substitution is a hole, not a token.
    ["`flex ${active ? on : off} rounded-2xl`", ["radius-stock-2xl"]],
  ];

  let failures = 0;
  for (const [source, expected] of cases) {
    const actual = violations("fixture.tsx", source).map(({ rule }) => rule);
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
  console.log(`Design-token matcher: ${cases.length} cases pass.`);
}

if (process.argv.includes("--self-test")) selfTest();
else main();
