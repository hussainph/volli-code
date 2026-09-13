import { readFileSync } from "node:fs";

interface CpuProfileNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
  hitCount?: number;
  children?: number[];
}

interface CpuProfile {
  nodes: CpuProfileNode[];
}

const paths = process.argv.slice(2);
if (paths.length === 0) {
  throw new Error("Pass at least one .cpuprofile path.");
}

for (const path of paths) {
  const profile = JSON.parse(readFileSync(path, "utf8")) as CpuProfile;
  const samples = profile.nodes.reduce((total, node) => total + (node.hitCount ?? 0), 0);
  const byFunction = new Map<string, number>();
  for (const node of profile.nodes) {
    const name = node.callFrame.functionName || "(anonymous)";
    byFunction.set(name, (byFunction.get(name) ?? 0) + (node.hitCount ?? 0));
  }
  const rows = [...byFunction]
    .filter(([name, hits]) => hits > 0 && name !== "(idle)")
    .map(([name, hits]) => ({ name, hits, share: samples === 0 ? 0 : hits / samples }))
    .toSorted((left, right) => right.hits - left.hits)
    .slice(0, 25);

  console.log(`\n${path}: ${samples} self samples`);
  console.log("| self samples | share | function |");
  console.log("|-------------:|------:|----------|");
  for (const row of rows) {
    console.log(`| ${row.hits} | ${(row.share * 100).toFixed(1)}% | ${row.name} |`);
  }
}
