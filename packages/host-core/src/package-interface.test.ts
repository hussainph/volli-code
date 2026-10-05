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
 *
 * The interface itself is one entry per cluster (`src/entries/<cluster>.ts`,
 * mapped as `./<cluster>`), the root, and `./testing`. Each entry is an explicit
 * list of re-exports; nothing inside the package imports one. Test support
 * stays out of production code, and the one Session writer's constructors are
 * served by `./testing` alone, so only `createHostCore` builds the writer a
 * running host uses.
 */
import { globSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

const SRC = fileURLToPath(new URL(".", import.meta.url));
const SELF_NAME = ["@volli", "host-core"].join("/");
const MANIFEST = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  exports: Record<string, { types: string; import: string }>;
};

/** Test support: served by `./testing`, imported by tests and by each other, never by production code. */
const TEST_SUPPORT = [
  "testing/**",
  "db/test-helpers.ts",
  "session-control/test-support.ts",
  "worktree/scripted-git.ts",
  "backup/test-fixture.ts",
  "secrets/test-support/**",
  "web/test-support/**",
];
/** Built once, by `createHostCore`; a second one is a second Session writer. */
const SESSION_WRITER_CONSTRUCTORS = [
  "createSqliteSessionLedger",
  "SqliteSessionLedger",
  "createHostSessionEngine",
  "createSessionEngine",
  "createTestSessionEngine",
];

function read(file: string): string {
  return readFileSync(new URL(file, new URL(".", import.meta.url)), "utf8");
}

function sources(pattern = "**/*.{ts,tsx,mts}"): string[] {
  return globSync(pattern, { cwd: SRC });
}

const isTest = (file: string) => /\.test\.tsx?$/.test(file);
const testSupport = new Set(TEST_SUPPORT.flatMap((pattern) => sources(pattern)));

/** Every relative specifier `file` imports, resolved to a path under src/ (extension-free). */
function relativeImports(file: string): string[] {
  const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/") + 1) : "";
  return IMPORT_CONTEXTS.flatMap((context) => {
    const pattern = new RegExp(`${context}(["'])(\\.{1,2}\\/[^"']*)\\1`, "g");
    return [...read(file).matchAll(pattern)].map((match) =>
      new URL(match[2]!, `file:///src/${dir}`).pathname.slice("/src/".length).replace(/\.ts$/, ""),
    );
  });
}

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
    const offenders = sources().flatMap((file) =>
      importsOf(read(file), SELF_NAME).map((specifier) => `${file}: ${specifier}`),
    );
    expect(offenders).toEqual([]);
  });

  it("exports one entry per cluster, the root and ./testing, with no wildcard", () => {
    for (const [key, target] of Object.entries(MANIFEST.exports)) {
      expect(key).not.toContain("*");
      expect(target.types).toBe(target.import);
      if (key === ".") expect(target.import).toBe("./src/index.ts");
      else if (key === "./testing") expect(target.import).toBe("./src/testing/index.ts");
      else expect(target.import).toBe(`./src/entries/${key.slice(2)}.ts`);
    }
    const clusters = Object.keys(MANIFEST.exports).filter(
      (key) => key !== "." && key !== "./testing",
    );
    expect(clusters.map((key) => `entries/${key.slice(2)}.ts`).toSorted()).toEqual(
      sources("entries/*.ts").toSorted(),
    );
  });

  it("lists each entry's names explicitly: re-exports only, no export *", () => {
    for (const file of [...sources("entries/*.ts"), "testing/index.ts"]) {
      const code = read(file)
        .replaceAll(/\/\*[\s\S]*?\*\//g, "")
        .replaceAll(/^\s*\/\/.*$/gm, "");
      const statements = code
        .split(";")
        .map((statement) => statement.trim())
        .filter(Boolean);
      for (const statement of statements) {
        expect(statement, `${file}: ${statement}`).toMatch(
          /^export (type )?\{[^}]*\} from "\.{1,2}\/[^"]+"$/,
        );
      }
    }
  });

  it("never imports its own entries from inside the package", () => {
    const offenders = sources()
      .filter((file) => !file.startsWith("entries/") && !isTest(file))
      .flatMap((file) =>
        relativeImports(file)
          .filter((target) => target.startsWith("entries/"))
          .map((target) => `${file}: ${target}`),
      );
    expect(offenders).toEqual([]);
  });

  it("keeps test support out of production code", () => {
    const supportTargets = new Set([...testSupport].map((file) => file.replace(/\.ts$/, "")));
    supportTargets.add("testing");
    const offenders = sources()
      .filter((file) => !isTest(file) && !testSupport.has(file))
      .flatMap((file) =>
        relativeImports(file)
          .filter((target) => supportTargets.has(target) || supportTargets.has(`${target}/index`))
          .map((target) => `${file}: ${target}`),
      );
    expect(offenders).toEqual([]);
  });

  it("serves the Session writer's constructors from ./testing alone", () => {
    const offenders = sources("entries/*.ts").flatMap((file) =>
      SESSION_WRITER_CONSTRUCTORS.filter((name) =>
        new RegExp(`\\b${name}\\b`).test(read(file)),
      ).map((name) => `${basename(file)}: ${name}`),
    );
    expect(offenders).toEqual([]);
    expect(read("testing/index.ts")).toMatch(/\bcreateSqliteSessionLedger\b/);
  });
});
