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
        `import { createVitest } from 'vite-plus/test/node';
         const ctx = await createVitest('test', {
           config: './vite.backend.config.ts', watch: false, maxWorkers: 8,
         });
         try {
           console.log(JSON.stringify({
             test: { maxWorkers: ctx.config.maxWorkers, fileParallelism: ctx.config.fileParallelism },
             workers: process.env.VITEST_MAX_WORKERS,
           }));
         } finally { await ctx.close(); }`,
        // Resolve real Vitest options, including the CLI-equivalent override,
        // without starting tests or the backend's global setup.
      ],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env,
        encoding: "utf8",
        timeout: 15_000,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const resolved = JSON.parse(result.stdout);
    expect(resolved.test).toMatchObject({ maxWorkers: 1, fileParallelism: false });
    expect(resolved.workers).toBe(workers === undefined ? undefined : "1");
  },
);
