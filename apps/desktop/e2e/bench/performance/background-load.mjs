import { Worker } from "node:worker_threads";

export const BUSY_LOAD_PROFILE = "fixed-integer-mixing-v1";

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

export function busyLoadName(workerCount, durationMs) {
  requirePositiveInteger(workerCount, "worker count");
  requirePositiveInteger(durationMs, "load duration");
  const duration = durationMs % 1_000 === 0 ? `${durationMs / 1_000}s` : `${durationMs}ms`;
  return `${workerCount}-busy-core-for-${duration}`;
}

/**
 * Start a reproducible load arm. All workers warm the same integer-mixing loop,
 * then receive one shared monotonic deadline. A successful full arm waits for
 * that deadline; a quick smoke or failed arm writes the explicit stop sentinel.
 */
export async function startBusyLoad(workerCount, durationMs, options = {}) {
  requirePositiveInteger(workerCount, "worker count");
  requirePositiveInteger(durationMs, "load duration");
  const warmupMs = options.warmupMs ?? 1_500;
  if (!Number.isSafeInteger(warmupMs) || warmupMs < 0) {
    throw new Error("load warmup must be a non-negative safe integer");
  }

  const deadlineBuffer = new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT);
  const deadlineControl = new BigInt64Array(deadlineBuffer);
  const workers = [];
  const states = Array.from({ length: workerCount }, () => ({
    ready: false,
    iterations: 0,
    checksum: 0,
    expired: false,
    stopped: false,
    exitCode: null,
  }));
  const controller = new AbortController();
  let startedAtMonotonicMs = null;
  let deadlineAtMonotonicMs = null;
  let deadlineTimer = null;
  let allowEarlyExit = false;
  let fault = null;

  const fail = (error) => {
    if (fault !== null) return;
    fault = error instanceof Error ? error : new Error(String(error));
    if (startedAtMonotonicMs !== null && !controller.signal.aborted) {
      controller.abort(fault);
    }
  };

  const readyPromises = [];
  const exitPromises = [];
  try {
    for (let index = 0; index < workerCount; index += 1) {
      let resolveReady;
      let rejectReady;
      readyPromises.push(
        new Promise((resolvePromise, rejectPromise) => {
          resolveReady = resolvePromise;
          rejectReady = rejectPromise;
        }),
      );
      let resolveExit;
      exitPromises.push(
        new Promise((resolvePromise) => {
          resolveExit = resolvePromise;
        }),
      );
      const worker = new Worker(
        options.workerUrl ?? new URL("./fixed-duration-busy-worker.mjs", import.meta.url),
        { workerData: { index, deadlineBuffer } },
      );
      workers.push(worker);
      worker.on("message", (message) => {
        states[index] = { ...states[index], ...message };
        if (message.ready === true) resolveReady();
      });
      worker.on("error", (error) => {
        rejectReady(error);
        fail(error);
      });
      worker.on("exit", (code) => {
        states[index] = { ...states[index], exitCode: code };
        resolveExit(code);
        if (!states[index].ready)
          rejectReady(new Error(`busy worker ${index} exited before ready`));
        if (!allowEarlyExit && states[index].expired !== true) {
          fail(new Error(`busy worker ${index} exited before the fixed deadline (code ${code})`));
        }
      });
    }
    await Promise.all(readyPromises);
    await delay(warmupMs);
    if (fault !== null) throw fault;
    if (states.some((state) => state.iterations === 0)) {
      throw new Error("busy-core load workers did not make progress during warmup");
    }
  } catch (error) {
    Atomics.store(deadlineControl, 0, -1n);
    await Promise.allSettled(workers.map((worker) => worker.terminate()));
    throw error;
  }

  const name = busyLoadName(workerCount, durationMs);
  const startedAtEpochMs = Date.now();
  startedAtMonotonicMs = performance.now();
  deadlineAtMonotonicMs = startedAtMonotonicMs + durationMs;
  const deadlineNs = process.hrtime.bigint() + BigInt(durationMs) * 1_000_000n;
  Atomics.store(deadlineControl, 0, deadlineNs);
  deadlineTimer = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort(new Error(`${name} reached its fixed ${durationMs}ms deadline`));
    }
  }, durationMs);

  const interrupted = (label) => {
    const reason = controller.signal.reason;
    const detail = reason instanceof Error ? reason.message : String(reason ?? "stopped");
    return new Error(`background load unavailable during ${label}: ${detail}`, {
      cause: reason instanceof Error ? reason : undefined,
    });
  };
  const assertActive = (label) => {
    if (controller.signal.aborted || fault !== null || performance.now() >= deadlineAtMonotonicMs) {
      throw interrupted(label);
    }
  };

  let finishPromise = null;
  return {
    name,
    workers: workerCount,
    durationMs,
    profile: BUSY_LOAD_PROFILE,
    signal: controller.signal,
    assertActive,
    async run(label, operation) {
      assertActive(label);
      const pending = Promise.resolve().then(() => operation(controller.signal));
      let rejectInterruption;
      const interruption = new Promise((_resolvePromise, rejectPromise) => {
        rejectInterruption = rejectPromise;
      });
      const onAbort = () => rejectInterruption(interrupted(label));
      controller.signal.addEventListener("abort", onAbort, { once: true });
      try {
        const result = await Promise.race([pending, interruption]);
        assertActive(label);
        return result;
      } catch (error) {
        if (controller.signal.aborted) {
          await pending.catch(() => undefined);
          throw interrupted(label);
        }
        throw error;
      } finally {
        controller.signal.removeEventListener("abort", onAbort);
      }
    },
    async finish({ completeExposure, reason }) {
      if (finishPromise !== null) return finishPromise;
      finishPromise = (async () => {
        const measurementsCompletedAtMs = performance.now();
        if (!completeExposure) {
          allowEarlyExit = true;
          clearTimeout(deadlineTimer);
          Atomics.store(deadlineControl, 0, -1n);
          if (!controller.signal.aborted) {
            controller.abort(new Error(`${name} stopped early: ${reason}`));
          }
        }

        const exits = Promise.all(exitPromises);
        const exitTimeoutMs = completeExposure
          ? Math.max(5_000, deadlineAtMonotonicMs - performance.now() + 5_000)
          : 5_000;
        let exitedCleanly = true;
        await Promise.race([
          exits,
          delay(exitTimeoutMs).then(() => {
            exitedCleanly = false;
          }),
        ]);
        if (!exitedCleanly) {
          await Promise.allSettled(workers.map((worker) => worker.terminate()));
          throw new Error(`${name} workers did not exit at their shared deadline`);
        }
        clearTimeout(deadlineTimer);

        if (completeExposure) {
          if (fault !== null) throw fault;
          if (states.some((state) => state.expired !== true || state.stopped === true)) {
            throw new Error(`${name} did not complete the configured fixed-duration exposure`);
          }
        }
        const stoppedAtMonotonicMs = performance.now();
        return {
          profile: BUSY_LOAD_PROFILE,
          configuredDurationMs: durationMs,
          warmupMs,
          startedAt: new Date(startedAtEpochMs).toISOString(),
          deadlineAt: new Date(startedAtEpochMs + durationMs).toISOString(),
          exposureDurationMs: Math.round(stoppedAtMonotonicMs - startedAtMonotonicMs),
          measurementsDurationMs: Math.round(measurementsCompletedAtMs - startedAtMonotonicMs),
          completion: completeExposure ? "fixed-duration-complete" : reason,
          workers: states.map((state, index) => Object.assign({ index }, state)),
        };
      })();
      return finishPromise;
    },
  };
}
