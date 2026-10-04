import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, beforeEach } from "vite-plus/test";

import { resetRepositoryTurnsForTest, withRepositoryWorktreeTurn } from "./repository-turn";

let tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "repository-turn-"));
  tempDirs.push(dir);
  return dir;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Lets real macrotasks run before an "it has not started" assertion. A
 * microtask boundary is not proof of serialization: an implementation that
 * merely deferred every change by a tick would satisfy it while still running
 * two `worktree add`s against one repository at once.
 */
const settleTurns = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => resetRepositoryTurnsForTest());

afterEach(() => {
  resetRepositoryTurnsForTest();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("withRepositoryWorktreeTurn", () => {
  it("does not interleave two changes to one repository", async () => {
    // Two tickets in one project: the second asks while the first's
    // `worktree add` is still running, and must not touch the repository until
    // it has finished.
    const first = deferred<string>();
    const events: string[] = [];
    const a = withRepositoryWorktreeTurn("/repo", async () => {
      events.push("a");
      return first.promise;
    });
    const b = withRepositoryWorktreeTurn("/repo", () => {
      events.push("b");
      return "b";
    });
    await settleTurns();
    expect(events).toEqual(["a"]);
    first.resolve("a");
    expect(await a).toBe("a");
    expect(await b).toBe("b");
    expect(events).toEqual(["a", "b"]);
  });

  it("lets changes to different repositories overlap", async () => {
    const gate = deferred<void>();
    let started = 0;
    const a = withRepositoryWorktreeTurn("/a", async () => {
      started += 1;
      await gate.promise;
      return "a";
    });
    const b = withRepositoryWorktreeTurn("/b", () => {
      started += 1;
      return "b";
    });
    expect(started).toBe(2);
    gate.resolve();
    await expect(a).resolves.toBe("a");
    await expect(b).resolves.toBe("b");
  });

  it("runs queued changes FIFO", async () => {
    const order: number[] = [];
    const gate = deferred<void>();
    const a = withRepositoryWorktreeTurn("/repo", async () => {
      order.push(1);
      await gate.promise;
    });
    const b = withRepositoryWorktreeTurn("/repo", () => order.push(2));
    const c = withRepositoryWorktreeTurn("/repo", () => order.push(3));
    await settleTurns();
    expect(order).toEqual([1]);
    gate.resolve();
    await Promise.all([a, b, c]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("does not wedge the repository after a rejecting change", async () => {
    // A failed git operation must release only its caller and still advance the queue.
    const error = new Error("failed");
    const a = withRepositoryWorktreeTurn("/repo", () => Promise.reject(error));
    const b = withRepositoryWorktreeTurn("/repo", () => "recovered");
    await expect(a).rejects.toBe(error);
    await expect(b).resolves.toBe("recovered");
  });

  it("shares one queue for two spellings of a repository", async () => {
    // The alias is an EXPLICIT symlink rather than whatever `/tmp` happens to
    // be: on macOS `/tmp` resolves through `/private` and two spellings differ
    // by luck, but on Linux CI `tmpdir()` is already canonical, so a test that
    // leaned on that luck would compare a string with itself and prove nothing
    // about canonicalization at all.
    const parent = tempDir();
    const real = join(parent, "checkout");
    const alias = join(parent, "alias");
    mkdirSync(real);
    symlinkSync(real, alias, "dir");
    expect(alias).not.toBe(real);

    const gate = deferred<void>();
    let starts = 0;
    const a = withRepositoryWorktreeTurn(real, async () => {
      starts += 1;
      await gate.promise;
    });
    const b = withRepositoryWorktreeTurn(alias, () => {
      starts += 1;
    });
    await settleTurns();
    // Keyed on the raw string, the alias would be its own repository and run
    // straight through beside the change already in flight.
    expect(starts).toBe(1);
    gate.resolve();
    await Promise.all([a, b]);
    expect(starts).toBe(2);
  });

  it("folds a synchronous throw into the caller's rejection", async () => {
    // A change is `() => T | Promise<T>`, so `deps.git(...)` throwing on the
    // spot is an ordinary outcome, not a crash: it must reach the caller as a
    // rejection and must still let the queue advance.
    const thrown = new Error("git worktree remove failed");
    const gate = deferred<void>();
    const holder = withRepositoryWorktreeTurn("/repo", () => gate.promise);

    const failing = withRepositoryWorktreeTurn("/repo", () => {
      throw thrown;
    });
    const after = withRepositoryWorktreeTurn("/repo", () => "next");

    gate.resolve();
    await holder;
    await expect(failing).rejects.toBe(thrown);
    await expect(after).resolves.toBe("next");
  });

  it("folds a synchronous throw from the FIRST change into its rejection", async () => {
    // The idle fast path invokes the change by hand rather than through
    // `.then`, so it needs its own try/catch; without it the throw escapes
    // `withRepositoryWorktreeTurn` synchronously instead of rejecting, and the
    // repository is left with a queue whose tail never settles.
    const thrown = new Error("git worktree prune failed");
    const failing = withRepositoryWorktreeTurn("/repo", () => {
      throw thrown;
    });
    await expect(failing).rejects.toBe(thrown);
    await expect(withRepositoryWorktreeTurn("/repo", () => "next")).resolves.toBe("next");
  });

  it("runs an idle repository's change in the caller's own turn", async () => {
    // What `cleanup.ts` leans on: its final safety gate and the irreversible
    // `worktree remove` that follows it are one synchronous callback, and
    // taking the turn must not insert anything between the caller's decision
    // and that mutation when nothing else is changing the repository.
    let mutated = false;
    const change = withRepositoryWorktreeTurn("/repo", () => {
      mutated = true;
      return "done";
    });

    expect(mutated).toBe(true);
    await expect(change).resolves.toBe("done");
  });

  it("only lets a queued change observe a finished one", async () => {
    // A change that had been split in half by the queue would be observable
    // here as the intermediate value.
    const gate = deferred<void>();
    let value = "start";
    const first = withRepositoryWorktreeTurn("/repo", async () => {
      await gate.promise;
      value = "half";
      value = "finished";
    });
    const second = withRepositoryWorktreeTurn("/repo", () => value);

    await settleTurns();
    gate.resolve();
    await first;
    await expect(second).resolves.toBe("finished");
  });

  it("keeps a repository's queue while a change is still running", async () => {
    // The queue is forgotten when the repository goes idle, and "idle" has to
    // mean nothing queued AND nothing running. Dropping it as soon as one
    // change settles leaves the changes already in line ordered while letting
    // the NEXT caller — a fourth Session start, arriving mid-queue — run
    // straight through beside them.
    const first = deferred<void>();
    const second = deferred<void>();
    const started: string[] = [];

    const a = withRepositoryWorktreeTurn("/repo", () => first.promise);
    const b = withRepositoryWorktreeTurn("/repo", async () => {
      started.push("b");
      await second.promise;
    });

    first.resolve();
    await a;
    await settleTurns();

    const c = withRepositoryWorktreeTurn("/repo", () => {
      started.push("c");
    });
    await settleTurns();
    expect(started).toEqual(["b"]);

    second.resolve();
    await Promise.all([b, c]);
    expect(started).toEqual(["b", "c"]);
  });

  it("does not retain a drained repository queue", async () => {
    // The observable of a FORGOTTEN entry is the idle fast path: a caller that
    // finds no queue runs in its own turn, SYNCHRONOUSLY, while a caller that
    // finds a retained one chains onto its tail and runs a microtask later. So
    // the assertion is made before awaiting the second call — awaiting it would
    // read `true` whether the entry had been forgotten or leaked, which is
    // exactly the reading this test exists to avoid.
    //
    // `settleTurns()` is not slack: the entry is dropped one microtask AFTER
    // the first caller's `await` resumes (see the note in repository-turn.ts),
    // so a same-tick successor legitimately queues. What must never happen is
    // the entry surviving a drained repository at all — delete `release()` and
    // this fails.
    await withRepositoryWorktreeTurn("/repo", () => "done");
    await settleTurns();

    let ran = false;
    const second = withRepositoryWorktreeTurn("/repo", () => {
      ran = true;
    });
    expect(ran).toBe(true);
    await second;
  });

  it("queues a successor that arrives before the drained entry is dropped", async () => {
    // The other side of the note above, pinned so it stays a known cost rather
    // than a surprise: back-to-back changes in ONE tick are still ordered, they
    // simply do not get the fast path. Ordering is what matters; the fast path
    // is an optimization.
    const order: string[] = [];
    await withRepositoryWorktreeTurn("/repo", () => order.push("first"));

    let ranInline = false;
    const second = withRepositoryWorktreeTurn("/repo", () => {
      ranInline = true;
      order.push("second");
    });
    expect(ranInline).toBe(false);
    await second;
    expect(order).toEqual(["first", "second"]);
  });
});
