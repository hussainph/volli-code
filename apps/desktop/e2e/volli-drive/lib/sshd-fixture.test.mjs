import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { scratchSshEnv, startSshdFixture } from "./sshd-fixture.mjs";

const exec = promisify(execFile);

test(
  "unprivileged loopback sshd accepts only scratch client credentials",
  {
    skip: process.platform !== "darwin",
    timeout: 80_000,
  },
  async (t) => {
    // Inside the execution workspace, not /tmp or the person's home SSH files.
    const dir = await mkdtemp(join(dirname(fileURLToPath(import.meta.url)), ".sshd-fixture-"));
    let fixture;
    t.after(async () => {
      try {
        await fixture?.stop();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
    fixture = await startSshdFixture({ dir });
    assert.equal(fixture.host, "127.0.0.1");
    assert.ok(fixture.port > 1024);
    const { stdout } = await exec("/usr/bin/ssh", [...fixture.sshArgs, "echo ok; uname -s"], {
      env: scratchSshEnv(),
      timeout: 10_000,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024,
    });
    console.log(`scratch-only ssh output: ${JSON.stringify(stdout)}`);
    assert.equal(stdout, "ok\nDarwin\n");
    await fixture.stop();
    await fixture.stop();
  },
);
