import {
  parseStreamingJson,
  parseStreamingToolArguments,
} from "@earendil-works/pi-ai/utils/json-parse";
import { describe, expect, it } from "vite-plus/test";

import {
  generateDiffString,
  generateEditDiff,
  generateUnifiedPatch,
} from "../../src/pi/vendor/pi-harness/tools/edit-diff";

/**
 * VC-1074: synchronous work the agent loop does on Electron main per tool
 * call. Run with `pnpm --filter @volli/agent-runtime bench -- main-thread-cost`.
 *
 * 1. Streamed tool-call arguments. `upstream` is pi-ai 1.0.0's per-delta
 *    behavior (re-parse the whole accumulated buffer on every delta);
 *    `patched` is the per-delta call the patched providers make. The CPU cost
 *    upstream grows with the square of the argument size; patched grows
 *    linearly.
 * 2. The edit tool's diff: two unbounded jsdiff passes before, one bounded
 *    pass now.
 */

const DELTA_CHARS = 30;

function argumentJson(chars: number): string {
  const lines: string[] = [];
  let length = 0;
  for (let index = 0; length < chars; index += 1) {
    const line = `line ${index}: "quoted" \\ back\tslash ${"x".repeat(index % 17)}`;
    lines.push(line);
    length += line.length + 1;
  }
  return JSON.stringify({ path: "big.txt", content: lines.join("\n").slice(0, chars) });
}

function streamUpstream(json: string): number {
  const started = performance.now();
  let partial = "";
  for (let offset = 0; offset < json.length; offset += DELTA_CHARS) {
    partial += json.slice(offset, offset + DELTA_CHARS);
    parseStreamingJson(partial);
  }
  parseStreamingJson(partial);
  return performance.now() - started;
}

function streamPatched(json: string): number {
  const started = performance.now();
  const block = { arguments: {} as Record<string, unknown> };
  let partial = "";
  for (let offset = 0; offset < json.length; offset += DELTA_CHARS) {
    partial += json.slice(offset, offset + DELTA_CHARS);
    block.arguments = parseStreamingToolArguments(block, partial);
  }
  block.arguments = parseStreamingJson(partial);
  return performance.now() - started;
}

function median(samples: number[]): number {
  const sorted = samples.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

describe("main-thread cost per tool call (VC-1074)", () => {
  it("streamed tool-call arguments: quadratic upstream, linear patched", () => {
    streamPatched(argumentJson(50 * 1024));
    streamUpstream(argumentJson(20 * 1024));
    const rows: Array<{ kb: number; upstreamMs: number | null; patchedMs: number }> = [];
    for (const kb of [20, 50, 100, 200, 400]) {
      const json = argumentJson(kb * 1024);
      rows.push({
        kb,
        // Upstream past 100 KB costs a minute per sample; its curve is clear by then.
        upstreamMs: kb > 100 ? null : streamUpstream(json),
        patchedMs: median([1, 2, 3, 4, 5].map(() => streamPatched(json))),
      });
    }
    console.table(
      rows.map((row) => ({
        "args (KB)": row.kb,
        "upstream (ms)": row.upstreamMs?.toFixed(1) ?? "-",
        "patched (ms)": row.patchedMs.toFixed(1),
      })),
    );
    const at = (kb: number) => rows.find((row) => row.kb === kb)!;
    // 2x the size: about 4x the cost when quadratic, about 2x when linear.
    expect(at(100).upstreamMs! / at(50).upstreamMs!).toBeGreaterThan(3);
    expect(at(400).patchedMs / at(200).patchedMs).toBeLessThan(3);
  });

  it("edit diff: two unbounded passes before, one bounded pass now", () => {
    const rows: Array<Record<string, string | number>> = [];
    for (const [lines, changes] of [
      [2_000, 10],
      [20_000, 10],
      [20_000, 1_000],
    ] as const) {
      const before = Array.from({ length: lines }, (_, index) => `const v${index} = f(${index});`);
      const stride = Math.floor(lines / changes);
      const after = before.map((line, index) =>
        index % stride === 0 ? `${line} // edited` : line,
      );
      const original = before.join("\n") + "\n";
      const written = after.join("\n") + "\n";

      let started = performance.now();
      generateDiffString(original, written);
      generateUnifiedPatch("file.ts", original, written);
      const beforeMs = performance.now() - started;

      started = performance.now();
      const result = generateEditDiff({
        path: "file.ts",
        original,
        written,
        oldView: original,
        newView: written,
      });
      const afterMs = performance.now() - started;
      rows.push({
        file: `${lines} lines / ${changes} changes`,
        "before (ms)": beforeMs.toFixed(1),
        "after (ms)": afterMs.toFixed(1),
        outcome: result.patch === undefined ? "summary" : "diff + patch",
      });
    }
    console.table(rows);
  });
});
