await import("../../secrets/test-support/ts-hooks.mjs");
const { serveRestoreWorker } = await import("../restore-worker.ts");
serveRestoreWorker();
