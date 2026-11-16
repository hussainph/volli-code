// Child process for live-snapshot.test.ts: copies a live database with
// copyLiveDatabase and SIGKILLs itself at one step, as a quit ends the app
// (worker included) at any moment (VC-1208, VC-1201).
// argv: <dbPath> <snapshotPath> <step>
//   hold        main has been asked to hold; no read transaction yet
//   wal-copied  read transaction open, WAL bytes copied, file not yet cloned
//   cloned      read transaction open, file cloned
//   claimed     read transaction closed, clone written, hold not yet released
//   done        the copy is finished
await import("../secrets/test-support/ts-hooks.mjs");
const { default: Database } = await import("better-sqlite3");
const { copyFileOutOfProcess, copyLiveDatabase } = await import("./live-snapshot.ts");

const [dbPath, snapshotPath, step] = process.argv.slice(2);
const kill = (at) => {
  if (at !== step) return;
  process.stdout.write(`SIGKILL at ${at}\n`);
  process.kill(process.pid, "SIGKILL");
};
const source = new Database(dbPath, { readonly: true, fileMustExist: true });
await copyLiveDatabase(source, dbPath, snapshotPath, {
  clone: async (from, to) => {
    kill("wal-copied");
    const method = await copyFileOutOfProcess(from, to, { clone: process.platform === "darwin" });
    kill("cloned");
    return method;
  },
  holdCheckpoints: async () => {
    kill("hold");
    return () => kill("claimed");
  },
});
kill("done");
process.stdout.write("finished\n");
