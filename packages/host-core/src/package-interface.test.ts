/**
 * host-core's package interface is its `exports` map, not its file tree (VC-632).
 *
 * A host-core file that imports its own package by name (`@volli/host-core/x`)
 * makes `x` impossible to stop exporting: the package would break itself. So
 * inside `src/`, files import each other by relative path, and this scan names
 * any file that does not. The repository's module-edge scanner
 * (`scripts/module-edges.mjs`) finds the edges: static and dynamic imports,
 * re-exports, `vi.mock`/`importActual` and `require`, in `'`, `"` and backtick
 * quoting. A quoted package name in prose or in an assertion is not an edge.
 *
 * `node scripts/codemods/host-core-relative-imports.mjs` rewrites offenders.
 *
 * The interface itself is one entry per cluster (`src/entries/<cluster>.ts`,
 * mapped as `./<cluster>`), the root, and `./testing`. Each entry is an explicit
 * list of re-exports; nothing inside the package imports one. Test support
 * stays out of production code, and the one Session writer's constructors are
 * served by `./testing` alone, so only `createHostCore` builds the writer a
 * running host uses. That last check reads every production entry the
 * `exports` map serves, the root included, and follows aliases, `export *`
 * and namespace re-exports to the name each export was declared under.
 */
import {
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

import { importsOfPackage, moduleEdges } from "../../../scripts/module-edges.mjs";

const SRC = fileURLToPath(new URL(".", import.meta.url));
const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const SELF_NAME = ["@volli", "host-core"].join("/");
const SESSION_ENGINE_PACKAGE = ["@volli", "session-engine"].join("/");

interface Manifest {
  exports: Record<string, { types: string; import: string }>;
}
const readManifest = (packageDir: string): Manifest =>
  JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as Manifest;
const MANIFEST = readManifest(PACKAGE);

/** Test support: served by `./testing`, imported by tests and by each other, never by production code. */
const TEST_SUPPORT = [
  "testing/**",
  "db/test-helpers.ts",
  "session-control/test-support.ts",
  "worktree/scripted-git.ts",
  "backup/test-fixture.ts",
  "secrets/test-support/**",
  "web/test-support/**",
  "browser/test-support/**",
];
/** Built once, by `createHostCore`; a second one is a second Session writer. */
const SESSION_WRITER_CONSTRUCTORS = new Set([
  "createSqliteSessionLedger",
  "SqliteSessionLedger",
  "createHostSessionEngine",
  "createSessionEngine",
  "createTestSessionEngine",
]);

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
  return moduleEdges(read(file))
    .filter((edge) => /^\.{1,2}\//.test(edge.specifier))
    .map((edge) =>
      new URL(edge.specifier, `file:///src/${dir}`).pathname
        .slice("/src/".length)
        .replace(/\.ts$/, ""),
    );
}

/** `file: specifier` for every source under `root` that imports host-core by its own name. */
function selfImportOffenders(root: string): string[] {
  return globSync("**/*.{ts,tsx,mts}", { cwd: root }).flatMap((file) =>
    importsOfPackage(readFileSync(join(root, file), "utf8"), SELF_NAME).map(
      (specifier) => `${file}: ${specifier}`,
    ),
  );
}

/** Writes `files` (path → source) under a fresh temporary directory and hands it to `use`. */
function withFixtureTree(
  prefix: string,
  files: Record<string, string>,
  use: (root: string) => void,
) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  try {
    for (const [file, source] of Object.entries(files)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), `${source}\n`);
    }
    use(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// --- A module's exported surface, statically --------------------------------
//
// Enough of TypeScript's export syntax to answer "which declared names can a
// client reach through this entry": named and aliased re-exports, local export
// lists over imports, declarations, `export *` and `export * as ns`. The code is
// formatted, so every statement starts a line.

interface ModuleShape {
  /** `export { local as exported } [from "x"]`; `from` null is a local list. */
  readonly named: readonly { exported: string; local: string; from: string | null }[];
  readonly stars: readonly { from: string; as: string | null }[];
  readonly declared: ReadonlySet<string>;
  /** Local binding → its import (`*` for a namespace import). */
  readonly imports: ReadonlyMap<string, { imported: string; from: string }>;
}

const NAMED_EXPORT = /^export\s+(?:type\s+)?\{([^}]*)\}(?:\s*from\s*(["'])([^"'\n]+)\2)?/gm;
const STAR_EXPORT = /^export\s+(?:type\s+)?\*\s*(?:as\s+([\w$]+)\s*)?from\s*(["'])([^"'\n]+)\2/gm;
const DECLARED_EXPORT =
  /^export\s+(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\s*\*?|const|let|var|class|interface|type|enum|namespace)\s+([\w$]+)/gm;
const IMPORT = /^import\s+(?:type\s+)?([^;"']*?)\s*from\s*(["'])([^"'\n]+)\2/gm;

/** `a`, `type a`, `a as b`, `default as b` → `[local, exported]` pairs; comments dropped. */
function listItems(list: string): [string, string][] {
  return list
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .replaceAll(/\/\/.*$/gm, "")
    .split(",")
    .map((item) => item.trim().replace(/^type\s+/, ""))
    .filter(Boolean)
    .map((item) => {
      const [local, exported = local] = item.split(/\s+as\s+/);
      return [local!, exported];
    });
}

const shapes = new Map<string, ModuleShape>();
function shapeOf(file: string): ModuleShape {
  const cached = shapes.get(file);
  if (cached !== undefined) return cached;
  const source = readFileSync(file, "utf8");
  const imports = new Map<string, { imported: string; from: string }>();
  for (const [, clause, , from] of source.matchAll(IMPORT)) {
    const namespace = /\*\s*as\s+([\w$]+)/.exec(clause!);
    if (namespace) imports.set(namespace[1]!, { imported: "*", from: from! });
    const braces = /\{([^}]*)\}/.exec(clause!);
    for (const [imported, local] of braces ? listItems(braces[1]!) : [])
      imports.set(local, { imported, from: from! });
    const defaultName = /^([\w$]+)\s*(?:,|$)/.exec(clause!);
    if (defaultName && defaultName[1] !== "type")
      imports.set(defaultName[1]!, { imported: "default", from: from! });
  }
  const shape: ModuleShape = {
    named: [...source.matchAll(NAMED_EXPORT)].flatMap(([, list, , from]) =>
      listItems(list!).map(([local, exported]) => ({ exported, local, from: from ?? null })),
    ),
    stars: [...source.matchAll(STAR_EXPORT)].map(([, as, , from]) => ({
      from: from!,
      as: as ?? null,
    })),
    declared: new Set([...source.matchAll(DECLARED_EXPORT)].map((match) => match[1]!)),
    imports,
  };
  shapes.set(file, shape);
  return shape;
}

/** The source file a relative specifier names, or null for another package. */
function resolveModule(fromFile: string, specifier: string): string | null {
  if (!/^\.{1,2}\//.test(specifier)) return null;
  const base = resolve(dirname(fromFile), specifier.replace(/\.js$/, ""));
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`${fromFile}: cannot resolve ${specifier}`);
}

/** Another package's names are opaque; an `export *` of the engine package is named for it. */
const externalStar = (from: string) => `* from ${from}`;

/**
 * Every name `exported` goes by on its way from its declaration to `file`'s
 * surface, the exported name first. Undefined when `file` does not export it.
 */
function bindingChain(
  file: string,
  exported: string,
  seen = new Set<string>(),
): string[] | undefined {
  const key = `${file}#${exported}`;
  if (seen.has(key)) return undefined;
  seen.add(key);
  const shape = shapeOf(file);
  const through = (from: string, local: string): string[] => {
    const target = resolveModule(file, from);
    if (target === null) return [local];
    if (local === "*") return [...surfaceOf(target, seen).values()].flat();
    return bindingChain(target, local, seen) ?? [local];
  };
  for (const entry of shape.named) {
    if (entry.exported !== exported) continue;
    if (entry.from !== null) return [exported, ...through(entry.from, entry.local)];
    const imported = shape.imports.get(entry.local);
    if (imported !== undefined) return [exported, ...through(imported.from, imported.imported)];
    return [exported, entry.local];
  }
  if (shape.declared.has(exported)) return [exported];
  for (const star of shape.stars) {
    if (star.as === exported) return [exported, ...through(star.from, "*")];
  }
  for (const star of shape.stars) {
    if (star.as !== null || exported === "default") continue;
    const target = resolveModule(file, star.from);
    const chain = target === null ? undefined : bindingChain(target, exported, seen);
    if (chain !== undefined) return chain;
  }
  return undefined;
}

/** `file`'s exported surface: each exported name → the names it goes by (see {@link bindingChain}). */
function surfaceOf(file: string, seen = new Set<string>()): Map<string, string[]> {
  const surface = new Map<string, string[]>();
  if (seen.has(file)) return surface; // an `export *` cycle adds nothing new
  seen.add(file);
  const shape = shapeOf(file);
  const names = new Set([
    ...shape.named.map((entry) => entry.exported),
    ...shape.declared,
    ...shape.stars.flatMap((star) => (star.as === null ? [] : [star.as])),
  ]);
  for (const star of shape.stars) {
    if (star.as !== null) continue;
    const target = resolveModule(file, star.from);
    if (target === null) surface.set(externalStar(star.from), [externalStar(star.from)]);
    else for (const name of surfaceOf(target, seen).keys()) if (name !== "default") names.add(name);
  }
  for (const name of names) surface.set(name, bindingChain(file, name, new Set(seen)) ?? [name]);
  return surface;
}

/** The `exports` map's production entries: every key but `./testing`, as source files. */
function productionEntries(packageDir: string): [string, string][] {
  return Object.entries(readManifest(packageDir).exports)
    .filter(([key]) => key !== "./testing")
    .map(([key, target]) => [key, resolve(packageDir, target.import)]);
}

/** `entry: exported (chain)` for every production export that is, or aliases, a forbidden name. */
function productionExportsMatching(
  packageDir: string,
  forbidden: (name: string) => boolean,
): string[] {
  return productionEntries(packageDir).flatMap(([key, file]) =>
    [...surfaceOf(file)].flatMap(([exported, chain]) =>
      chain.some(forbidden) ? [`${key}: ${exported} (${chain.join(" <- ")})`] : [],
    ),
  );
}

const isWriterConstructor = (name: string) =>
  SESSION_WRITER_CONSTRUCTORS.has(name) ||
  name === externalStar(SESSION_ENGINE_PACKAGE) ||
  name.startsWith(`${externalStar(SESSION_ENGINE_PACKAGE)}/`);
const isTestReset = (name: string) => name.endsWith("ForTest");

describe("host-core's package interface", () => {
  it("flags a self-name import in every quoting form, in a scanned source file", () => {
    // A production-shaped fixture tree, scanned by the guard itself: one file
    // per edge shape and delimiter, so a scanner that drops any of them fails.
    const name = SELF_NAME;
    const fixtures: Record<string, string> = {
      "static-double.ts": `import { a } from "${name}/db";`,
      "static-single.ts": `import { a } from '${name}/db';`,
      "reexport.ts": `export * from "${name}";`,
      "side-effect.ts": `import '${name}/side-effect';`,
      "dynamic-double.ts": `export const m = import("${name}/pty");`,
      "dynamic-single.ts": `export const m = import('${name}/pty');`,
      "dynamic-template.ts": `export const m = import(\`${name}/pty\`);`,
      "dynamic-interpolated.ts": `export const m = (x: string) => import(\`${name}/\${x}\`);`,
      "require-template.ts": `export const m = require(\`${name}/db\`);`,
      "mock-template.test.ts": `vi.mock(\`${name}/worktree\`, () => ({}));`,
      "do-mock-single.test.ts": `vi.doMock('${name}/worktree');`,
      "import-actual-template.test.ts": `await vi.importActual(\`${name}/secrets\`);`,
      "nested/type-import.ts": `export type T = typeof import(\`${name}/secrets\`);`,
      "prose.ts": `// prose naming \`${name}/ports\` is not an import\nexport const s = "${name}";`,
    };
    withFixtureTree("host-core-self-import-", fixtures, (root) => {
      const flagged = new Set(selfImportOffenders(root).map((line) => line.split(":")[0]));
      expect([...flagged].toSorted()).toEqual(
        Object.keys(fixtures)
          .filter((file) => file !== "prose.ts")
          .toSorted(),
      );
    });
  });

  it("is imported by relative path from inside the package, never by its own name", () => {
    expect(selfImportOffenders(SRC)).toEqual([]);
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

  it("finds a writer constructor behind any production entry, the root included", () => {
    // A package-shaped fixture: its own `exports` map, so the guard derives the
    // entries exactly as it does for host-core. Each entry but `./clean` and
    // `./testing` reaches a writer constructor some other way.
    const exportsMap = Object.fromEntries(
      [
        [".", "index.ts"],
        ...[
          "alias",
          "star",
          "namespace",
          "type-alias",
          "local-list",
          "indirect",
          "engine",
          "engine-star",
          "clean",
        ].map((key) => [`./${key}`, `entries/${key}.ts`]),
        ["./testing", "testing/index.ts"],
      ].map(([key, file]) => [key, { types: `./src/${file}`, import: `./src/${file}` }]),
    );
    const engine = SESSION_ENGINE_PACKAGE;
    withFixtureTree(
      "host-core-writer-entries-",
      {
        "package.json": JSON.stringify({ exports: exportsMap }),
        "src/session-control/sqlite-ledger.ts":
          "export class SqliteSessionLedger {}\nexport function createSqliteSessionLedger() {}",
        "src/session-control/index.ts":
          'export * from "./sqlite-ledger";\nexport function publishSessionListingRow() {}',
        "src/sessions/engine.ts": "export function createHostSessionEngine() {}",
        "src/middle.ts": 'export { createHostSessionEngine as build } from "./sessions/engine";',
        "src/index.ts":
          'export { createSqliteSessionLedger } from "./session-control/sqlite-ledger";\nexport function createHostCore() {}',
        "src/entries/alias.ts":
          'export { createSqliteSessionLedger as openLedger } from "../session-control";',
        "src/entries/star.ts": 'export * from "../session-control";',
        "src/entries/namespace.ts": 'export * as control from "../session-control";',
        "src/entries/type-alias.ts":
          'export type { SqliteSessionLedger as Ledger } from "../session-control/sqlite-ledger";',
        "src/entries/local-list.ts":
          'import { createSqliteSessionLedger as make } from "../session-control";\nexport { make };',
        "src/entries/indirect.ts": 'export { build as assemble } from "../middle";',
        "src/entries/engine.ts": `export { createSessionEngine as engine } from "${engine}";`,
        "src/entries/engine-star.ts": `export * from "${engine}";`,
        "src/entries/clean.ts": 'export { publishSessionListingRow } from "../session-control";',
        "src/testing/index.ts":
          'export { createSqliteSessionLedger } from "../session-control/sqlite-ledger";',
      },
      (root) => {
        const flagged = new Set(
          productionExportsMatching(root, isWriterConstructor).map((line) => line.split(":")[0]),
        );
        expect([...flagged].toSorted()).toEqual(
          Object.keys(exportsMap)
            .filter((key) => key !== "./clean" && key !== "./testing")
            .toSorted(),
        );
      },
    );
  });

  it("serves the Session writer's constructors from ./testing alone", () => {
    expect(productionEntries(PACKAGE).map(([key]) => key)).toContain(".");
    expect(productionExportsMatching(PACKAGE, isWriterConstructor)).toEqual([]);
    const testing = surfaceOf(join(SRC, "testing/index.ts"));
    expect(testing.has("createSqliteSessionLedger")).toBe(true);
  });

  it("serves test-only resets from ./testing alone", () => {
    expect(productionExportsMatching(PACKAGE, isTestReset)).toEqual([]);
    const testing = surfaceOf(join(SRC, "testing/index.ts"));
    for (const reset of [
      "resetDeletionLeasesForTest",
      "resetWorktreeSnapshotsForTest",
      "resetOrphanScanForTest",
      "resetRetentionWatcherForTest",
    ])
      expect(testing.has(reset), reset).toBe(true);
  });
});
