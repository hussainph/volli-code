/**
 * Declares a worker that writes nothing anywhere, so a quit may end the
 * process under it (VC-1208).
 *
 * The extraction worker's own entry loads this file, and it must not pull
 * `@volli/shared`'s whole index into that bundle (nor can that index load
 * under plain Node, where the worker runs in tests). So the tag is written
 * here, and only the types come from shared: the key and the kind are
 * checked against `WorkerExitKindKey` and `DeclaredWorkerKind`, and drift
 * fails to compile. The test reads the tag back through shared.
 */
import type { DeclaredWorkerKind, WorkerExitKindKey } from "@volli/shared";

const KEY: WorkerExitKindKey = "volli.worker-exit-kind";
const STATELESS: DeclaredWorkerKind = "stateless";

export function declareStatelessWorker(worker: object): void {
  Object.defineProperty(worker, Symbol.for(KEY), { value: STATELESS, configurable: true });
}
