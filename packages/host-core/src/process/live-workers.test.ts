import { declareWorkerExitKind } from "@volli/shared";
import { Worker } from "node:worker_threads";
import { afterEach, beforeAll, describe, expect, it } from "vite-plus/test";

import {
  attachReadOnlyGate,
  createReadOnlyGate,
  endReadOnlyWorkers,
  leaveReadOnlyPhase,
  liveWorkerCount,
  quitExitDecision,
  settleLiveWorkers,
  watchLiveWorkers,
} from "./live-workers";

/** A real worker thread that runs until it is terminated. */
const IDLE = "setInterval(() => {}, 1000);";
const started: Worker[] = [];

function start(source = IDLE): Worker {
  const worker = new Worker(source, { eval: true });
  started.push(worker);
  return worker;
}

function exited(worker: Worker): Promise<unknown> {
  return new Promise((resolve) => worker.once("exit", resolve));
}

beforeAll(() => {
  watchLiveWorkers();
  // A second call must not count every worker twice.
  watchLiveWorkers();
});

afterEach(async () => {
  await Promise.all(started.splice(0).map((worker) => worker.terminate()));
  expect(liveWorkerCount()).toBe(0);
});

describe("watchLiveWorkers", () => {
  it("counts every worker this thread starts, declared or not, until it exits", async () => {
    const worker = start("setTimeout(() => {}, 50);");
    expect(liveWorkerCount()).toBe(1);
    await exited(worker);
    expect(liveWorkerCount()).toBe(0);
  });
});

describe("quitExitDecision", () => {
  it("exits as before when nothing is running", () => {
    expect(quitExitDecision({ claim: true })).toBe("exit");
  });

  it("exits now when every live worker is declared read-only", () => {
    declareWorkerExitKind(start(), "automatic-backup");
    declareWorkerExitKind(start(), "stateless");
    declareWorkerExitKind(start(), "database-reader");
    expect(quitExitDecision({ claim: true })).toBe("exit-now");
  });

  it("waits for a worker nobody declared", () => {
    declareWorkerExitKind(start(), "automatic-backup");
    start();
    expect(quitExitDecision({ claim: true })).toBe("exit");
  });

  it("finishes an upgrade first, claim or not", () => {
    declareWorkerExitKind(start(), "database-upgrade");
    declareWorkerExitKind(start(), "automatic-backup");
    expect(quitExitDecision({ claim: false })).toBe("finish-upgrade-first");
    expect(quitExitDecision({ claim: true })).toBe("finish-upgrade-first");
  });

  it("claims a check still in its read-only phase, which then refuses to write", () => {
    const gate = createReadOnlyGate();
    const check = start();
    declareWorkerExitKind(check, "database-check");
    attachReadOnlyGate(check, gate);
    // Without the claim a check may be writing: wait.
    expect(quitExitDecision({ claim: false })).toBe("exit");
    expect(quitExitDecision({ claim: true })).toBe("exit-now");
    // Claimed once, it stays claimed.
    expect(quitExitDecision({ claim: true })).toBe("exit-now");
    expect(() => leaveReadOnlyPhase(gate)).toThrow(/Volli is quitting/);
  });

  it("waits for a check that has started writing", () => {
    const gate = createReadOnlyGate();
    const check = start();
    declareWorkerExitKind(check, "database-check");
    attachReadOnlyGate(check, gate);
    leaveReadOnlyPhase(gate);
    expect(quitExitDecision({ claim: true })).toBe("exit");
  });

  it("waits for a check with no gate to claim", () => {
    declareWorkerExitKind(start(), "database-check");
    expect(quitExitDecision({ claim: true })).toBe("exit");
  });

  it("claims nothing for a quit that waits anyway", () => {
    const gate = createReadOnlyGate();
    const check = start();
    declareWorkerExitKind(check, "database-check");
    attachReadOnlyGate(check, gate);
    start();
    expect(quitExitDecision({ claim: true })).toBe("exit");
    // Unclaimed: the check may still go on to write.
    expect(() => leaveReadOnlyPhase(gate)).not.toThrow();
  });

  it("claims the gate across threads: the worker's first write then refuses", async () => {
    const gate = createReadOnlyGate();
    const check = new Worker(
      `const { parentPort, workerData } = require("node:worker_threads");
       const word = new Int32Array(workerData.gate);
       parentPort.once("message", () => {
         // leaveReadOnlyPhase, as the worker runs it.
         const previous = Atomics.compareExchange(word, 0, 0, 1);
         parentPort.postMessage(previous === 2 ? "refused" : "writing");
       });`,
      { eval: true, workerData: { gate } },
    );
    started.push(check);
    declareWorkerExitKind(check, "database-check");
    attachReadOnlyGate(check, gate);
    expect(quitExitDecision({ claim: true })).toBe("exit-now");
    const answer = new Promise((resolve) => check.once("message", resolve));
    check.postMessage("write", []);
    expect(await answer).toBe("refused");
  });
});

describe("endReadOnlyWorkers", () => {
  it("ends every live worker, a check once claimed, when all of them may be ended", async () => {
    const backup = start();
    declareWorkerExitKind(backup, "automatic-backup");
    const gate = createReadOnlyGate();
    const check = start();
    declareWorkerExitKind(check, "database-check");
    attachReadOnlyGate(check, gate);
    const ended = Promise.all([exited(backup), exited(check)]);

    expect(endReadOnlyWorkers()).toBe(2);
    await ended;
    expect(liveWorkerCount()).toBe(0);
    expect(() => leaveReadOnlyPhase(gate)).toThrow(/Volli is quitting/);
  });

  it("ends and claims nothing for a quit that waits", () => {
    declareWorkerExitKind(start(), "automatic-backup");
    const gate = createReadOnlyGate();
    const check = start();
    declareWorkerExitKind(check, "database-check");
    attachReadOnlyGate(check, gate);
    start();
    const upgrade = start();
    declareWorkerExitKind(upgrade, "database-upgrade");

    expect(endReadOnlyWorkers()).toBe(0);
    expect(liveWorkerCount()).toBe(4);
    // Unclaimed: the check may still go on to write.
    expect(() => leaveReadOnlyPhase(gate)).not.toThrow();
  });

  it("leaves a check that is already writing to finish", async () => {
    const backup = start();
    declareWorkerExitKind(backup, "automatic-backup");
    const gate = createReadOnlyGate();
    const writing = start();
    declareWorkerExitKind(writing, "database-check");
    attachReadOnlyGate(writing, gate);
    leaveReadOnlyPhase(gate);
    const ended = exited(backup);

    expect(endReadOnlyWorkers()).toBe(1);
    await ended;
    expect(liveWorkerCount()).toBe(1);
    expect(quitExitDecision({ claim: true })).toBe("exit");
  });
});

describe("settleLiveWorkers", () => {
  it("returns at once when nothing is running", async () => {
    await settleLiveWorkers(60_000);
  });

  it("returns once every worker has exited", async () => {
    start("setTimeout(() => {}, 20);");
    const before = Date.now();
    await settleLiveWorkers(60_000);
    expect(Date.now() - before).toBeLessThan(30_000);
    expect(liveWorkerCount()).toBe(0);
  });

  it("returns after the grace while a worker keeps running", async () => {
    start();
    await settleLiveWorkers(20);
    expect(liveWorkerCount()).toBe(1);
  });
});
