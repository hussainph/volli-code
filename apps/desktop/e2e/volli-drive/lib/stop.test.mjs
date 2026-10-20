/**
 * `volli-drive stop` against real (harmless) processes, no Electron: it stops
 * exactly what the registry PROVES we started — the recorded supervisor, by
 * pid AND start time, its process group and descendants — and leaves alone a
 * decoy whose command line names the same scratch and evidence paths, and a
 * process that now holds a recorded pid under a different start time.
 *
 * Every process here is spawned by this test and killed by it in `after`.
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createRegistry, pidAlive, processIdentity } from "./core.mjs";

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL("../cli.mjs", import.meta.url));
const SLEEP = "setInterval(() => {}, 1000)";

let root;
const spawned = [];
const track = (child) => (spawned.push(child.pid), child);

async function waitFor(predicate, what, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

before(() => {
  root = realpathSync(mkdtempSync(join(os.tmpdir(), "volli-drive-stop-")));
});
after(() => {
  for (const pid of spawned) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  rmSync(root, { recursive: true, force: true });
});

describe("stop with an unreachable supervisor", () => {
  it("reaps the recorded supervisor and its tree, and nothing else", async () => {
    const home = join(root, "drive-home");
    const evidenceRoot = join(root, "evidence");
    const id = "vd-5709ab";
    const scratch = join(root, `${id}-scratch`);
    const evidence = join(evidenceRoot, id);
    mkdirSync(join(scratch, "ud"), { recursive: true });
    mkdirSync(join(evidence, "logs"), { recursive: true });
    const specPath = join(evidence, "spec.json");

    // The "supervisor": detached (its own process group, like launch makes
    // it), with a child of its own standing in for Electron. No drive.sock,
    // so `stop` takes the unreachable path.
    const supervisor = track(
      spawn(
        process.execPath,
        [
          "-e",
          `require("child_process").spawn(process.execPath, ["-e", ${JSON.stringify(SLEEP)}, ${JSON.stringify(join(scratch, "ud"))}], { stdio: "ignore" }); ${SLEEP}`,
          specPath,
        ],
        { detached: true, stdio: "ignore" },
      ),
    );
    supervisor.unref();
    // Decoys: one names the scratch AND evidence paths (the old path-match
    // fallback killed this); one stands at a pid recorded under another
    // start time (a reused pid).
    const decoy = track(
      spawn(process.execPath, ["-e", SLEEP, join(scratch, "ud", "main.log"), specPath], {
        stdio: "ignore",
      }),
    );
    const reused = track(spawn(process.execPath, ["-e", SLEEP], { stdio: "ignore" }));

    const supervisorIdentity = await processIdentity(supervisor.pid);
    assert.equal(supervisorIdentity.pgid, supervisor.pid, "detached supervisor leads its group");
    let grandchild;
    await waitFor(async () => {
      const { stdout } = await execFileAsync("/bin/ps", ["-Ao", "pid=,ppid="]);
      grandchild = stdout
        .split("\n")
        .map((l) => l.trim().split(/\s+/).map(Number))
        .find(([, ppid]) => ppid === supervisor.pid)?.[0];
      return grandchild !== undefined;
    }, "the supervisor's child");
    spawned.push(grandchild);

    const registry = createRegistry(home);
    await registry.reserve({
      id,
      scratch,
      evidence,
      reservedAt: Date.now(),
      supervisorPid: supervisor.pid,
      supervisor: supervisorIdentity,
      // Recorded under a start time that is not the live process's: a pid
      // that has since been reused by someone else.
      electronPid: reused.pid,
      electron: { pid: reused.pid, pgid: reused.pid, started: "Thu Jan 1 00:00:00 2015" },
    });

    const { stdout } = await execFileAsync(process.execPath, [CLI, "stop", id], {
      env: { ...process.env, VOLLI_DRIVE_HOME: home, VOLLI_DRIVE_EVIDENCE: evidenceRoot },
    });
    assert.match(stdout, /stopped vd-5709ab/);
    assert.match(stdout, /reused by another process/);

    await waitFor(() => !pidAlive(supervisor.pid), "the supervisor to exit");
    await waitFor(() => !pidAlive(grandchild), "the supervisor's child to exit");
    assert.equal(pidAlive(decoy.pid), true, "a decoy naming our paths survives");
    assert.equal(pidAlive(reused.pid), true, "a reused recorded pid survives");
    assert.equal(await registry.get(id), null, "the registry entry is gone");
    assert.equal(existsSync(scratch), false, "scratch is removed");
    assert.equal(existsSync(evidence), true, "evidence survives");
  });
});
