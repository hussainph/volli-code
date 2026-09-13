import { buildRuntimeCostReport, formatRuntimeCostReport } from "./runtime-cost-report";

async function main(): Promise<void> {
  const report = await buildRuntimeCostReport({ samples: 20, operationScale: 20 });
  console.log(formatRuntimeCostReport(report));
}

void main();
