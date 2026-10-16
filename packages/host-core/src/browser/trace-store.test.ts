import { describe, expect, it } from "vite-plus/test";

import type { BrowserTrace } from "@volli/shared";

import {
  BrowserTraceStore,
  type BrowserTraceFrame,
  type BrowserTracePersistence,
  type BrowserTraceStepInput,
  type BrowserTraceStorePorts,
} from "./trace-store";

/**
 * One sink shared across store instances: the relaunch cases build a SECOND
 * store over the same disk, which a fake living inside the store never could.
 */
function disk() {
  const traces = new Map<string, BrowserTrace>();
  const frames = new Map<string, BrowserTraceFrame>();
  const persist: BrowserTracePersistence = {
    writeTrace: (trace) => void traces.set(trace.traceId, structuredClone(trace)),
    listTraces: () => [...traces.values()],
    removeTrace: (id) => void traces.delete(id),
    frames: {
      write: (bytes, record) => void frames.set(record.id, { bytes, record }),
      read: (id) => {
        const held = frames.get(id);
        return held === undefined ? null : { bytes: held.bytes, mime: held.record.mime };
      },
      list: () => [...frames.values()].map((one) => one.record),
      remove: (id) => void frames.delete(id),
    },
  };
  return { traces, frames, persist };
}

/** The picture store's live set, as far as the trace store can see it. */
const live = new Map<string, BrowserTraceFrame>();
const frameOf = (id: string) => live.get(id) ?? null;
const jpeg = (label: string, id = label): BrowserTraceFrame => ({
  bytes: Buffer.from(label),
  record: {
    id,
    tabId: "tab-1",
    generation: 1,
    capturedAt: 1_000,
    ownerSessionId: "session-1",
    mime: "image/jpeg",
  },
});

function store(
  options: Partial<Omit<BrowserTraceStorePorts, "persist">> & {
    persist?: BrowserTracePersistence | null;
  } = {},
): BrowserTraceStore {
  let nextId = 0;
  const { persist, ...rest } = options;
  return new BrowserTraceStore({
    createId: () => `trace-${++nextId}`,
    now: () => 1_000,
    frameOf,
    ...(persist === null || persist === undefined ? {} : { persist }),
    ...rest,
  });
}

function step(over: Partial<BrowserTraceStepInput> = {}): BrowserTraceStepInput {
  return {
    sessionId: "session-1",
    tabId: "tab-1",
    action: "click",
    target: "Save",
    url: "https://example.com/",
    title: "Example",
    generation: 2,
    outcome: "ok",
    rule: null,
    error: null,
    pictureId: null,
    ...over,
  };
}

