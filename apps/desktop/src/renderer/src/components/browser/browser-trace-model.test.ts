import { describe, expect, it } from "vite-plus/test";

import type { BrowserTraceFrame, BrowserTraceStep } from "@volli/shared";

import {
  browserTraceFacts,
  clampTraceIndex,
  elapsed,
  followTraceIndex,
  traceIndexAtOffset,
  traceIndexForKey,
} from "./browser-trace-model";

function frame(tabId: string, over: Partial<BrowserTraceStep> = {}): BrowserTraceFrame {
  return {
    traceId: `trace-${tabId}`,
    tabId,
    step: {
      seq: 0,
      action: "click",
      target: "Save",
      url: "https://example.com/",
      title: "Example",
      generation: 1,
      at: 10_000,
      outcome: "ok",
      rule: null,
      error: null,
      pictureId: null,
      ...over,
    },
  };
}

describe("clampTraceIndex", () => {
  it("keeps an index inside the replay, and zero for an empty one", () => {
    expect(clampTraceIndex(-3, 5)).toBe(0);
    expect(clampTraceIndex(9, 5)).toBe(4);
    expect(clampTraceIndex(2.4, 5)).toBe(2);
    expect(clampTraceIndex(3, 0)).toBe(0);
  });
});

describe("traceIndexForKey", () => {
  it("steps, strides and jumps with the slider's keys", () => {
    expect(traceIndexForKey("ArrowLeft", 3, 20)).toBe(2);
    expect(traceIndexForKey("ArrowUp", 0, 20)).toBe(0);
    expect(traceIndexForKey("ArrowRight", 3, 20)).toBe(4);
    expect(traceIndexForKey("ArrowDown", 19, 20)).toBe(19);
    expect(traceIndexForKey("PageUp", 12, 20)).toBe(2);
    expect(traceIndexForKey("PageDown", 12, 20)).toBe(19);
    expect(traceIndexForKey("Home", 12, 20)).toBe(0);
    expect(traceIndexForKey("End", 2, 20)).toBe(19);
  });

  it("leaves every other key to the page", () => {
    expect(traceIndexForKey("Enter", 3, 20)).toBeNull();
    expect(traceIndexForKey("a", 3, 20)).toBeNull();
  });
});

describe("traceIndexAtOffset", () => {
  it("maps a pointer along the track to the step under it, clamped at the ends", () => {
    expect(traceIndexAtOffset(0, 100, 4)).toBe(0);
    expect(traceIndexAtOffset(49, 100, 4)).toBe(1);
    expect(traceIndexAtOffset(99, 100, 4)).toBe(3);
    expect(traceIndexAtOffset(250, 100, 4)).toBe(3);
    expect(traceIndexAtOffset(-20, 100, 4)).toBe(0);
  });

  it("answers zero for a track with nothing to scrub", () => {
    expect(traceIndexAtOffset(10, 0, 4)).toBe(0);
    expect(traceIndexAtOffset(10, 100, 0)).toBe(0);
  });
});

describe("followTraceIndex", () => {
  const run = (tabId: string, seqs: number[]) =>
    seqs.map((seq) => frame(tabId, { seq, at: seq * 1_000 }));

  it("follows the newest step when the person was watching it", () => {
    expect(followTraceIndex(4, run("a", [0, 1, 2, 3, 4]), run("a", [0, 1, 2, 3, 4, 5, 6, 7]))).toBe(
      7,
    );
  });

  it("stays on the same step a person scrubbed back to, even as the bound shifts every position", () => {
    expect(followTraceIndex(1, run("a", [0, 1, 2, 3, 4]), run("a", [0, 1, 2, 3, 4, 5]))).toBe(1);
    // The bound let steps 0 and 1 go: step 2 is now first.
    expect(followTraceIndex(2, run("a", [0, 1, 2, 3, 4]), run("a", [2, 3, 4, 5, 6]))).toBe(0);
  });

  it("clamps when the step itself was let go, and opens a replay that just gained steps at its newest", () => {
    expect(followTraceIndex(0, run("a", [0, 1, 2]), run("a", [2, 3]))).toBe(0);
    expect(followTraceIndex(0, [], run("a", [0, 1, 2]))).toBe(0);
    expect(followTraceIndex(3, run("a", [0, 1]), run("a", [0, 1, 2]))).toBe(2);
  });
});

const time = (at: number) => `t${at}`;

describe("browserTraceFacts", () => {
  it("reads a step as its verb, object, page, time and offset", () => {
    const timeline = [frame("one", { at: 1_000 }), frame("one", { at: 66_000, seq: 1 })];
    expect(browserTraceFacts(timeline, 1, time)).toEqual({
      verb: "Clicked",
      object: "“Save”",
      url: "https://example.com/",
      title: "Example",
      outcome: "ok",
      trouble: null,
      time: "t66000",
      offset: "+1m 05s",
      tab: null,
    });
  });

  it("names the refusal's rule, or a failure's words", () => {
    const refused = [frame("one", { outcome: "refused", rule: "browser.stale-ref" })];
    const bare = [frame("one", { outcome: "refused", rule: null })];
    const failed = [frame("one", { outcome: "failed", error: "The engine went away" })];
    expect(browserTraceFacts(refused, 0, time)?.trouble).toBe("refused by browser.stale-ref");
    expect(browserTraceFacts(bare, 0, time)?.trouble).toBe("refused");
    expect(browserTraceFacts(failed, 0, time)?.trouble).toBe("The engine went away");
  });

  it("says which tab a step ran in once the replay spans more than one", () => {
    const timeline = [frame("one"), frame("two"), frame("one")];
    expect(browserTraceFacts(timeline, 1, time)?.tab).toBe("Tab 2");
    expect(browserTraceFacts(timeline, 2, time)?.tab).toBe("Tab 1");
  });

  it("answers null past the end, and formats with the locale clock by default", () => {
    expect(browserTraceFacts([], 0)).toBeNull();
    expect(browserTraceFacts([frame("one")], 5)).toBeNull();
    expect(browserTraceFacts([frame("one")], 0)?.time).toMatch(/\d/);
  });
});

describe("elapsed", () => {
  it("reads seconds, minutes and hours the short way", () => {
    expect(elapsed(-5)).toBe("+0s");
    expect(elapsed(42_500)).toBe("+42s");
    expect(elapsed(187_000)).toBe("+3m 07s");
    expect(elapsed(3_720_000)).toBe("+1h 02m");
  });
});
