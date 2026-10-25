/**
 * `@volli/shared/cloud` is what every backend module bundles, so it stays
 * light: its import graph reaches only the board vocabulary and small pure
 * helpers, never the local app's heavier models (the Automation model, the
 * project record, the agent runtime, and with them the JSON-schema validator).
 * A source walk rather than a bundle, so a failure names the import.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vite-plus/test";

const ENTRY = fileURLToPath(new URL("../../packages/shared/src/cloud/index.ts", import.meta.url));
const IMPORT = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?[^;]*?\sfrom\s+"([^"]+)"/g;

function graph(entry: string) {
  const files = new Set<string>();
  const packages = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const [, typeOnly, specifier] of readFileSync(file, "utf8").matchAll(IMPORT)) {
      // A type-only import is erased: it reaches no runtime module.
      if (typeOnly !== undefined) continue;
      if (specifier!.startsWith(".")) pending.push(resolve(dirname(file), `${specifier}.ts`));
      else packages.add(specifier!);
    }
  }
  return { files, packages };
}

test("the cloud entry point's runtime imports stay small and pure", () => {
  const { files, packages } = graph(ENTRY);
  const names = [...files].map((file) => file.slice(file.indexOf("/shared/src/") + 12));
  // The walk reached the rules and what they import.
  expect(names).toEqual(
    expect.arrayContaining(["cloud/board-rules.ts", "agent-surface.ts", "label.ts"]),
  );
  for (const heavy of ["automation.ts", "project-identity.ts", "agent-runtime.ts", "mcp.ts"]) {
    expect(names).not.toContain(heavy);
  }
  expect([...packages].toSorted()).toEqual([
    "@noble/hashes/sha2.js",
    "@noble/hashes/utils.js",
    "fractional-indexing",
  ]);
});
