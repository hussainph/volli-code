/**
 * `pnpm -C packages/agent-runtime run bench:runtime:profile`
 *
 * Bundles the runtime-cost fixture, runs it under `node --cpu-prof`, and
 * prints the profile's bottom-up self-sample table. The `.cpuprofile` is left
 * in `.runtime-profile/` for Chrome DevTools' Performance panel.
 *
 * A bundle is needed because Node's type stripping does not resolve the
 * extensionless relative imports this workspace is written with, and because a
 * CPU profile of a vitest worker is mostly vitest.
 *
 * What stays external is a rule rather than a list: exactly the packages
 * `@volli/agent-runtime` itself declares. Those are the ones pnpm's strict
 * layout guarantees resolve from this package's own `node_modules`, so leaving
 * them alone keeps native addons (`sharp`, `node-pty`) and ESM-only providers
 * loading the way they normally do. Everything else — workspace sources and
 * their transitive dependencies, which this package cannot resolve — is
 * compiled in. A hand-written `--external` list is the same rule with a
 * shelf life.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..", "..");
const outputDir = join(packageRoot, ".runtime-profile");
const bundle = join(outputDir, "profile.mjs");

const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const declared = new Set(
  [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ].filter((name) => !name.startsWith("@volli/")),
);

/** The package a bare specifier names: `foo/bar` is `foo`, `@scope/a/b` is `@scope/a`. */
function packageOf(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

const externalizeDeclared = {
  name: "externalize-declared",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^[^.]/ }, (args) =>
      declared.has(packageOf(args.path)) ? { path: args.path, external: true } : null,
    );
  },
};

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });

await build({
  entryPoints: [join(here, "runtime-cost-profile.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  sourcemap: true,
  outfile: bundle,
  plugins: [externalizeDeclared],
  logLevel: "info",
});

const run = (args) =>
  execFileSync(process.execPath, args, {
    cwd: packageRoot,
    stdio: "inherit",
    encoding: "utf8",
  });

run(["--cpu-prof", `--cpu-prof-dir=${outputDir}`, bundle]);

const profiles = readdirSync(outputDir)
  .filter((name) => name.endsWith(".cpuprofile"))
  .map((name) => join(outputDir, name));
if (profiles.length === 0) throw new Error(`No .cpuprofile was written to ${outputDir}`);

run(["--experimental-strip-types", join(here, "runtime-cost-profile-summary.ts"), ...profiles]);
