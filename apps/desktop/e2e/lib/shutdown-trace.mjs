import { execFile } from "node:child_process";
import { appendFileSync, promises as fs } from "node:fs";
import { promisify } from "node:util";
import { descendantProcesses } from "./smoke-kit.mjs";

const execFileAsync = promisify(execFile);

/** Parent breadcrumbs remain available even when main's native thread blocks. */
export function traceClose(path, stage, details = {}) {
  appendFileSync(
    path,
    `${JSON.stringify({ at: Date.now(), pid: process.pid, stage, ...details })}\n`,
  );
}

export function sampleStalledClose(child, path) {
  let sampling = Promise.resolve();
  const timer =
    process.platform === "darwin"
      ? setTimeout(() => {
          if (child.exitCode !== null || child.signalCode !== null) return;
          sampling = (async () => {
            const { stdout } = await execFileAsync("/bin/ps", ["-axo", "pid=,ppid=,comm="], {
              timeout: 2000,
            });
            const processes = [
              { pid: child.pid, command: "tracked Electron main" },
              ...descendantProcesses(stdout, child.pid),
            ];
            await fs.writeFile(`${path}.processes.json`, `${JSON.stringify(processes, null, 2)}\n`);
            await Promise.all([
              execFileAsync("/usr/sbin/lsof", ["-nP", "-p", String(child.pid)], {
                timeout: 5000,
                maxBuffer: 2 * 1024 * 1024,
              }).then(
                ({ stdout: openFiles }) => fs.writeFile(`${path}.open-files.txt`, openFiles),
                (error) => traceClose(path, "open-files-failed", { error: error.message }),
              ),
              ...processes.map(async ({ pid }) => {
                try {
                  await execFileAsync(
                    "/usr/bin/sample",
                    [String(pid), "2", "-file", `${path}.${pid}.sample.txt`],
                    // Symbolication can outlive the sampled process on a loaded runner.
                    // This diagnostic budget does not delay closeAppBounded's signals.
                    { timeout: 60000 },
                  );
                } catch (error) {
                  traceClose(path, "sample-failed", { sampledPid: pid, error: error.message });
                }
              }),
            ]);
          })().catch((error) => traceClose(path, "sampling-failed", { error: error.message }));
        }, 10000)
      : undefined;
  return async () => {
    clearTimeout(timer);
    await sampling;
  };
}
