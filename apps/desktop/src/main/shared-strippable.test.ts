/**
 * `@volli/shared` must stay loadable by Node's type stripper.
 *
 * That package exports raw `.ts`, and two of this app's build scripts —
 * `scripts/generate-theme-css.mjs` and `scripts/generate-editor-theme-notices.mjs`
 * — import it with no bundler in front, under Node's built-in type stripping.
 * That loader ERASES types and refuses anything it would have to EMIT code for.
 *
 * The trap is that such syntax type-checks, tests, lints and bundles perfectly.
 * `pnpm test` stays green and the failure appears only in the CI step that runs
 * a plain Node script, as `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`, in a file with
 * nothing to do with the change. It happened once (VC-119: a constructor
 * parameter property on `ObservabilityReducer`, made reachable by putting that
 * module on the package barrel), which is why this exists — to fail in the
 * suite a person actually runs, naming the file and the reason.
 *
 * **It lives here, not in `@volli/shared`, because it needs `node:fs` and that
 * package may not import Node APIs** (`AGENTS.md`). That is the right way
 * round anyway: this app owns the scripts that do the stripping, so this app is
 * what breaks, and the test belongs with the consumer rather than the
 * dependency.
 *
 * A source scan rather than a spawned Node process on purpose — it names the
 * offending line instead of reporting that some import failed, and costs no
 * subprocess.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

/** `packages/shared/src`, resolved from this file rather than a working directory. */
const SHARED_SRC = fileURLToPath(new URL("../../../../packages/shared/src", import.meta.url));

/**
 * This file, excluded from the scan it defines: it necessarily contains the
 * shapes it forbids, in the patterns below and in the prose explaining them.
 */
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
      if (path !== SELF && entry.endsWith(".ts")) found.push(path);
    }
  };
  walk(root);
  return found;
}

/**
 * The non-erasable constructs, each of which would make Node refuse the file.
 *
 * `declare enum` and ambient namespaces erase cleanly, so both of those
 * patterns require a body-opening brace and reject a preceding `declare`.
 */
const FORBIDDEN: readonly { name: string; why: string; pattern: RegExp }[] = [
  {
    name: "constructor parameter property",
    why: "stripping it would have to emit `this.x = x`",
    pattern: /constructor\s*\([^)]*\b(?:private|public|protected|readonly)\s+\w/s,
  },
  {
    name: "enum",
    why: "a non-declare enum emits a runtime object",
    pattern: /^\s*(?!.*\bdeclare\b)(?:export\s+)?(?:const\s+)?enum\s+\w+\s*\{/m,
  },
  {
    name: "namespace",
    why: "a non-declare namespace emits a runtime object",
    pattern: /^\s*(?!.*\bdeclare\b)(?:export\s+)?namespace\s+[\w.]+\s*\{/m,
  },
];

describe("@volli/shared stays strippable by Node", () => {
  const files = sourceFiles(SHARED_SRC);

  it("finds the sources it is meant to be checking", () => {
    // A guard on the guard: a walk that found nothing would pass every
    // assertion below while proving nothing at all.
    expect(files.length).toBeGreaterThan(20);
  });

  it.each(FORBIDDEN)("finds no $name in @volli/shared ($why)", ({ pattern }) => {
    const offenders = files.filter((path) => pattern.test(readFileSync(path, "utf8")));
    expect(offenders.map((path) => path.slice(SHARED_SRC.length))).toEqual([]);
  });
});
