import { describe, expect, it } from "vite-plus/test";
import { countsForMove, moveRateEstimator } from "./facts";

describe("move counts and measured time left", () => {
  it("takes actual plan counts without letting an older preview overwrite them", () => {
    const history = { tickets: 999, transcriptBytes: 10, piLogBytes: 20 };
    expect(
      countsForMove(
        {
          exported: { tickets: 3, sessions: 2, sessionEvents: 9, blobs: 1 },
          objects: [
            { source: "blob", key: "blob", bytes: 40, sha256: "hash" },
            { source: "file", file: "/legacy", key: "legacy", bytes: 900, sha256: "hash" },
          ],
        },
        history,
      ),
    ).toEqual({
      tickets: 3,
      sessions: 2,
      events: 9,
      attachments: 1,
      attachmentBytes: 40,
      transcriptBytes: 10,
      piLogBytes: 20,
    });
  });
  it("waits for a real sample, then measures completed units over elapsed monotonic time", () => {
    const rate = moveRateEstimator();
    expect(rate("move", "copy", { completed: 0, total: 100, unit: "rows" }, 1000)).toBeNull();
    expect(rate("move", "copy", { completed: 20, total: 100, unit: "rows" }, 3000)).toBe(8);
    expect(rate("move", "copy", { completed: 100, total: 100, unit: "rows" }, 11000)).toBe(0);
  });
  it("does not carry a rate across a pause, a new step, or restarted progress", () => {
    const rate = moveRateEstimator();
    const progress = { completed: 10, total: 100, unit: "bytes" } as const;
    rate("move", "upload", progress, 0);
    expect(rate("move", "upload", { ...progress, completed: 20 }, 1000)).toBe(8);
    expect(rate("move", "upload", null, 2000)).toBeNull();
    expect(rate("move", "upload", { ...progress, completed: 20 }, 3000)).toBeNull();
    expect(rate("move", "history", { completed: 1, total: 5, unit: "sessions" }, 4000)).toBeNull();
    expect(rate("move", "history", { completed: 2, total: 5, unit: "sessions" }, 5000)).toBe(3);
    expect(rate("move", "history", { completed: 0, total: 5, unit: "sessions" }, 6000)).toBeNull();
  });
});
