/**
 * The hook entrypoint, exercised as a real process against a real pipe.
 *
 * Everything else in the CLI is a pure function behind an injected seam and is
 * tested as one. Stdin is not: the property that matters is that the PROCESS
 * goes away when its read budget expires, and a process that is still alive
 * because a libuv handle is still referenced looks, from inside itself,
 * exactly like one that is about to exit. Only a child that has actually been
 * reaped proves it.
 */
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vite-plus/test";

const bundlePath = fileURLToPath(new URL("../dist/volli.cjs", import.meta.url));

/** A payload budget's worth of slack — generous, so a slow machine cannot fail this. */
const EXIT_DEADLINE_MS = 5_000;

/** How long the writer keeps the pipe open: far longer than any budget under test. */
const WRITER_LIFETIME_MS = 30_000;

interface HookRun {
  /** Milliseconds from spawn to exit. */
  elapsedMs: number;
  /** Bytes the pipe actually accepted before the child went away. */
  flushedBytes: number;
  exitCode: number | null;
}

/**
 * Runs `volli hook` with this process as the writer that never closes the pipe
 * — the harness behaviour the read budget exists for. `flood` keeps pushing
 * until the pipe stops accepting, which is what makes the accumulation cap
 * observable: once the child stops reading, nothing more is flushed.
 */
function runHookProcess(mode: "idle" | "flood"): Promise<HookRun> {
  return new Promise<HookRun>((resolve) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [bundlePath, "hook", "claude", "input.needed"], {
      env: {
        ...process.env,
        VOLLI_SESSION: "session-under-test",
        // Nothing listens here, so the socket call fails immediately and the
        // elapsed time is the stdin read and nothing else.
        VOLLI_SOCKET: "/tmp/volli-doctor-no-such.sock",
      },
      stdio: ["pipe", "ignore", "ignore"],
    });
    let flushedBytes = 0;
    let stopped = false;
    // EPIPE is the expected end of every run here: the child exits first.
    child.stdin.on("error", () => {
      stopped = true;
    });
    if (mode === "flood") {
      const block = Buffer.alloc(64 * 1024, 0x78);
      // Bounded so a child that reads everything cannot run the machine out of
      // memory while failing this test — 64 MiB is 256× the cap under test.
      const ceiling = 64 * 1024 * 1024;
      const pump = (): void => {
        if (stopped || flushedBytes >= ceiling) return;
        const flushable = child.stdin.write(block, () => {
          flushedBytes += block.length;
        });
        if (flushable) setImmediate(pump);
        else child.stdin.once("drain", pump);
      };
      pump();
    }
    // The writer outlives any budget: the child must leave on its own.
    const holdOpen = setTimeout(() => {
      stopped = true;
      child.stdin.destroy();
    }, WRITER_LIFETIME_MS);
    child.on("exit", (exitCode) => {
      stopped = true;
      clearTimeout(holdOpen);
      child.stdin.destroy();
      resolve({ elapsedMs: Date.now() - startedAt, flushedBytes, exitCode });
    });
  });
}

describe("volli hook — stdin", () => {
  beforeAll(() => {
    const built = spawnSync(fileURLToPath(new URL("../node_modules/.bin/vp", import.meta.url)), [
      "pack",
    ]);
    expect(built.status, `vp pack failed: ${built.stderr?.toString() ?? ""}`).toBe(0);
  });

  // The read budget used to bound the promise and not the process: the `data`
  // listener left stdin flowing, a flowing pipe holds a referenced handle, and
  // the hook lived exactly as long as whoever held the write end — measured at
  // the writer's full lifetime against a nominal one-second budget.
  it(
    "exits on its own budget when the writer never closes the pipe",
    { timeout: WRITER_LIFETIME_MS + EXIT_DEADLINE_MS },
    async () => {
      const run = await runHookProcess("idle");
      expect(run.exitCode).toBe(0);
      expect(run.elapsedMs).toBeLessThan(EXIT_DEADLINE_MS);
    },
  );

  // A streaming writer used to make the hook allocate without limit. The cap
  // stops the read, so the pipe stops draining, so the writer stops being able
  // to flush — one cap's worth plus whatever the kernel buffer already held.
  it(
    "stops accumulating a payload that never ends",
    { timeout: WRITER_LIFETIME_MS + EXIT_DEADLINE_MS },
    async () => {
      const run = await runHookProcess("flood");
      expect(run.exitCode).toBe(0);
      expect(run.elapsedMs).toBeLessThan(EXIT_DEADLINE_MS);
      expect(run.flushedBytes).toBeLessThan(4 * 1024 * 1024);
    },
  );
});
