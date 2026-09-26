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
import type { ChildProcess } from "node:child_process";
import { closeSync, constants, openSync, readFileSync } from "node:fs";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vite-plus/test";

const bundlePath = fileURLToPath(new URL("../dist/volli.cjs", import.meta.url));

/**
 * The promotion marker is the REPOSITORY root version, which vite.config.ts
 * bakes in as `__VOLLI_RELEASE_VERSION__` — deliberately not this package's own
 * 0.0.1. It is read here rather than written as a literal because it moves on
 * every release: a hardcoded copy makes a green suite depend on someone
 * remembering to edit this line, and it went stale exactly that way once, at
 * 0.1.0, while the app shipped 0.1.1 and 0.1.2.
 */
const releaseVersion = (
  JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

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

interface BrokenOutputRun {
  exitCode: number | null;
  /** Everything the CLI managed to say on the stream that still worked. */
  intactOutput: string;
}

function cliEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env["VOLLI_SOCKET"];
  delete env["VOLLI_SESSION"];
  delete env["VOLLI_TICKET"];
  return env;
}

/** The status the process ended on, and what it said on the stream that worked. */
function collectOutcome(child: ChildProcess, intact: Readable): Promise<BrokenOutputRun> {
  return new Promise<BrokenOutputRun>((resolve, reject) => {
    const chunks: Buffer[] = [];
    intact.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolve({ exitCode, intactOutput: Buffer.concat(chunks).toString("utf8") });
    });
  });
}

/**
 * Runs the built CLI with one of its output streams already unreadable: the
 * reader closed its end before the CLI wrote a byte, which is the state
 * `head -12` leaves behind the moment it has taken its twelve lines.
 *
 * These help/usage commands emit a small response in one write. Closing after
 * the first chunk is not a reliable regression: the pipe buffer may already
 * hold the whole response, so the test can pass without any EPIPE handler.
 * A larger response could force backpressure, but this fixture avoids both
 * payload-size assumptions and reader scheduling.
 *
 * So the close happens first and the CLI is held back until it has: `sh` holds
 * the write end, waits for a go-ahead on stdin, and only then `exec`s the CLI
 * over itself — the same process, so the status observed here is the CLI's
 * own. Writing to a pipe with no readers is EPIPE on the first byte, every
 * time, whatever the payload. Nothing is on disk, so there is no FIFO to make,
 * no temporary directory to clean up, and no path for anything to race.
 */
function runWithDepartedReader(
  broken: "stdout" | "stderr",
  argv: readonly string[],
): Promise<BrokenOutputRun> {
  // The literal `sh` is the shell's `$0`; the CLI invocation is its `$@`.
  const child = spawn(
    "sh",
    ["-c", 'read go; exec "$@"', "sh", process.execPath, bundlePath, ...argv],
    { env: cliEnvironment(), stdio: ["pipe", "pipe", "pipe"] },
  );
  // Every stream is a pipe here, so none of the three is null.
  const doomed = (broken === "stdout" ? child.stdout : child.stderr)!;
  const outcome = collectOutcome(child, (broken === "stdout" ? child.stderr : child.stdout)!);
  // `close` fires once the descriptor is really gone, so the go-ahead cannot
  // reach the shell while the pipe still has a reader.
  doomed.once("close", () => child.stdin!.end("go\n"));
  doomed.destroy();
  return outcome;
}

/**
 * Runs the built CLI with a stdout that refuses writes for a reason nobody
 * chose: a read-only descriptor, where the failure is EBADF rather than a
 * reader's decision to stop listening.
 */
function runWithUnwritableStdout(argv: readonly string[]): Promise<BrokenOutputRun> {
  // Read-only so that writing fails, and `/dev/null` so that nothing on disk
  // has to be made or cleaned up to say so.
  const readOnly = openSync("/dev/null", constants.O_RDONLY);
  const child = spawn(process.execPath, [bundlePath, ...argv], {
    env: cliEnvironment(),
    stdio: ["ignore", readOnly, "pipe"],
  });
  return collectOutcome(child, child.stderr!).finally(() => closeSync(readOnly));
}

describe("volli built entrypoint", () => {
  beforeAll(() => {
    const built = spawnSync(fileURLToPath(new URL("../node_modules/.bin/vp", import.meta.url)), [
      "pack",
    ]);
    expect(built.status, `vp pack failed: ${built.stderr?.toString() ?? ""}`).toBe(0);
  });

  it("embeds source and per-build identity separately from promoted versions", () => {
    const env = { ...process.env };
    delete env["VOLLI_SOCKET"];
    delete env["VOLLI_SESSION"];
    delete env["VOLLI_TICKET"];
    const run = spawnSync(process.execPath, [bundlePath, "help", "changes"], {
      env,
      encoding: "utf8",
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("CLI package: @volli/cli 0.0.1");
    expect(run.stdout).toContain(`Release promotion marker: ${releaseVersion}`);
    expect(run.stdout).toMatch(/Source revision: [0-9a-f]{12}(?:\+dirty)?/);
    expect(run.stdout).toMatch(/Build id: [0-9a-f]{12}(?:\+dirty)?@/);
    expect(run.stdout).not.toContain("source mode");
    expect(run.stdout).not.toContain("unbundled-source");
  });

  // The reported bug, as a process: `volli session list | head -12` printed
  // its first rows and then an unhandled `node:events` EPIPE stack, because a
  // write whose reader had gone raised an `error` nobody was listening for.
  // Without the handler this run exits 1 and puts that stack on stderr.
  it("says nothing when the reader of stdout has gone", async () => {
    const run = await runWithDepartedReader("stdout", ["help"]);
    expect(run.intactOutput).toBe("");
    expect(run.exitCode).toBe(0);
  });

  // The other half, and the one an over-eager fix gets wrong: bare `volli` is
  // a usage refusal that prints the whole reference to stderr and exits 2. A
  // reader that left has no opinion about whether the command worked, so the
  // status stays 2 — not 0 for having exited quietly, not 1 for crashing.
  it("keeps the command's own failure status when the reader of stderr has gone", async () => {
    const run = await runWithDepartedReader("stderr", []);
    expect(run.intactOutput).toBe("");
    expect(run.exitCode).toBe(2);
  });

  // Quiet is owed to a departed reader and to nobody else. A descriptor that
  // cannot be written is a real fault, and it still costs what it always did.
  it("stays loud when a write fails for a reason other than a departed reader", async () => {
    const run = await runWithUnwritableStdout(["help"]);
    expect(run.intactOutput).toContain("EBADF");
    expect(run.exitCode).toBe(1);
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
