/**
 * The client side of the app never depends on host-core (VC-632).
 *
 * `src/ipc/` is the renderer-facing contract, and `src/renderer/` and
 * `src/preload/` are the client. In M2 a remote client speaks to a host it
 * does not run, so everything it names crosses the wire as `@volli/shared`
 * vocabulary (file results, the background-shell snapshot, credential
 * status), never as a type reached through `@volli/host-core`. A type-only
 * import would still pull host-core's implementation graph into the
 * renderer's type program, which is how this started.
 *
 * A source scan, like `shared-strippable.test.ts`: it names the file. The
 * repository's module-edge scanner (`scripts/module-edges.mjs`) finds every
 * import shape in `'`, `"` and backtick quoting; prose that mentions host-core
 * is not an import and is ignored.
 */
import { globSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

import { importsOfPackage } from "../../../../scripts/module-edges.mjs";

/** `apps/desktop/src`, resolved from this file rather than a working directory. */
const DESKTOP_SRC = fileURLToPath(new URL("..", import.meta.url));
const HOST_CORE = ["@volli", "host-core"].join("/");
const CLIENT_ROOTS = ["ipc", "renderer", "preload"];

/** `file: specifier` for every client source under `src` that imports host-core. */
function clientHostCoreImports(src: string): string[] {
  return CLIENT_ROOTS.flatMap((root) =>
    globSync(`${root}/**/*.{ts,tsx,mts}`, { cwd: src }).flatMap((file) =>
      importsOfPackage(readFileSync(join(src, file), "utf8"), HOST_CORE).map(
        (specifier) => `${file}: ${specifier}`,
      ),
    ),
  );
}

describe("the client wire boundary", () => {
  it("flags a host-core import in every client root and quoting form", () => {
    // A client-shaped fixture tree, scanned by the guard itself: one file per
    // edge shape and delimiter, so a scanner that drops any of them fails.
    const fixtures: Record<string, string> = {
      "ipc/static-double.ts": `import type { A } from "${HOST_CORE}/files";`,
      "ipc/static-single.ts": `import type { A } from '${HOST_CORE}/files';`,
      "ipc/reexport.ts": `export type { B } from '${HOST_CORE}';`,
      "ipc/type-import-template.ts": `export type C = typeof import(\`${HOST_CORE}/secrets\`);`,
      "renderer/src/dynamic-template.tsx": `export const m = import(\`${HOST_CORE}/files\`);`,
      "renderer/src/dynamic-single.ts": `export const m = import('${HOST_CORE}/files');`,
      "renderer/src/side-effect.ts": `import "${HOST_CORE}/files";`,
      "preload/require-template.ts": `export const m = require(\`${HOST_CORE}\`);`,
      "preload/mock-template.test.ts": `vi.mock(\`${HOST_CORE}/files\`);`,
      "ipc/prose.ts": `// prose about \`${HOST_CORE}/files\` is not an import\nexport const s = "${HOST_CORE}";`,
      "main/outside-client.ts": `import { x } from "${HOST_CORE}/files";`,
    };
    const src = mkdtempSync(join(tmpdir(), "client-wire-boundary-"));
    try {
      for (const [file, source] of Object.entries(fixtures)) {
        mkdirSync(dirname(join(src, file)), { recursive: true });
        writeFileSync(join(src, file), `${source}\n`);
      }
      const flagged = new Set(clientHostCoreImports(src).map((line) => line.split(":")[0]));
      expect([...flagged].toSorted()).toEqual(
        Object.keys(fixtures)
          .filter((file) => file !== "ipc/prose.ts" && !file.startsWith("main/"))
          .toSorted(),
      );
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  it("keeps the IPC contract, preload and renderer free of host-core", () => {
    expect(clientHostCoreImports(DESKTOP_SRC)).toEqual([]);
  });
});
