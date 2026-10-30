/** A Session's ambient worker budget must never parallelize the shared backend. */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { expect, test } from "vite-plus/test";

test.each([undefined, "1", "8"])(
  "pins backend serialization with ambient workers=%s",
  (workers) => {
    const env = { ...process.env };
    if (workers === undefined) delete env["VITEST_MAX_WORKERS"];
    else env["VITEST_MAX_WORKERS"] = workers;
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import config from './vite.backend.config.ts';
       console.log(JSON.stringify({ test: config.test, workers: process.env.VITEST_MAX_WORKERS }));`,
        // CI and callers can supply a worker flag, but this suite's shared env
        // is a correctness constraint rather than a tunable performance cap.
        "--",
        "--maxWorkers=8",
      ],
      { cwd: fileURLToPath(new URL("..", import.meta.url)), env, encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      test: { maxWorkers: 1, fileParallelism: false },
      workers: "1",
    });
  },
);
