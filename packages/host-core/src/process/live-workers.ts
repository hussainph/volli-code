/**
 * Every worker thread this thread has started, and what a quit may do about
 * them (VC-1208). The rule is `decideQuitExit` in `@volli/shared`; this file
 * only gathers its input.
 *
 * Workers are seen through Node's `worker_threads` diagnostics channel, so a
 * worker started anywhere in the process (a library's included) is counted,
 * declared or not. A creation site declares its worker with
 * `declareWorkerExitKind`; one that does not is unknown, and the quit waits
 * for it as before.
 *
 * The routine database check is read-only only until it is about to write.
 * Its phase is a shared word both threads change with one atomic
 * compare-and-swap, so exactly one of them wins: the quit's claim (the
 * worker then refuses to write at all) or the worker's first write (the quit
 * then waits for it, as before).
 */
import { subscribe } from "node:diagnostics_channel";
import type { Worker } from "node:worker_threads";

import {
  classifyWorker,
  declaredWorkerExitKind,
  decideQuitExit,
  type QuitExitDecision,
} from "@volli/shared";

const live = new Set<Worker>();
const gates = new WeakMap<Worker, Int32Array>();
let watching = false;

/** The gate's word: the worker has written nothing yet. */
const READ_ONLY = 0;
/** The worker is about to write, or has. */
const WRITING = 1;
/** A quit claimed the worker while it had written nothing: it never will. */
const CLAIMED = 2;

/**
 * Starts counting workers. Call once, before the first worker starts; a
 * worker started earlier is not counted, and the quit then cannot see it.
 */
export function watchLiveWorkers(): void {
  if (watching) return;
  watching = true;
  subscribe("worker_threads", (message) => {
    const { worker } = message as { worker: Worker };
    live.add(worker);
    worker.once("exit", () => live.delete(worker));
  });
}

/** How many workers this thread has running now. */
export function liveWorkerCount(): number {
  return live.size;
}

/** A fresh gate, for the worker's `workerData` and for {@link attachReadOnlyGate}. */
export function createReadOnlyGate(): SharedArrayBuffer {
  return new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
}

/** Ties `gate` to `worker`, whose phase it then is. */
export function attachReadOnlyGate(worker: Worker, gate: SharedArrayBuffer): void {
  gates.set(worker, new Int32Array(gate));
}

/** Thrown in the worker when a quit claimed it before its first write. */
class ReadOnlyGateClaimedError extends Error {
  constructor() {
    super("Volli is quitting: the database was not opened for writing.");
    this.name = "ReadOnlyGateClaimedError";
  }
}

/**
 * The worker's side, called before its first write of any kind. Returns once
 * the worker may write; throws {@link ReadOnlyGateClaimedError} when a quit
 * claimed it first, and the worker must then write nothing.
 */
export function leaveReadOnlyPhase(gate: SharedArrayBuffer): void {
  if (Atomics.compareExchange(new Int32Array(gate), 0, READ_ONLY, WRITING) === CLAIMED) {
    throw new ReadOnlyGateClaimedError();
  }
}

/** Claims a gated worker for the quit: true unless it is already writing. */
function claim(worker: Worker): boolean {
  const gate = gates.get(worker);
  if (gate === undefined) return false;
  return Atomics.compareExchange(gate, 0, READ_ONLY, CLAIMED) !== WRITING;
}

/**
 * What a quit does about the workers running now. With `claim`, a check
 * still in its read-only phase is claimed when, and only when, the claims
 * are what an immediate exit waits on: a claimed check never writes, so
 * nothing is claimed for a quit that will wait anyway.
 */
export function quitExitDecision(options: { claim: boolean }): QuitExitDecision {
  const workers = [...live];
  const kinds = workers.map((worker) => declaredWorkerExitKind(worker));
  const unclaimed = decideQuitExit(kinds.map((kind) => classifyWorker(kind)));
  if (!options.claim || unclaimed !== "exit") return unclaimed;
  if (decideQuitExit(kinds.map((kind) => classifyWorker(kind, true))) !== "exit-now") return "exit";
  return decideQuitExit(
    workers.map((worker, index) => {
      const kind = kinds[index];
      return classifyWorker(kind, kind === "database-check" && claim(worker));
    }),
  );
}

/**
 * Ends every live worker the quit may end, the way Node's teardown would end
 * it: `terminate()`, which stops a worker running JavaScript at once and one
 * inside a native call only when that call returns. A check is ended only
 * once claimed; any other worker is left to the ordinary exit. Returns how
 * many it asked to end, so what is still running afterwards is what is
 * stuck in a native call.
 */
export function endReadOnlyWorkers(): number {
  let ended = 0;
  for (const worker of live) {
    const kind = declaredWorkerExitKind(worker);
    if (classifyWorker(kind, kind === "database-check" && claim(worker)) !== "read-only") continue;
    void worker.terminate();
    ended += 1;
  }
  return ended;
}

/**
 * Resolves once no worker is running, or after `graceMs`: a cancelled worker
 * between native calls exits by itself in milliseconds, and an exit that no
 * longer has to skip anything is the ordinary one.
 */
export async function settleLiveWorkers(graceMs: number): Promise<void> {
  if (live.size === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all([...live].map((worker) => new Promise((resolve) => worker.once("exit", resolve)))),
    new Promise((resolve) => {
      timer = setTimeout(resolve, graceMs);
    }),
  ]);
  clearTimeout(timer);
}
