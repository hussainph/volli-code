/**
 * host-core's package interface is its `exports` map, not its file tree (VC-632).
 *
 * A host-core file that imports its own package by name (`@volli/host-core/x`)
 * makes `x` impossible to stop exporting: the package would break itself. So
 * inside `src/`, files import each other by relative path, and this scan names
 * any file that does not. It covers static and dynamic imports, re-exports,
 * `vi.mock`/`importActual` and `require`. A quoted package name in prose or in
 * an assertion is not a module edge and is ignored.
 *
 * `node scripts/codemods/host-core-relative-imports.mjs` rewrites offenders.
 */
import { globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

const SRC = fileURLToPath(new URL(".", import.meta.url));
const SELF_NAME = ["@volli", "host-core"].join("/");

/**
 * The shapes that lead to a module specifier. Scanned one at a time, so a
 * `typeof import("…")` inside `vi.importActual<…>(…)`'s type argument is found too.
 */
const IMPORT_CONTEXTS = [
  String.raw`\bfrom\s*`,
  String.raw`\bimport\s+`,
  String.raw`\bimport\s*\(\s*`,
  String.raw`\brequire\s*\(\s*`,
  String.raw`\bvi\.(?:mock|doMock|unmock|doUnmock|importActual|importMock)\s*(?:<[^>]*>)?\s*\(\s*`,
];

/** Every import-shaped specifier in `source` naming `packageName` or one of its subpaths, sorted. */
function importsOf(source: string, packageName: string): string[] {
  const escaped = packageName.replaceAll("/", "\\/");
  return IMPORT_CONTEXTS.flatMap((context) => {
    const pattern = new RegExp(`${context}(["'])(${escaped}(?:\\/[^"']*)?)\\1`, "g");
    return [...source.matchAll(pattern)].map((match) => match[2]!);
  }).toSorted();
}

describe("host-core's package interface", () => {
  it("finds the import shapes it guards", () => {
    const name = SELF_NAME;
    const sample = [
      `import { a } from "${name}/db";`,
      `export * from '${name}';`,
      `const m = await import("${name}/pty/manager");`,
      `vi.mock("${name}/worktree", () => ({}));`,
      `vi.importActual<typeof import("${name}/secrets")>("${name}/secrets");`,
      `import "${name}/side-effect";`,
      `// prose naming \`${name}/ports\` is not an import`,
      `expect(() => import.meta.resolve("${name}/sessions/engine")).toThrow();`,
    ].join("\n");
    expect(importsOf(sample, name)).toEqual(
      [
        `${name}/db`,
        name,
        `${name}/pty/manager`,
        `${name}/worktree`,
        `${name}/secrets`,
        `${name}/secrets`,
        `${name}/side-effect`,
      ].toSorted(),
    );
  });

  it("is imported by relative path from inside the package, never by its own name", () => {
    const offenders = globSync("**/*.{ts,tsx,mts}", { cwd: SRC }).flatMap((file) =>
      importsOf(readFileSync(new URL(file, new URL(".", import.meta.url)), "utf8"), SELF_NAME).map(
        (specifier) => `${file}: ${specifier}`,
      ),
    );
    expect(offenders).toEqual([]);
  });
});
