// Per-step timings of one schema upgrade (VC-1105, VC-1204): the same
// `openVolliDb` the upgrade worker runs, on a scratch clone, printing the
// `database upgraded` line's `stepsMs`. Run with the pinned Node runtime:
//
// vp env exec --node 24.22.1 -- node packages/host-core/bench/schema-upgrade.mjs \
//   <closed safety copy> <scratch dir> [--older <n>]
//
// The source must be a closed, checkpointed SQLite file (a published
// `volli.db.backup-v<N>`), never a live database. It is cloned (`cp -c`) to
// `<scratch dir>/volli.db`; `--older <n>` also clones it to n older safety copy
// names beside it, so retention has older copies to check. The scratch
// directory is emptied first and must not be the app's data directory.
import { execFileSync } from "node:child_process";
import { closeSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { basename, join, resolve } from "node:path";

await import("../src/secrets/test-support/ts-hooks.mjs");
registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith(".ts")) return nextLoad(url, context);
    return {
      format: "module",
      source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), { mode: "transform" }),
      shortCircuit: true,
    };
  },
});
const { installHostLog } = await import("../src/log/root.ts");
const { openVolliDb } = await import("../src/db/database-file.ts");

const [sourceArg, scratchArg] = process.argv.slice(2);
if (!sourceArg || !scratchArg)
  throw new Error("Usage: schema-upgrade.mjs <closed safety copy> <scratch dir> [--older <n>]");
const olderAt = process.argv.indexOf("--older");
const older = olderAt === -1 ? 0 : Number(process.argv[olderAt + 1]);
const source = resolve(sourceArg);
const scratch = resolve(scratchArg);
if (scratch.includes("Application Support")) throw new Error("Refusing the app data directory.");
const wal = lstatSync(`${source}-wal`, { throwIfNoEntry: false });
if (wal !== undefined && wal.size > 0) throw new Error("Source has WAL frames: not a closed copy.");

// `user_version`: a big-endian u32 at offset 60 of the header.
const header = Buffer.alloc(64);
const fd = openSync(source, "r");
try {
  readSync(fd, header, 0, 64, 0);
} finally {
  closeSync(fd);
}
const fromVersion = header.readUInt32BE(60);

mkdirSync(scratch, { recursive: true });
for (const name of readdirSync(scratch)) rmSync(join(scratch, name), { force: true });
const dbPath = join(scratch, "volli.db");
execFileSync("cp", ["-c", source, dbPath]);
for (let i = 1; i <= older; i += 1)
  execFileSync("cp", ["-c", source, `${dbPath}.backup-v${fromVersion - i}`]);

const records = [];
installHostLog({ level: "info", sink: { write: (record) => records.push(record) } });
const swapBefore = execFileSync("sysctl", ["-n", "vm.swapusage"], { encoding: "utf8" }).trim();
const started = performance.now();
openVolliDb(dbPath).close();
const wallMs = Math.round(performance.now() - started);
const swapAfter = execFileSync("sysctl", ["-n", "vm.swapusage"], { encoding: "utf8" }).trim();

const upgraded = records.find((record) => record.msg === "database upgraded");
const retention = records
  .filter((record) => record.component === "backup-retention")
  .map((record) => `${record.action} ${record.name ?? ""}`.trim());
console.log(
  JSON.stringify({
    source: basename(source),
    older,
    fromVersion,
    wallMs,
    stepsMs: upgraded?.stepsMs,
    retention,
    swapBefore,
    swapAfter,
  }),
);
