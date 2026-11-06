import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPatch } from "diff";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { BACKGROUND_CONTEXT } from "./vendor/pi-harness/context";
import { NodeExecutionEnv } from "./vendor/pi-harness/env/nodejs";
import { createEditTool } from "./vendor/pi-harness/tools/edit";
import {
  EDIT_DIFF_BOUNDS,
  generateDiffString,
  generateEditDiff,
  generateUnifiedPatch,
  normalizeToLF,
  stripBom,
} from "./vendor/pi-harness/tools/edit-diff";
import type { AgentHarnessToolInvocation } from "./vendor/pi-harness/types";

/**
 * VC-1074: the edit tool's diff runs synchronously on the host's main thread.
 * It now takes one bounded comparison where the file's bytes allow, and a
 * summary when the comparison is too large.
 */

function views(path: string, original: string, written: string) {
  return {
    path,
    original,
    written,
    oldView: normalizeToLF(stripBom(original).text),
    newView: normalizeToLF(stripBom(written).text),
  };
}

/** The two comparisons the edit tool made before: the reference output. */
function unbounded(path: string, original: string, written: string) {
  const input = views(path, original, written);
  return {
    ...generateDiffString(input.oldView, input.newView),
    patch: generateUnifiedPatch(path, original, written),
  };
}

