#!/usr/bin/env node
// Writes the migration dry run's synthetic profile (a head-schema `volli.db`
// plus attachment bytes, every id a UUID) into an empty directory, and prints
// the database path. Test data for `migration:dry-run`; never a real profile.
//
//   node --experimental-transform-types scripts/migration-dry-run-fixture.mjs <dir>
await import("../src/secrets/test-support/ts-hooks.mjs");
const { writeSyntheticProfile } =
  await import("../src/migration-dry-run/test-support/synthetic-profile.ts");
const dir = process.argv[2];
if (!dir) {
  console.error("usage: migration-dry-run-fixture.mjs <empty dir>");
  process.exit(2);
}
console.log(writeSyntheticProfile(dir).dbPath);
