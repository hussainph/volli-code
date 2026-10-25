#!/usr/bin/env node
// The migration dry run (VC-607): rehearses importing a profile into a
// throwaway local Volli Cloud backend, read-only on the profile. Usage and
// safety rules: `src/migration-dry-run/README.md`.
//
//   pnpm -C convex with-backend --deploy -- \
//     pnpm --filter @volli/host-core migration:dry-run --profile <volli.db>
//
// Node strips host-core's types; the resolve hooks let its extensionless
// relative imports find their `.ts` files, as the bundler does.
await import("../src/secrets/test-support/ts-hooks.mjs");
const { main } = await import("../src/migration-dry-run/cli.ts");
process.exitCode = await main(process.argv.slice(2));
