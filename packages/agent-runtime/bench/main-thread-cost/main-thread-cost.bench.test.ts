import { parseStreamingJson, parseToolCallArguments } from "@earendil-works/pi-ai/utils/json-parse";
import { ToolCallArgumentsStream } from "@earendil-works/pi-ai/utils/streaming-json";
import { describe, expect, it } from "vite-plus/test";

import {
  generateDiffString,
  generateEditDiff,
  generateUnifiedPatch,
} from "../../src/pi/vendor/pi-harness/tools/edit-diff";

/**
 * VC-1074: synchronous work the agent loop does on Electron main per tool
 * call. Run with `pnpm --filter @volli/agent-runtime bench main-thread-cost`.
 * For a small parser-only run, prefix that command with
 * `MAIN_THREAD_COST_BENCH_QUICK=1` and append `-t 'streamed tool-call arguments'`.
 *
 * 1. Streamed tool-call arguments. `eager` repeats pi-ai 1.0.0's per-delta
 *    behavior (re-parse the whole accumulated buffer on every delta);
 *    `incremental` uses the installed Pi 1.5 upstream parser. Both finish
 *    with a full parse. Timings are diagnostic; deterministic parser-input
 *    character counts assert quadratic versus linear work, not wall time.
 * 2. The edit tool's diff: two unbounded jsdiff passes before, one bounded
 *    pass now.
 */

const DELTA_CHARS = 30;
const QUICK = process.env.MAIN_THREAD_COST_BENCH_QUICK === "1";

interface StreamCost {
  ms: number;
  /** Characters submitted to parsing, including the final full parse. */
  parsedChars: number;
  arguments: Record<string, unknown>;
}

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

function streamEager(json: string): StreamCost {
  const started = performance.now();
  let partial = "";
  let parsedChars = 0;
  for (let offset = 0; offset < json.length; offset += DELTA_CHARS) {
    partial += json.slice(offset, offset + DELTA_CHARS);
    parseStreamingJson(partial);
    parsedChars += partial.length;
  }
  const final = parseToolCallArguments(partial);
  parsedChars += partial.length;
  return { ms: performance.now() - started, parsedChars, arguments: final.arguments };
}

function streamIncremental(json: string): StreamCost {
  const started = performance.now();
  const stream = new ToolCallArgumentsStream();
  let parsedChars = 0;
  for (let offset = 0; offset < json.length; offset += DELTA_CHARS) {
    const delta = json.slice(offset, offset + DELTA_CHARS);
    stream.append(delta);
    parsedChars += delta.length;
  }
  const final = stream.finish();
  parsedChars += stream.text.length;
  return { ms: performance.now() - started, parsedChars, arguments: final.arguments };
}

function median(samples: number[]): number {
  const sorted = samples.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

describe("main-thread cost per tool call (VC-1074)", () => {
  it("streamed tool-call arguments: quadratic eager, linear installed incremental parser", () => {
    streamIncremental(argumentJson((QUICK ? 2 : 50) * 1024));
    streamEager(argumentJson((QUICK ? 2 : 20) * 1024));
    const rows: Array<{ kb: number; eager?: StreamCost; incremental: StreamCost }> = [];
    for (const kb of QUICK ? [2, 4, 8] : [20, 50, 100, 200, 400]) {
      const json = argumentJson(kb * 1024);
      // Eager parsing beyond 100 KB is prohibitively expensive; the smaller
      // samples already demonstrate the quadratic character budget.
      const eager = kb > 100 ? undefined : streamEager(json);
      const samples = Array.from({ length: QUICK ? 3 : 5 }, () => streamIncremental(json));
      const incremental = { ...samples[0], ms: median(samples.map((sample) => sample.ms)) };
      const expected = JSON.parse(json);
      for (const sample of samples) {
        expect(sample.arguments).toEqual(expected);
        expect(sample.parsedChars).toBe(2 * json.length);
      }
      if (eager !== undefined) {
        expect(eager.arguments).toEqual(expected);
        // Sum the accumulated prefix lengths, plus the final full parse.
        let expectedChars = json.length;
        for (let end = DELTA_CHARS; end < json.length + DELTA_CHARS; end += DELTA_CHARS) {
          expectedChars += Math.min(end, json.length);
        }
        expect(eager.parsedChars).toBe(expectedChars);
      }
      rows.push({ kb, eager, incremental });
    }
    console.table(
      rows.map((row) => ({
        "content (KB)": row.kb,
        "eager (ms)": row.eager?.ms.toFixed(1) ?? "-",
        "incremental (ms)": row.incremental.ms.toFixed(1),
        "eager parse input (chars)": row.eager?.parsedChars ?? "-",
        "incremental parse input (chars)": row.incremental.parsedChars,
      })),
    );
    const at = (kb: number) => rows.find((row) => row.kb === kb)!;
    // These are deterministic input budgets, not machine-dependent timings.
    // The SSE regression separately spies on the provider's actual parser inputs.
    const [eagerSmall, eagerLarge] = QUICK ? [4, 8] : [50, 100];
    const [incrementalSmall, incrementalLarge] = QUICK ? [4, 8] : [200, 400];
    expect(at(eagerLarge).eager!.parsedChars / at(eagerSmall).eager!.parsedChars).toBeGreaterThan(
      3,
    );
    expect(
      at(incrementalLarge).incremental.parsedChars / at(incrementalSmall).incremental.parsedChars,
    ).toBeLessThan(3);
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
