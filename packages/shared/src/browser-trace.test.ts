import { describe, expect, it } from "vite-plus/test";

import {
  appendBrowserTraceStep,
  BROWSER_TRACE_TEXT_LIMIT,
  type BrowserTrace,
  type BrowserTraceStep,
  browserTracePictureIds,
  browserTraceStartIndex,
  browserTraceTimeline,
  cleanBrowserTraceText,
  isBrowserTraceAction,
  isBrowserTraceOutcome,
  newBrowserTrace,
  readBrowserTrace,
} from "./browser-trace";

function step(overrides: Partial<BrowserTraceStep> = {}): Omit<BrowserTraceStep, "seq"> {
  const { seq: _seq, ...rest } = {
    seq: 0,
    action: "click" as const,
    target: "Sign in",
    url: "https://example.com/",
    title: "Example",
    generation: 1,
    at: 1_000,
    outcome: "ok" as const,
    rule: null,
    error: null,
    pictureId: "p-1",
    ...overrides,
  };
  return rest;
}

function trace(overrides: Partial<BrowserTrace> = {}): BrowserTrace {
  return {
    ...newBrowserTrace({ traceId: "t-1", sessionId: "s-1", tabId: "tab-1", startedAt: 500 }),
    ...overrides,
  };
}

describe("cleanBrowserTraceText", () => {
  it("keeps plain page text as it reads", () => {
    expect(cleanBrowserTraceText("Sign in")).toBe("Sign in");
  });

  it("removes controls, zero-width marks and bidi overrides, and collapses whitespace", () => {
    expect(cleanBrowserTraceText("  Pay\u202e\u0000 now\u200b\n\tplease\ufeff ")).toBe(
      "Pay now please",
    );
  });

  it("answers null for non-strings and for text that leaves nothing behind", () => {
    expect(cleanBrowserTraceText(42)).toBeNull();
    expect(cleanBrowserTraceText(null)).toBeNull();
    expect(cleanBrowserTraceText(" \u202e\u0007 ")).toBeNull();
  });

  it("bounds by code points, never splitting a surrogate pair", () => {
    const long = "😀".repeat(BROWSER_TRACE_TEXT_LIMIT + 5);
    const clean = cleanBrowserTraceText(long);
    expect(Array.from(clean ?? "")).toHaveLength(BROWSER_TRACE_TEXT_LIMIT);
    expect(clean?.endsWith("😀…")).toBe(true);
    expect(cleanBrowserTraceText("abcdef", 4)).toBe("abc…");
    expect(cleanBrowserTraceText("abcd", 4)).toBe("abcd");
  });
});

describe("guards", () => {
  it("knows the recorded actions and outcomes", () => {
    expect(isBrowserTraceAction("click")).toBe(true);
    expect(isBrowserTraceAction("read")).toBe(false);
    expect(isBrowserTraceAction(3)).toBe(false);
    expect(isBrowserTraceOutcome("refused")).toBe(true);
    expect(isBrowserTraceOutcome("maybe")).toBe(false);
    expect(isBrowserTraceOutcome(undefined)).toBe(false);
  });
});

describe("appendBrowserTraceStep", () => {
  it("numbers steps in order and moves updatedAt forward", () => {
    const one = appendBrowserTraceStep(trace(), step({ at: 900 }));
    const two = appendBrowserTraceStep(one.trace, step({ at: 800, pictureId: "p-2" }));
    expect(two.trace.steps.map((kept) => kept.seq)).toEqual([0, 1]);
    // A clock that stepped back never moves the record's own time backwards.
    expect(two.trace.updatedAt).toBe(900);
    expect(two.dropped).toEqual([]);
  });

  it("lets the oldest steps go past the bound and says how many", () => {
    let current = trace();
    const dropped: BrowserTraceStep[] = [];
    for (let index = 0; index < 5; index += 1) {
      const next = appendBrowserTraceStep(current, step({ pictureId: `p-${index}` }), 3);
      current = next.trace;
      dropped.push(...next.dropped);
    }
    expect(current.steps.map((kept) => kept.seq)).toEqual([2, 3, 4]);
    expect(current.droppedSteps).toBe(2);
    expect(dropped.map((gone) => gone.pictureId)).toEqual(["p-0", "p-1"]);
  });

  it("always keeps the newest step, whatever bound it is given", () => {
    const next = appendBrowserTraceStep(
      appendBrowserTraceStep(trace(), step(), 0).trace,
      step(),
      0,
    );
    expect(next.trace.steps).toHaveLength(1);
    expect(next.trace.steps[0]?.seq).toBe(1);
  });

  it("uses the default bound when none is given", () => {
    expect(appendBrowserTraceStep(trace(), step()).trace.steps).toHaveLength(1);
  });
});

describe("browserTracePictureIds", () => {
  it("names every frame a trace keeps", () => {
    const one = appendBrowserTraceStep(trace(), step({ pictureId: "a" })).trace;
    const two = appendBrowserTraceStep(one, step({ pictureId: null })).trace;
    expect(browserTracePictureIds(two)).toEqual(["a"]);
  });
});

