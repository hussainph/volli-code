/**
 * `@volli/host-core/perf`: the machine-local perf store (VC-1092) — the
 * stalls this machine's app logged, bounded and queryable, its log-sink hook
 * into the stall monitors, and the summary the support report carries.
 *
 * An explicit list: a name is public because a client, or a client's test,
 * imports it as this cluster's API. See the cluster map in the package README.
 */
export { perfSummary, type PerfSummary } from "../perf/queries";
export { perfStallSink } from "../perf/stall-sink";
export {
  openPerfStore,
  PERF_STORE_BOUNDS,
  type PerfStore,
  type PerfStoreOptions,
  perfStorePath,
} from "../perf/store";
