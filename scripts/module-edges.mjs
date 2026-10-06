/**
 * The repository's module-edge scanner for source guards (VC-632).
 *
 * A guard that asks "does this file import X?" needs every way a TypeScript or
 * JavaScript file names a module, in every legal quoting. This scanner finds:
 *
 * - static `import … from "x"`, `export … from "x"` and side-effect `import "x"`,
 *   which the language only allows with `'` or `"`;
 * - dynamic `import("x")`, `require("x")` and `vi.mock`/`vi.doMock`/`vi.unmock`/
 *   `vi.doUnmock`/`vi.importActual`/`vi.importMock`, with `'`, `"` or a
 *   backtick template. `typeof import("x")` in a type argument is found too.
 *
 * It is a context matcher, not a parser: a literal counts only right after one
 * of those keywords, so a package name quoted in prose or in an assertion is not
 * an edge. It errs towards flagging: an edge-shaped line inside a comment still
 * counts. Escapes in a literal are decoded, so `"@volli\/x"` is `@volli/x`. A
 * template with a substitution is reported with `interpolated: true` and its raw
 * text, so a guard can still match its static head.
 *
 * Dependency-free plain ESM, so a Node codemod and a Vitest guard in any package
 * import the same file by relative path. Test and tooling code only.
 */

// A keyword, not the tail of a property, identifier or hyphenated word.
const KEYWORD = String.raw`(?<![\w$.-])`;
const STATIC_CONTEXTS = [
  String.raw`${KEYWORD}from\s*`, // import … from, export … from
  String.raw`${KEYWORD}import\s*`, // side-effect import "x"
];
const CALL_CONTEXTS = [
  String.raw`${KEYWORD}import\s*\(\s*`,
  String.raw`(?<![\w$-])require\s*\(\s*`, // also `module.require(…)`
  String.raw`${KEYWORD}vi\s*\.\s*(?:mock|doMock|unmock|doUnmock|importActual|importMock)\s*(?:<[^>]*>)?\s*\(\s*`,
];
const QUOTED = String.raw`"(?:[^"\\\n]|\\[\s\S])*"|'(?:[^'\\\n]|\\[\s\S])*'`;
const TEMPLATE = String.raw`\x60(?:[^\x60\\]|\\[\s\S])*\x60`;

const PATTERNS = [
  ...STATIC_CONTEXTS.map((context) => ({
    kind: "static",
    pattern: new RegExp(`(${context})(${QUOTED})`, "g"),
  })),
  ...CALL_CONTEXTS.map((context) => ({
    kind: "call",
    pattern: new RegExp(`(${context})(${QUOTED}|${TEMPLATE})`, "g"),
  })),
];

/** The value of a literal's body, with the escapes a module specifier could hide behind decoded. */
function decode(body) {
  return body.replace(
    /\\(?:x([\da-fA-F]{2})|u\{([\da-fA-F]+)\}|u([\da-fA-F]{4})|(\r\n|[\s\S]))/g,
    (_all, hex, braced, unicode, other) => {
      const code = hex ?? braced ?? unicode;
      if (code !== undefined) return String.fromCodePoint(Number.parseInt(code, 16));
      return other === "\n" || other === "\r\n" || other === "\r" ? "" : other;
    },
  );
}

/**
 * Every module edge in `source`, in source order.
 *
 * @param {string} source
 * @returns {import("./module-edges.d.mts").ModuleEdge[]}
 */
export function moduleEdges(source) {
  const byStart = new Map();
  for (const { pattern } of PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const literal = match[2];
      const start = match.index + match[1].length;
      const quote = literal[0];
      const body = literal.slice(1, -1);
      const interpolated = quote === "`" && /(?<!\\)\$\{/.test(body);
      byStart.set(start, {
        specifier: interpolated ? body : decode(body),
        quote,
        interpolated,
        start,
        end: start + literal.length,
      });
    }
  }
  return [...byStart.values()].toSorted((a, b) => a.start - b.start);
}

/**
 * Whether `edge` names `packageName` itself or one of its subpaths. An
 * interpolated template matches when its static head already does.
 *
 * @param {import("./module-edges.d.mts").ModuleEdge} edge
 * @param {string} packageName
 */
export function namesPackage(edge, packageName) {
  const { specifier } = edge;
  if (specifier === packageName || specifier.startsWith(`${packageName}/`)) return true;
  if (!edge.interpolated) return false;
  const head = specifier.slice(0, specifier.indexOf("${"));
  return head === packageName;
}

/**
 * The specifiers in `source` naming `packageName` or a subpath, in source order.
 *
 * @param {string} source
 * @param {string} packageName
 */
export function importsOfPackage(source, packageName) {
  return moduleEdges(source)
    .filter((edge) => namesPackage(edge, packageName))
    .map((edge) => edge.specifier);
}
