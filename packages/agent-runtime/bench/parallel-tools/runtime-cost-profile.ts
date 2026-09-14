/**
 * The bundled entry `bench:runtime:profile` runs under `node --cpu-prof`.
 *
 * It exists because a CPU profile of a vitest worker is mostly vitest. This
 * runs the same fixture at the same published arm with nothing else in the
 * process, so every sample in the `.cpuprofile` belongs to the runtime.
 */

import {
  buildRuntimeCostReport,
  formatRuntimeCostReport,
  RUNTIME_COST_ARMS,
} from "./runtime-cost-report";

console.log(formatRuntimeCostReport(buildRuntimeCostReport(RUNTIME_COST_ARMS.published)));