/** A small deterministic PRNG, so a failure names its seed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomFile(next: () => number, lines: number, vocabulary: number): string[] {
  return Array.from({ length: lines }, () => `l${Math.floor(next() * vocabulary)}`);
}

function mutate(next: () => number, lines: string[], vocabulary: number): string[] {
  const result = [...lines];
  const changes = 1 + Math.floor(next() * 6);
  for (let change = 0; change < changes; change++) {
    const at = Math.floor(next() * (result.length + 1));
    const roll = next();
    if (roll < 0.33) result.splice(at, 1);
    else if (roll < 0.66) result.splice(at, 0, `n${Math.floor(next() * vocabulary)}`);
    else result.splice(at, 1, `m${Math.floor(next() * vocabulary)}`);
  }
  return result;
}

describe("generateEditDiff", () => {
  it("derives exactly the patch and display diff of the two separate comparisons", () => {
    for (let seed = 1; seed <= 600; seed++) {
      const next = random(seed);
      const vocabulary = 2 + Math.floor(next() * 20);
      const before = randomFile(next, Math.floor(next() * 40), vocabulary);
      const after = mutate(next, before, vocabulary);
      const oldEol = next() < 0.8 ? "\n" : "";
      const newEol = next() < 0.8 ? "\n" : "";
      const original = before.length === 0 ? "" : before.join("\n") + oldEol;
      const written = after.length === 0 ? "" : after.join("\n") + newEol;

      const result = generateEditDiff(views("dir/file.ts", original, written));
      expect(result, `seed ${seed}`).toEqual(unbounded("dir/file.ts", original, written));
      expect(applyPatch(original, result.patch!), `seed ${seed}`).toBe(written);
    }
  });

  it("compares the bytes separately when a BOM or CR makes them differ from the view", () => {
    for (const [original, written] of [
      ["\uFEFFa\nb\nc\n", "\uFEFFa\nB\nc\n"],
      ["a\r\nb\r\nc\r\n", "a\r\nB\r\nc\r\n"],
      ["a\rb\rc", "a\rB\rc"],
      ["one\r\ntwo\nthree\r\n", "one\r\n2\nthree\r\n"],
    ]) {
      const result = generateEditDiff(views("file", original, written));
      expect(result).toEqual(unbounded("file", original, written));
      expect(applyPatch(original, result.patch!)).toBe(written);
    }
  });

  it("summarizes a comparison that exceeds the bounds instead of running it out", () => {
    const before = Array.from({ length: 200 }, (_, index) => `line ${index}`);
    const after = before.map((line, index) => (index >= 50 && index % 2 === 0 ? `${line}!` : line));
    const result = generateEditDiff(
      views("file", before.join("\n") + "\n", after.join("\n") + "\n"),
      { timeoutMs: 60_000, maxEditLength: 10 },
    );
    expect(result).toEqual({
      diff: "(diff omitted: the change is too large to compare)",
      firstChangedLine: 51,
    });
    expect(
      generateEditDiff(views("file", "same", "same and more"), {
        timeoutMs: 60_000,
        maxEditLength: 0,
      }),
    ).toEqual({ diff: "(diff omitted: the change is too large to compare)", firstChangedLine: 1 });
    expect(
      generateEditDiff(views("file", "a\nb\nc", "a\nb\nc\nd"), {
        timeoutMs: 60_000,
        maxEditLength: 0,
      }).firstChangedLine,
    ).toBe(3);
  });

  it("keeps the display diff when only the byte comparison is bounded out", () => {
    // Two line changes in the view, four in the bytes.
    const input = {
      path: "file",
      original: "x\r\ny\r\n",
      written: "x\ny\n",
      oldView: "x\ny\n",
      newView: "x\nY\n",
    };
    const result = generateEditDiff(input, { timeoutMs: 60_000, maxEditLength: 3 });
    expect(result).toEqual(generateDiffString(input.oldView, input.newView));
    expect(result).not.toHaveProperty("patch");
  });

  it("skips the byte comparison once the shared time budget is spent", () => {
    let now = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => (now += 1_000));
    try {
      // Identical views settle without a timed comparison; the budget is gone
      // by the time the bytes would be compared.
      const result = generateEditDiff(views("file", "a\r\nb\r\n", "a\nb\n"));
      expect(result).toEqual({ diff: "", firstChangedLine: undefined });
    } finally {
      clock.mockRestore();
    }
  });

  it("bounds wall time on a large scattered edit", () => {
    const before = Array.from({ length: 20_000 }, (_, index) => `const value${index} = ${index};`);
    const after = before.map((line, index) => (index % 20 === 0 ? `${line} // changed` : line));
    const started = performance.now();
    const result = generateEditDiff(views("big.ts", before.join("\n"), after.join("\n")));
    const elapsed = performance.now() - started;
    // Generous for a loaded CI machine; unbounded this took seconds.
    expect(elapsed).toBeLessThan(EDIT_DIFF_BOUNDS.timeoutMs * 10);
    expect(result.firstChangedLine).toBe(1);
  });
});

describe("edit tool diff bounds", () => {
  const invocation: AgentHarnessToolInvocation = {
    invocationId: "call",
    operationId: "op",
    turnId: "turn",
    getMemo: async () => undefined,
    setMemo: async () => {},
  };
  let directory: string | undefined;
  afterEach(async () => {
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("lands an edit too large to compare and reports a summary without a patch", async () => {
    directory = await mkdtemp(join(tmpdir(), "vc-1074-edit-"));
    const lines = Array.from({ length: 12_000 }, (_, index) => `old ${index}`);
    const replaced = lines.map((_, index) => `new ${index}`);
    const header = "keep\n";
    await writeFile(join(directory, "file"), header + lines.join("\n") + "\n");

    const result = await createEditTool().execute(
      "call",
      { path: "file", edits: [{ oldText: lines.join("\n"), newText: replaced.join("\n") }] },
      () => {},
      { env: new NodeExecutionEnv({ cwd: directory }) },
      invocation,
      BACKGROUND_CONTEXT,
    );

    expect(await readFile(join(directory, "file"), "utf8")).toBe(
      header + replaced.join("\n") + "\n",
    );
    expect(result.content).toEqual([
      { type: "text", text: "Successfully replaced 1 block(s) in file." },
    ]);
    expect(result.details).toEqual({
      diff: "(diff omitted: the change is too large to compare)",
      firstChangedLine: 2,
    });
  });
});
