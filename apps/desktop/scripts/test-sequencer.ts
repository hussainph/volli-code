import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { BaseSequencer, type TestSpecification } from "vite-plus/test/node";

import durations from "./test-durations.json" with { type: "json" };

const desktopRoot = fileURLToPath(new URL("../", import.meta.url));
const measured: Readonly<Record<string, number>> = durations.files;

// Balance the expensive tail rather than adding runner jobs. The timing sample
// records files costing >=5s (tests + collection + environment + setup/prepare);
// remaining/new files use their project's measured mean below that cutoff.
// Stale entries never select tests: Vitest's live discovery is the only input.
export default class DesktopTestSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const shard = this.ctx.config.shard;
    if (!shard) return files;
    const bins = Array.from({ length: shard.count }, () => ({
      cost: 0,
      files: [] as TestSpecification[],
    }));
    const weighted = files
      .map((spec) => {
        const path = relative(desktopRoot, spec.moduleId).split(sep).join("/");
        const fallback =
          spec.project.name === "main" ? durations.fallbackMs.main : durations.fallbackMs.renderer;
        return { spec, cost: measured[path] ?? fallback, key: `${spec.project.name}:${path}` };
      })
      .toSorted((a, b) => b.cost - a.cost || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    for (const { spec, cost } of weighted) {
      let lightest = 0;
      for (let i = 1; i < bins.length; i++) {
        if (bins[i].cost < bins[lightest].cost) lightest = i;
      }
      bins[lightest].files.push(spec);
      bins[lightest].cost += cost;
    }
    return bins[shard.index - 1].files;
  }
}
