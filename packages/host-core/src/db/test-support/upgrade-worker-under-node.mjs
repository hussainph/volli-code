// Run the shipped upgrade worker under plain Node's TypeScript loader (VC-1105).
await import("../../secrets/test-support/ts-hooks.mjs");
const { serveDatabaseUpgradeWorker } = await import("../database-upgrade.ts");
serveDatabaseUpgradeWorker();
