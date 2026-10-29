await import("../src/secrets/test-support/ts-hooks.mjs");
const { serveAutomaticBackupWorker } = await import("../src/backup/automatic-worker.ts");
serveAutomaticBackupWorker();
