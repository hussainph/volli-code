import { afterEach, describe, expect, it } from "vite-plus/test";
import type { LogFields } from "../log/logger";
import { captureHostLog } from "../testing/log";
import { createCheckpointFailureReporter } from "./checkpoint-diagnostics";

const UNUSABLE = "projection checkpoint unusable; refolded from the event log";

/** One reporter with a captured sink and a hand-wound clock. */
function reporter(): {
  warnings: { msg: string; fields: LogFields }[];
  report: (error: unknown) => void;
  at: () => void;
} {
  const warnings: { msg: string; fields: LogFields }[] = [];
  let now = 1_000;
  return {
    warnings,
    report: createCheckpointFailureReporter({
      warn: (msg, fields) => warnings.push({ msg, fields }),
      now: () => now,
    }),
    at: () => {
      now += 60_000;
    },
  };
}

describe("createCheckpointFailureReporter (VC-355)", () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it("reports the first failure, because a silent one is only ever slowness", () => {
    const { warnings, report } = reporter();
    const error = new Error("checkpoint digest mismatch");
    report(error);
    expect(warnings).toEqual([{ msg: UNUSABLE, fields: { error } }]);
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
    expect(warnings[1]?.fields).toMatchObject({ suppressed: 49 });
  });

  it("carries a thrown non-Error without assuming its shape", () => {
    const { warnings, report } = reporter();
    report("plain string failure");
    expect(warnings[0]?.fields).toEqual({ error: "plain string failure" });
  });

  it("defaults to the host log so an unconfigured host still sees the failure", () => {
    const log = captureHostLog();
    restore = log.restore;
    createCheckpointFailureReporter()(new Error("default sink"));
    expect(log.of("session-checkpoint")).toEqual([
      expect.objectContaining({
        level: "warn",
        msg: UNUSABLE,
        error: expect.objectContaining({ name: "Error", message: "default sink" }),
      }),
    ]);
  });
});
