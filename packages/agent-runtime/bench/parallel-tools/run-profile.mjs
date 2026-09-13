/**
 * `pnpm -C packages/agent-runtime run bench:runtime:profile`
 *
 * Bundles the runtime-cost fixture, runs it under `node --cpu-prof`, and
 * prints the profile's bottom-up self-sample table. The `.cpuprofile` is left
 * in `.runtime-profile/` for Chrome DevTools' Performance panel.
 *
 * A bundle is needed because Node's type stripping does not resolve
 * extensionless relative imports, and a CPU profile of a vitest worker is
 * mostly vitest. Only this package's own `src/` is bundled: `--packages=external`
 * leaves every bare import alone, so there is no hand-maintained list of native
 * or ESM-only dependencies to fall out of date.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..", "..");
const outputDir = join(packageRoot, ".runtime-profile");
const bundle = join(outputDir, "profile.mjs");

const run = (command, args) =>
  execFileSync(command, args, { cwd: packageRoot, stdio: "inherit", encoding: "utf8" });

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });

run("esbuild", [
  join(here, "runtime-cost-profile.ts"),
  "--bundle",
  "--platform=node",
  "--format=esm",
  "--packages=external",
  "--sourcemap",
  `--outfile=${bundle}`,
]);

run(process.execPath, ["--cpu-prof", `--cpu-prof-dir=${outputDir}`, bundle]);

const profiles = readdirSync(outputDir)
  .filter((name) => name.endsWith(".cpuprofile"))
  .map((name) => join(outputDir, name));
if (profiles.length === 0) throw new Error(`No .cpuprofile was written to ${outputDir}`);

run(process.execPath, [
  "--experimental-strip-types",
  join(here, "runtime-cost-profile-summary.ts"),
  ...profiles,
]);
