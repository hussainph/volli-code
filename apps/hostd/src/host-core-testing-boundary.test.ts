/**
 * hostd never builds what only tests may build (VC-632).
 *
 * `@volli/host-core/testing` serves fixtures and the Session writer's
 * standalone constructors (`createSqliteSessionLedger`, a test engine). A
 * second writer built by hand never wakes the host's watches, so in
 * production the one writer comes from `createHostCore`. This scan names any
 * non-test source under `src/` that imports `./testing` (or host-core's
 * `src/testing` by path), or that builds an engine itself with
 * `@volli/session-engine`'s `createSessionEngine`. The repository's
 * module-edge scanner (`scripts/module-edges.mjs`) finds the imports, in `'`,
 * `"` and backtick quoting; desktop holds the same guard over its own sources.
 */
import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

import { moduleEdges, namesPackage } from "../../../scripts/module-edges.mjs";

const HOSTD_SRC = fileURLToPath(new URL(".", import.meta.url));
const TESTING = ["@volli", "host-core", "testing"].join("/");
const TESTING_BY_PATH = /(?:^|\/)host-core\/src\/testing(?:\/|$)/;
const ENGINE_FACTORY = ["create", "SessionEngine"].join("");

const isTest = (file: string) => /\.test\.tsx?$/.test(file);

/** `file: what` for every production source under `src` that reaches test-only construction. */
function testingOffenders(src: string): string[] {
  return globSync("**/*.{ts,tsx,mts}", { cwd: src })
    .filter((file) => !isTest(file))
    .flatMap((file) => {
      const source = readFileSync(join(src, file), "utf8");
      const found = moduleEdges(source)
        .filter((edge) => namesPackage(edge, TESTING) || TESTING_BY_PATH.test(edge.specifier))
        .map((edge) => `${file}: imports ${edge.specifier}`);
      if (new RegExp(`\\b${ENGINE_FACTORY}\\b`).test(source))
        found.push(`${file}: names ${ENGINE_FACTORY}`);
      return found;
    });
}

describe("host-core's testing entry", () => {
  it("flags a production import of ./testing in every quoting form, in a scanned source file", () => {
    // A src-shaped fixture tree, scanned by the guard itself: one production
    // file per edge shape and delimiter, so a scanner that drops any fails.
    const fixtures: Record<string, string> = {
      "main/static-double.ts": `import { openTestDb } from "${TESTING}";`,
      "main/static-single.ts": `import { openTestDb } from '${TESTING}';`,
      "main/reexport.ts": `export { openTestDb } from '${TESTING}';`,
      "main/dynamic-template.ts": `export const m = import(\`${TESTING}\`);`,
      "main/dynamic-single.ts": `export const m = import('${TESTING}');`,
      "main/require-template.ts": `export const m = require(\`${TESTING}\`);`,
      "main/by-path.ts": `import { openTestDb } from '../../../packages/host-core/src/testing';`,
      "main/engine.ts": `import { ${ENGINE_FACTORY} } from "@volli/session-engine";`,
      "main/allowed.test.ts": `import { openTestDb } from '${TESTING}';`,
      "main/prose.ts": `// prose about \`${TESTING}\` is not an import\nexport const s = "${TESTING}";`,
    };
    const src = mkdtempSync(join(tmpdir(), "hostd-testing-boundary-"));
    try {
      for (const [file, source] of Object.entries(fixtures)) {
        mkdirSync(dirname(join(src, file)), { recursive: true });
        writeFileSync(join(src, file), `${source}\n`);
      }
      const flagged = new Set(testingOffenders(src).map((line) => line.split(":")[0]));
      expect([...flagged].toSorted()).toEqual(
        Object.keys(fixtures)
          .filter((file) => file !== "main/allowed.test.ts" && file !== "main/prose.ts")
          .toSorted(),
      );
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  it("is imported by tests only, and production builds no Session engine of its own", () => {
    expect(testingOffenders(HOSTD_SRC)).toEqual([]);
  });
});
