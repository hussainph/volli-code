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
 * A source scan, like `shared-strippable.test.ts`: it names the file. Prose
 * that mentions host-core is not an import and is ignored.
 */
import { globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

/** `apps/desktop/src`, resolved from this file rather than a working directory. */
const DESKTOP_SRC = fileURLToPath(new URL("..", import.meta.url));
const HOST_CORE = ["@volli", "host-core"].join("/");
const CLIENT_ROOTS = ["ipc", "renderer", "preload"];

const IMPORT_CONTEXTS = [
  String.raw`\bfrom\s*`,
  String.raw`\bimport\s+`,
  String.raw`\bimport\s*\(\s*`,
  String.raw`\brequire\s*\(\s*`,
  String.raw`\bvi\.(?:mock|doMock|importActual)\s*(?:<[^>]*>)?\s*\(\s*`,
];

function hostCoreImports(source: string): string[] {
  return IMPORT_CONTEXTS.flatMap((context) => {
    const pattern = new RegExp(`${context}(["'])(${HOST_CORE}(?:/[^"']*)?)\\1`, "g");
    return [...source.matchAll(pattern)].map((match) => match[2]!);
  });
}

describe("the client wire boundary", () => {
  it("recognises the import shapes it guards", () => {
    expect(
      hostCoreImports(
        [
          `import type { A } from "${HOST_CORE}/files";`,
          `export type { B } from '${HOST_CORE}';`,
          `type C = typeof import("${HOST_CORE}/secrets");`,
          `// prose about ${HOST_CORE}/files is not an import`,
        ].join("\n"),
      ).toSorted(),
    ).toEqual([HOST_CORE, `${HOST_CORE}/files`, `${HOST_CORE}/secrets`]);
  });

  it("keeps the IPC contract, preload and renderer free of host-core", () => {
    const offenders = CLIENT_ROOTS.flatMap((root) =>
      globSync(`${root}/**/*.{ts,tsx,mts}`, { cwd: DESKTOP_SRC }).flatMap((file) =>
        hostCoreImports(readFileSync(`${DESKTOP_SRC}${file}`, "utf8")).map(
          (specifier) => `${file}: ${specifier}`,
        ),
      ),
    );
    expect(offenders).toEqual([]);
  });
});
