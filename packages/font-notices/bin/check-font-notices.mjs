#!/usr/bin/env node
/**
 * CLI over `check-dist.mjs` — the release-compliance gate that fails a build
 * whose `dist/` ships font software without the license notice that must
 * accompany it.
 *
 * Usage — app paths resolve against the working directory:
 *
 *   check-font-notices .              # the app in the current directory
 *   check-font-notices apps/docs      # from the repo root
 *
 * Each site's own `build` script runs it with `.` after `astro build`, so the
 * gate travels with the build rather than living only in CI: `pnpm deploy`,
 * which builds before it uploads, runs it too.
 *
 * The argv/exit plumbing lives here and the decisions live in `check-dist.mjs`,
 * so the gate can be tested without spawning a process or trapping an exit.
 */
import { checkApps } from "../check-dist.mjs";

const appPaths = process.argv.slice(2);

if (appPaths.length === 0) {
  console.error("check-font-notices: name at least one app directory to check, e.g. `.`");
  process.exit(2);
}

console.log("Checking font license notices in built output:");

const { failures, notes } = await checkApps(appPaths);
for (const note of notes) console.log(`  ${note}`);

if (failures.length > 0) {
  console.error("\nFont notice check failed:");
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error("");
  process.exit(1);
}
