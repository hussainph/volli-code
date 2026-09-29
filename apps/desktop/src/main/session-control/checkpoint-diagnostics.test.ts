import { describe, expect, it } from "vite-plus/test";
import { createCheckpointFailureReporter } from "./checkpoint-diagnostics";

/** One reporter with a captured sink and a hand-wound clock. */
function reporter(): { warnings: string[]; report: (error: unknown) => void; at: () => void } {
  const warnings: string[] = [];
  let now = 1_000;
  return {
    warnings,
    report: createCheckpointFailureReporter({
      warn: (message) => warnings.push(message),
      now: () => now,
    }),
    at: () => {
      now += 60_000;
    },
  };
}

describe("createCheckpointFailureReporter (VC-355)", () => {
  it("reports the first failure, because a silent one is only ever slowness", () => {
    const { warnings, report } = reporter();
    report(new Error("checkpoint digest mismatch"));
    expect(warnings).toEqual([
      "[session-checkpoint] projection checkpoint unusable; refolded from the event log: checkpoint digest mismatch",
    ]);
  });

  it("summarizes a burst instead of emitting one line per Session", () => {
    const { warnings, report, at } = reporter();
    // The failing case is the repeating one: an undecodable row would otherwise
    // emit a line for every Session in a listing.
    for (let index = 0; index < 50; index += 1) report(new Error("unsupported version"));
    expect(warnings).toHaveLength(1);

    at();
    report(new Error("unsupported version"));
    expect(warnings).toHaveLength(2);
    // The count is what distinguishes a permanently failing cache from one
    // that missed once, so the suppressed failures are reported, not dropped.
    expect(warnings[1]).toContain("(49 more since the previous report were suppressed)");
  });

  it("describes a thrown non-Error without assuming its shape", () => {
    const { warnings, report } = reporter();
    report("plain string failure");
    expect(warnings[0]).toContain("plain string failure");
  });

  it("defaults to console.warn so an unconfigured host still sees the failure", () => {
    const lines: unknown[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => lines.push(args[0]);
    try {
      createCheckpointFailureReporter()(new Error("default sink"));
    } finally {
      console.warn = original;
    }
    expect(String(lines[0])).toContain("default sink");
  });
});
