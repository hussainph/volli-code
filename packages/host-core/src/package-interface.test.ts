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
 */
import { globSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

import { importsOfPackage } from "../../../scripts/module-edges.mjs";

const SRC = fileURLToPath(new URL(".", import.meta.url));
const SELF_NAME = ["@volli", "host-core"].join("/");

/** `file: specifier` for every source under `root` that imports host-core by its own name. */
function selfImportOffenders(root: string): string[] {
  return globSync("**/*.{ts,tsx,mts}", { cwd: root }).flatMap((file) =>
    importsOfPackage(readFileSync(join(root, file), "utf8"), SELF_NAME).map(
      (specifier) => `${file}: ${specifier}`,
    ),
  );
}

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
    const root = mkdtempSync(join(tmpdir(), "host-core-self-import-"));
    try {
      for (const [file, source] of Object.entries(fixtures)) {
        mkdirSync(dirname(join(root, file)), { recursive: true });
        writeFileSync(join(root, file), `${source}\n`);
      }
      const flagged = new Set(selfImportOffenders(root).map((line) => line.split(":")[0]));
      expect([...flagged].toSorted()).toEqual(
        Object.keys(fixtures)
          .filter((file) => file !== "prose.ts")
          .toSorted(),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is imported by relative path from inside the package, never by its own name", () => {
    expect(selfImportOffenders(SRC)).toEqual([]);
  });
});
