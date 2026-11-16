import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts/ci-runner-health.sh");

test(
  "samples the runner's CPU split, steal and pressure until it is killed",
  { skip: process.platform !== "linux" && "reads /proc; the CI shards are Linux" },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "runner-health-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const child = spawn("bash", [script, dir], {
      env: { ...process.env, VOLLI_RUNNER_HEALTH_INTERVAL: "0.2" },
      stdio: "ignore",
    });
    await delay(1_200);
    child.kill("SIGTERM");
    await new Promise((done) => child.once("exit", done));
    const lines = readFileSync(join(dir, "runner-health.log"), "utf8").trim().split("\n");
    assert.match(lines[0], /^# start=\S+ nproc=\d+ /u);
    const samples = lines.filter((line) => !line.startsWith("#"));
    assert.ok(samples.length >= 2, lines.join("\n"));
    for (const sample of samples) {
      assert.match(sample, /^\d\d:\d\d:\d\d user=\d+% sys=\d+% idle=\d+% iowait=\d+% steal=\d+%/u);
      assert.match(sample, / running=\d+ blocked=\d+ load1=\S+ mem_available_mb=\d+/u);
      if (existsSync("/proc/pressure/io")) assert.match(sample, / io_some=\S+ io_full=\S+/u);
    }
  },
);
