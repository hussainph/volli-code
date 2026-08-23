/**
 * `@volli/shared` must stay loadable by Node's type stripper.
 *
 * This package exports raw `.ts`, and several things import it without a
 * bundler in front: `scripts/generate-theme-css.mjs` and the other design-system
 * checks run under Node's built-in type stripping, which ERASES types and
 * refuses anything that would require EMITTING code.
 *
 * The trap is that such syntax type-checks, tests, lints and bundles perfectly.
 * `pnpm test` stays green; the failure appears only in the CI step that runs a
 * plain Node script, as `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`, in a file that has
 * nothing to do with the change. It reached CI once already (VC-119, via a
 * constructor parameter property on `ObservabilityReducer`), which is why this
 * exists: the point is to fail in the suite a person actually runs, naming the
 * file and the reason.
 *
 * A source scan rather than a spawned Node process on purpose — it names the
 * offending line instead of reporting that an import failed, and it costs no
 * subprocess.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

/** This package's `src`, resolved from this file rather than a working directory. */
const SRC = fileURLToPath(new URL(".", import.meta.url));

/**
 * This file, excluded from its own scan: it necessarily contains the shapes it
 * forbids, in the patterns below and in the prose explaining them.
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
 * The erasable-syntax rules that bite in practice.
 *
 * Not the whole of Node's restriction — `enum` and `namespace` are the other
 * two, and are included because they are cheap to spot and equally fatal.
 * `declare enum` and ambient namespaces are erasable, so both patterns require
 * a body-opening brace and reject a preceding `declare`.
 */
const FORBIDDEN: readonly { name: string; why: string; pattern: RegExp }[] = [
  {
    name: "constructor parameter property",
    why: "stripping it would have to emit `this.x = x`, so Node refuses the file",
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
  const files = sourceFiles(SRC);

  it("finds the sources it is meant to be checking", () => {
    // A guard on the guard: a walk that found nothing would pass every
    // assertion below while proving nothing.
    expect(files.length).toBeGreaterThan(20);
  });

  it.each(FORBIDDEN)("uses no $name ($why)", ({ pattern }) => {
    const offenders = files.filter((path) => pattern.test(readFileSync(path, "utf8")));
    expect(offenders.map((path) => path.slice(SRC.length))).toEqual([]);
  });
});
