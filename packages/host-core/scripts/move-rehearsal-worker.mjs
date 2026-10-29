await import("../src/secrets/test-support/ts-hooks.mjs");
const { runMoveJob } = await import("../src/migration-dry-run/move-worker.ts");
try {
  await runMoveJob(process.argv[2]);
} catch {
  // Backend errors can contain row content. The parent reports only a code.
  process.send?.({ failed: true });
  process.exitCode = 1;
}
