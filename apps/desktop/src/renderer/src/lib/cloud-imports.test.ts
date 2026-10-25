/**
 * Where the renderer may load Volli Cloud's code from (VC-889).
 *
 * - Only `lib/cloud-runtime.ts` imports Convex's client or the backend's
 *   generated references as values, and only a cloud launch loads it (a
 *   dynamic import in `lib/cloud-client.ts`): a local launch never loads
 *   Convex at all.
 * - From `convex/` the renderer takes the generated references and nothing
 *   else (`@volli/convex/api`, ARCH §2): never a server function's source.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vite-plus/test";

const root = new URL("..", import.meta.url).pathname;

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/u.test(name) && !/\.test(-support)?\.tsx?$|\.test\.tsx?$/u.test(name)
      ? [path]
      : [];
  });
}

/** Every module specifier a file imports as a value (type-only imports erase). */
function valueImports(text: string): string[] {
  const found: string[] = [];
  const pattern = /^\s*(import|export)\s+(?!type\s)([^;]*?)\s+from\s+["']([^"']+)["']/gmu;
  for (const match of text.matchAll(pattern)) found.push(match[3]!);
  // A type position's `typeof import("…")` erases too.
  for (const match of text.matchAll(/(?<!typeof\s)import\(\s*["']([^"']+)["']\s*\)/gu)) {
    found.push(match[1]!);
  }
  return found;
}

describe("the renderer's Volli Cloud imports", () => {
  const files = sources(root).map((path) => ({
    path: relative(root, path),
    text: readFileSync(path, "utf8"),
  }));

  it("loads Convex only from the runtime module a cloud launch imports dynamically", () => {
    const loaders = files
      .filter(({ text }) =>
        valueImports(text).some((specifier) => /^(convex(\/|$)|@volli\/convex)/u.test(specifier)),
      )
      .map(({ path }) => path);
    expect(loaders).toEqual(["lib/cloud-runtime.ts"]);
    const dynamic = files
      .filter(({ text }) => /import\(\s*["']\.\/cloud-runtime["']\s*\)/u.test(text))
      .map(({ path }) => path);
    expect(dynamic).toEqual(["lib/cloud-client.ts"]);
  });

  it("takes nothing from convex/ but its generated references", () => {
    const specifiers = files.flatMap(({ text }) =>
      [...text.matchAll(/["'](@volli\/convex[^"']*)["']/gu)].map((match) => match[1]!),
    );
    expect(new Set(specifiers)).toEqual(new Set(["@volli/convex/api"]));
  });
});
