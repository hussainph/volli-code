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
            await Promise.all(
              processes.map(async ({ pid }) => {
                try {
                  await execFileAsync(
                    "/usr/bin/sample",
                    [String(pid), "2", "-file", `${path}.${pid}.sample.txt`],
                    { timeout: 7000 },
                  );
                } catch (error) {
                  traceClose(path, "sample-failed", { sampledPid: pid, error: error.message });
                }
              }),
            );
          })().catch((error) => traceClose(path, "sampling-failed", { error: error.message }));
        }, 10000)
      : undefined;
  return async () => {
    clearTimeout(timer);
    await sampling;
  };
}
