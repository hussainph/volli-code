/**
 * Declares a worker that writes nothing anywhere, so a quit may end the
 * process under it (VC-1208). The tag is `@volli/shared`'s registered
 * `WORKER_EXIT_KIND` symbol, set here without importing that package: the
 * extraction worker's own entry loads this file, and must stay small.
 */
export function declareStatelessWorker(worker: object): void {
  Object.defineProperty(worker, Symbol.for("volli.worker-exit-kind"), {
    value: "stateless",
    configurable: true,
  });
}