describe("BrowserTraceStore", () => {
  it("keeps one ordered trace per Session and tab, and copies each step's frame out of the live set", () => {
    live.set("p-1", jpeg("one", "p-1"));
    live.set("p-2", jpeg("two", "p-2"));
    const sink = disk();
    const traces = store({ persist: sink.persist });

    traces.record(step({ action: "open", target: null, pictureId: "p-1" }));
    traces.record(step({ pictureId: "p-2" }));
    traces.record(step({ tabId: "tab-2", pictureId: null }));
    traces.record(step({ sessionId: "session-2" }));

    const mine = traces.tracesOf("session-1");
    expect(mine.map((trace) => [trace.tabId, trace.steps.map((kept) => kept.action)])).toEqual([
      ["tab-1", ["open", "click"]],
      ["tab-2", ["click"]],
    ]);
    expect(mine[0]?.steps.map((kept) => kept.pictureId)).toEqual(["p-1", "p-2"]);
    expect([...sink.frames.keys()]).toEqual(["p-1", "p-2"]);
    expect(sink.traces.get(mine[0]!.traceId)?.steps).toHaveLength(2);
    // Once the live set lets the capture go, the kept frame still answers.
    live.delete("p-1");
    expect(traces.frameDataUrl("p-1")).toBe(
      `data:image/jpeg;base64,${Buffer.from("one").toString("base64")}`,
    );
    expect(traces.tracesOf("session-3")).toEqual([]);
  });

  it("records a frame the live set no longer holds as no frame, not as a dangling id", () => {
    const traces = store({ persist: disk().persist });
    traces.record(step({ pictureId: "long-gone" }));
    expect(traces.tracesOf("session-1")[0]?.steps[0]?.pictureId).toBeNull();
  });

  it("keeps the picture id with no disk, for the live set to answer while it can", () => {
    const traces = store({ persist: null });
    traces.record(step({ pictureId: "p-live" }));
    expect(traces.tracesOf("session-1")[0]?.steps[0]?.pictureId).toBe("p-live");
    expect(traces.frameDataUrl("p-live")).toBeNull();
  });

  it("cleans page text, keeps a rule only on a refusal, and bounds a failure's words", () => {
    const traces = store();
    traces.record(
      step({
        title: "Pay\u202e now",
        target: "  Sign\nin ",
        rule: "browser.x",
        error: "e".repeat(900),
      }),
    );
    traces.record(step({ outcome: "refused", rule: "browser.stale-ref" }));

    const [first, second] = traces.tracesOf("session-1")[0]!.steps;
    expect(first).toMatchObject({ title: "Pay now", target: "Sign in", rule: null });
    expect(Array.from(first?.error ?? "")).toHaveLength(400);
    expect(second?.rule).toBe("browser.stale-ref");
  });

  it("answers a frame read only for an id a kept trace names", () => {
    live.set("p-9", jpeg("nine", "p-9"));
    const sink = disk();
    sink.frames.set("stranger", jpeg("x", "stranger"));
    const traces = store({ persist: sink.persist });
    traces.record(step({ pictureId: "p-9" }));

    expect(traces.frameDataUrl("stranger")).toBeNull();
    expect(traces.frameDataUrl("../../etc/passwd")).toBeNull();
    sink.frames.delete("p-9");
    expect(traces.frameDataUrl("p-9")).toBeNull();
  });

  it("drops the frames of steps the step bound lets go of", () => {
    for (const id of ["a", "b", "c"]) live.set(id, jpeg(id, id));
    const sink = disk();
    const traces = store({ persist: sink.persist, stepLimit: 2 });
    for (const id of ["a", "b", "c"]) traces.record(step({ pictureId: id }));

    const [trace] = traces.tracesOf("session-1");
    expect(trace?.droppedSteps).toBe(1);
    expect([...sink.frames.keys()]).toEqual(["b", "c"]);
    expect(traces.frameDataUrl("a")).toBeNull();
  });

  it("rehydrates after a relaunch, sweeps orphans, and starts a fresh trace for a tab id seen before", () => {
    live.set("p-r", jpeg("r", "p-r"));
    const sink = disk();
    store({ persist: sink.persist }).record(step({ pictureId: "p-r" }));
    sink.frames.set("orphan", jpeg("left behind", "orphan"));

    let nextId = 100;
    const relaunched = new BrowserTraceStore({
      createId: () => `trace-${++nextId}`,
      now: () => 2_000,
      frameOf,
      persist: sink.persist,
    });
    expect(sink.frames.has("orphan")).toBe(false);
    live.clear();
    expect(relaunched.frameDataUrl("p-r")).not.toBeNull();

    // The same Session and tab id after a relaunch is a new tab: a new trace.
    relaunched.record(step());
    expect(relaunched.tracesOf("session-1").map((trace) => trace.traceId)).toEqual([
      "trace-1",
      "trace-101",
    ]);
  });

  it("sweeps traces past their age, oldest out first", () => {
    const sink = disk();
    let now = 1_000;
    const traces = store({ persist: sink.persist, now: () => now, maxAgeMs: 500 });
    traces.record(step({ tabId: "old" }));
    now = 1_400;
    traces.record(step({ tabId: "new" }));
    now = 1_600;
    traces.record(step({ tabId: "new" }));

    expect(traces.tracesOf("session-1").map((trace) => trace.tabId)).toEqual(["new"]);
    expect(sink.traces.size).toBe(1);

    // A relaunch long after pays for the rest.
    const later = new BrowserTraceStore({
      createId: () => "unused",
      now: () => 10_000,
      frameOf,
      persist: sink.persist,
      maxAgeMs: 500,
    });
    expect(later.tracesOf("session-1")).toEqual([]);
    expect(sink.traces.size).toBe(0);
  });

  it("keeps at most the trace bound, newest first, and forgets which trace a swept tab was writing", () => {
    let now = 0;
    const traces = store({ persist: disk().persist, now: () => (now += 10), traceLimit: 2 });
    traces.record(step({ tabId: "a" }));
    traces.record(step({ tabId: "b" }));
    traces.record(step({ tabId: "c" }));
    expect(traces.tracesOf("session-1").map((trace) => trace.tabId)).toEqual(["b", "c"]);

    // Tab `a` writes again: its old trace is gone, so it opens a new one.
    traces.record(step({ tabId: "a" }));
    expect(traces.tracesOf("session-1").map((trace) => trace.tabId)).toEqual(["c", "a"]);
  });

  it("keeps total frames inside the bound by dropping whole older traces, never the newest", () => {
    for (const id of ["f1", "f2", "f3", "f4", "f5"]) live.set(id, jpeg(id, id));
    const sink = disk();
    let now = 0;
    const traces = store({ persist: sink.persist, now: () => (now += 10), frameLimit: 2 });
    traces.record(step({ tabId: "a", pictureId: "f1" }));
    traces.record(step({ tabId: "b", pictureId: "f2" }));
    traces.record(step({ tabId: "c", pictureId: "f3" }));
    expect(traces.tracesOf("session-1").map((trace) => trace.tabId)).toEqual(["b", "c"]);

    // One trace over the bound on its own is still the one being written.
    traces.record(step({ tabId: "c", pictureId: "f4" }));
    traces.record(step({ tabId: "c", pictureId: "f5" }));
    expect(traces.tracesOf("session-1").map((trace) => trace.tabId)).toEqual(["c"]);
    expect([...sink.frames.keys()].toSorted()).toEqual(["f3", "f4", "f5"]);
  });

  it("uses the shipped bounds when none are given", () => {
    const traces = store();
    for (let index = 0; index < 3; index += 1) traces.record(step());
    expect(traces.tracesOf("session-1")[0]?.steps).toHaveLength(3);
  });
});
