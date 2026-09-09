/**
 * Every native alert goes through the one delivery path (VC-295 rule 2).
 *
 * The ticket's guarantee is that a NEW preference-controlled call site cannot
 * skip `notificationAllowed`. Inside the delivery path that is true by type:
 * `deliver` takes a producer, and the producer's policy is looked up in a total
 * table. But a type cannot stop somebody writing `new Notification(...)` again
 * in `index.ts` — which is exactly the shape every one of the six pre-VC-295
 * call sites had, and what a reviewer would have to catch by eye.
 *
 * So the rule is enforced the way `shared-strippable.test.ts` enforces its own:
 * a source scan that names the offending file. Electron's `Notification` may
 * be imported and constructed in `notifications/runtime.ts` and nowhere else
 * under `src/main` or `src/preload`; and the renderer, which has the Web
 * `Notification` API within reach, constructs none either — a browser alert
 * would be a second door around the same preferences. Anything that wants to
 * post an alert reaches `NotificationRuntime.deliver` (or `deliverNotification`
 * for the singletons), names a producer, and gets the preference check for
 * free.
 *
 * A scan rather than a lint rule because the toolchain's lint config has no
 * per-path override today, and a rule that had to be switched off for the one
 * file that legitimately needs it would be a rule with a hole the same size as
 * the thing it guards.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { describe, expect, it } from "vite-plus/test";

/** `apps/desktop/src`, resolved from this file rather than a working directory. */
const DESKTOP_SRC = fileURLToPath(new URL("../..", import.meta.url));

/** The one module allowed to touch Electron's `Notification`. */
const THE_DOOR = "main/notifications/runtime.ts";

/** This file: it necessarily spells the shapes it forbids. */
const SELF = fileURLToPath(import.meta.url);

function sourceFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (path === SELF) continue;
      if (entry.endsWith(".test.ts") || entry.endsWith(".test.tsx")) continue;
      if (entry.endsWith(".ts") || entry.endsWith(".tsx")) found.push(path);
    }
  };
  walk(root);
  return found;
}

/**
 * Comments stripped before matching: the modules around the door explain the
 * rule in prose that names the forbidden shape, and prose is not a call site.
 */
function code(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/^\s*\/\/.*$/gm, "");
}

const FORBIDDEN = [
  {
    name: "a `new Notification(` construction",
    pattern: /\bnew\s+Notification\s*\(/,
  },
  {
    name: "an Electron `Notification` import",
    // `import { ..., Notification, ... } from "electron"` in any spacing, and
    // the `electron.Notification` spelling a default import would allow.
    pattern:
      /import\s*\{[^}]*\bNotification\b[^}]*\}\s*from\s*["']electron["']|\belectron\.Notification\b/,
  },
];

describe("the one notification door", () => {
  const files = [
    join(DESKTOP_SRC, "main"),
    join(DESKTOP_SRC, "preload"),
    join(DESKTOP_SRC, "renderer", "src"),
  ].flatMap(sourceFiles);

  it("scans the process code, not an empty directory", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.map((path) => relative(DESKTOP_SRC, path))).toContain(THE_DOOR);
  });

  it.each(FORBIDDEN)("finds $name only in the runtime", ({ pattern }) => {
    const offenders = files
      .filter((path) => pattern.test(code(readFileSync(path, "utf8"))))
      .map((path) => relative(DESKTOP_SRC, path));
    expect(offenders).toEqual([THE_DOOR]);
  });
});
