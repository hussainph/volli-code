/**
 * The fence stays inside the database-file module (VC-628): no production
 * source outside `database-file.ts` imports the open lock or the intent
 * marker. Another module that took either one would be a second place that
 * sequences a swap, which is the shape this module exists to remove.
 * Tests reach the marker through `@volli/host-core/testing`, which production
 * code never imports (`package-interface.test.ts`).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const ROOTS = ["packages", "apps"];
const FENCE_INTERNALS = /from\s+["'][^"']*\/(?:open-lock|recovery-pending)(?:\.ts)?["']/;
const OWNER = "packages/host-core/src/db/database-file.ts";
const TESTING_ENTRY = join("packages", "host-core", "src", "testing");

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name.startsWith(".") || entry.name === "dist")
      return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return path.endsWith(TESTING_ENTRY) ? [] : sources(path);
    if (!/\.(?:ts|tsx|mts|cts|mjs|js)$/.test(entry.name)) return [];
    if (/\.test\.|test-helpers|test-fixture/.test(entry.name)) return [];
    return [path];
  });
}

describe("the database-file fence", () => {
  it("is imported by no production source but its own module", () => {
    const importers = ROOTS.flatMap((root) =>
      ["src", "scripts"].flatMap((tree) =>
        readdirSync(join(REPO, root), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .flatMap((entry) => {
            try {
              return sources(join(REPO, root, entry.name, tree));
            } catch {
              return [];
            }
          }),
      ),
    )
      .filter((path) => FENCE_INTERNALS.test(readFileSync(path, "utf8")))
      .map((path) => relative(REPO, path));
    expect(importers).toEqual([OWNER]);
  });
});