describe("readBrowserTrace", () => {
  const stored = appendBrowserTraceStep(trace(), step()).trace;

  it("reads back what the host wrote", () => {
    expect(readBrowserTrace(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
  });

  it("refuses a record whose header it cannot trust", () => {
    expect(readBrowserTrace(null)).toBeNull();
    expect(readBrowserTrace([])).toBeNull();
    expect(readBrowserTrace({ ...stored, version: 2 })).toBeNull();
    expect(readBrowserTrace({ ...stored, traceId: "" })).toBeNull();
    expect(readBrowserTrace({ ...stored, sessionId: 3 })).toBeNull();
    expect(readBrowserTrace({ ...stored, tabId: null })).toBeNull();
    expect(readBrowserTrace({ ...stored, startedAt: -1 })).toBeNull();
    expect(readBrowserTrace({ ...stored, updatedAt: Number.NaN })).toBeNull();
    expect(readBrowserTrace({ ...stored, droppedSteps: "0" })).toBeNull();
    expect(readBrowserTrace({ ...stored, steps: {} })).toBeNull();
  });

  it("drops a step it cannot read and keeps the rest", () => {
    const good = stored.steps[0];
    const read = readBrowserTrace({
      ...stored,
      steps: [
        good,
        "not a step",
        { ...good, seq: -1 },
        { ...good, action: "read" },
        { ...good, at: "then" },
        { ...good, outcome: "meh" },
        { ...good, generation: "1" },
      ],
    });
    expect(read?.steps).toEqual([good]);
  });

  it("re-cleans page text and normalises empty fields on read", () => {
    const read = readBrowserTrace({
      ...stored,
      steps: [
        {
          ...stored.steps[0],
          target: "Sign\u202e in",
          title: 7,
          url: "",
          rule: "browser.stale-generation",
          error: "The page did not load",
          generation: null,
          pictureId: undefined,
        },
      ],
    });
    expect(read?.steps[0]).toMatchObject({
      target: "Sign in",
      title: null,
      url: null,
      rule: "browser.stale-generation",
      error: "The page did not load",
      generation: null,
      pictureId: null,
    });
  });
});

describe("browserTraceTimeline", () => {
  it("merges a Session's tabs into the order the calls settled", () => {
    const first = appendBrowserTraceStep(
      appendBrowserTraceStep(trace({ traceId: "a", tabId: "one" }), step({ at: 10 })).trace,
      step({ at: 30 }),
    ).trace;
    const second = appendBrowserTraceStep(
      trace({ traceId: "b", tabId: "two" }),
      step({ at: 20 }),
    ).trace;
    expect(
      browserTraceTimeline([first, second]).map((frame) => [frame.tabId, frame.step.at]),
    ).toEqual([
      ["one", 10],
      ["two", 20],
      ["one", 30],
    ]);
  });

  it("breaks a tie by record order within a trace and by trace id across them", () => {
    const same = appendBrowserTraceStep(
      appendBrowserTraceStep(trace({ traceId: "b" }), step({ at: 5, target: "first" })).trace,
      step({ at: 5, target: "second" }),
    ).trace;
    const other = appendBrowserTraceStep(
      trace({ traceId: "a" }),
      step({ at: 5, target: "a" }),
    ).trace;
    expect(browserTraceTimeline([same, other]).map((frame) => frame.step.target)).toEqual([
      "a",
      "first",
      "second",
    ]);
    expect(browserTraceTimeline([other, same]).map((frame) => frame.step.target)).toEqual([
      "a",
      "first",
      "second",
    ]);
  });
});

describe("browserTraceStartIndex", () => {
  const one = appendBrowserTraceStep(
    appendBrowserTraceStep(trace({ traceId: "a", tabId: "one" }), step({ at: 1, pictureId: "x" }))
      .trace,
    step({ at: 3, pictureId: "y" }),
  ).trace;
  const two = appendBrowserTraceStep(
    trace({ traceId: "b", tabId: "two" }),
    step({ at: 2, pictureId: "z" }),
  ).trace;
  const timeline = browserTraceTimeline([one, two]);

  it("opens at the frame the card showed", () => {
    expect(browserTraceStartIndex(timeline, { pictureId: "z" })).toBe(1);
  });

  it("falls back to the tab's latest step, then to the latest of all", () => {
    expect(browserTraceStartIndex(timeline, { pictureId: "gone", tabId: "two" })).toBe(1);
    expect(browserTraceStartIndex(timeline, { tabId: "one" })).toBe(2);
    expect(browserTraceStartIndex(timeline, { tabId: "closed" })).toBe(2);
    expect(browserTraceStartIndex(timeline, {})).toBe(2);
  });

  it("is zero for an empty replay", () => {
    expect(browserTraceStartIndex([], { pictureId: "x" })).toBe(0);
  });
});
