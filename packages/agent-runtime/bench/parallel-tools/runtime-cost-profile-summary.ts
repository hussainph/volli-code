/**
 * Bottom-up self-sample table for one or more `.cpuprofile` files — the same
 * evidence a flame chart shows, in a form a report can quote.
 *
 * Rows are keyed by call frame (function name PLUS its script and line), not
 * by name alone. A bundle has many `run`, `count` and `main` frames, and
 * merging them by name produces a table that looks authoritative and attributes
 * cost to the wrong function.
 */

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

interface FrameTotal {
  name: string;
  location: string;
  hits: number;
}

/** Trailing path segments are what identify a frame to a reader; the rest is noise. */
function shortLocation(url: string, lineNumber: number): string {
  if (url === "") return "native";
  const parts = url.split("/");
  return `${parts.slice(-2).join("/")}:${lineNumber + 1}`;
}

export function summarizeCpuProfile(
  profile: CpuProfile,
  limit = 25,
): { totalSamples: number; rows: (FrameTotal & { share: number })[] } {
  const totalSamples = profile.nodes.reduce((total, node) => total + (node.hitCount ?? 0), 0);
  const byFrame = new Map<string, FrameTotal>();
  for (const node of profile.nodes) {
    const hits = node.hitCount ?? 0;
    if (hits === 0) continue;
    const name = node.callFrame.functionName || "(anonymous)";
    if (name === "(idle)") continue;
    const location = shortLocation(node.callFrame.url, node.callFrame.lineNumber);
    const key = `${name}\u0000${location}`;
    const existing = byFrame.get(key);
    if (existing) existing.hits += hits;
    else byFrame.set(key, { name, location, hits });
  }
  const rows = [...byFrame.values()]
    .toSorted((left, right) => right.hits - left.hits)
    .slice(0, limit)
    .map((frame) => ({
      name: frame.name,
      location: frame.location,
      hits: frame.hits,
      share: totalSamples === 0 ? 0 : frame.hits / totalSamples,
    }));
  return { totalSamples, rows };
}

const paths = process.argv.slice(2);
if (paths.length === 0) {
  throw new Error("Pass at least one .cpuprofile path.");
}

for (const path of paths) {
  const { totalSamples, rows } = summarizeCpuProfile(
    JSON.parse(readFileSync(path, "utf8")) as CpuProfile,
  );
  console.log(`\n${path}: ${totalSamples} self samples`);
  console.log("| self samples | share | function | where |");
  console.log("|-------------:|------:|----------|-------|");
  for (const row of rows) {
    console.log(
      `| ${row.hits} | ${(row.share * 100).toFixed(1)}% | ${row.name} | ${row.location} |`,
    );
  }
}
