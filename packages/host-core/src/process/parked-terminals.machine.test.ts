/**
 * The parked-terminal release against the real machine (VC-833): a process
 * group a "previous launch" SIGSTOPped and recorded in a real spawn ledger is
 * found by the real `ps`, re-identified by its start time, and continued.
 *
 * macOS only, like the orphan sweep's machine suite: `ps`'s `lstart` column is
 * the BSD convention the parser was written for.
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { openTestDb, type TestDb } from "../db/test-helpers";
import { resumeParkedTerminals } from "./parked-terminals";
import { SpawnLedger } from "./spawn-ledger";

const run = promisify(execFile);
const onMac = process.platform === "darwin";

const spawnedPids: number[] = [];
const databases: TestDb[] = [];

afterEach(() => {
  for (const pid of spawnedPids.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  while (databases.length > 0) databases.pop()!.cleanup();
});

/** `ps`'s one-letter state: `T` while stopped. */
async function stateOf(pid: number): Promise<string> {
  const { stdout } = await run("ps", ["-o", "stat=", "-p", String(pid)]);
  return stdout.trim();
}

describe.skipIf(!onMac)("resumeParkedTerminals on the real machine (VC-833)", () => {
  it("continues the stopped group a previous launch recorded, and nothing else", async () => {
    const testDb = openTestDb();
    databases.push(testDb);
    const ledger = new SpawnLedger(testDb.db);
    const startedAt = Date.now();
    // Its own session and group, as node-pty gives a terminal's shell.
    const child = spawn("/bin/sleep", ["120"], { detached: true, stdio: "ignore" });
    child.unref();
    const pid = child.pid!;
    spawnedPids.push(pid);
    const rowId = ledger.recordSpawn({
      sessionId: "session-1",
      ticketId: null,
      projectId: null,
      kind: "terminal",
      pid,
      pgid: pid,
      startedAt,
      cwd: "/",
      command: "/bin/sleep",
    })!;
    process.kill(-pid, "SIGSTOP");
    ledger.markParked(rowId, Date.now());
    expect(await stateOf(pid)).toMatch(/^T/);

    const report = await resumeParkedTerminals({ ledger, launchedAt: Date.now() + 1 });

    expect(report).toEqual({ resumed: [rowId], stale: [], refused: [] });
    expect(await stateOf(pid)).not.toMatch(/^T/);
    expect(ledger.listParkedTerminals(Date.now() + 1)).toEqual([]);
  });
});
