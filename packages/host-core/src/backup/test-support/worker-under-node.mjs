// Run the shipped worker protocol under plain Node's TypeScript loader.
await import("../../secrets/test-support/ts-hooks.mjs");
const { serveAutomaticBackupWorker } = await import("../automatic-worker.ts");
serveAutomaticBackupWorker();
