import { RENDERER_STALL_BOUNDS, type RendererStall, type RendererStallBatch } from "@volli/shared";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createInteractionTimeline,
  createStallBatcher,
  frameEntryType,
  frameStall,
  INTERACTION_TTL_MS,
  inputStall,
  installRendererStallSignals,
  markInteraction,
  holdInteraction,
  slowestPerInteraction,
  STALL_FLUSH_MS,
  type EventEntryLike,
  type FrameEntryLike,
  type ObserverHost,
} from "./renderer-stalls";

function clock(start = 1000) {
  let at = start;
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

describe("the interaction timeline", () => {
  it("labels a stall idle when no interaction claims it", () => {
    const timeline = createInteractionTimeline({ now: () => 0 });
    expect(timeline.labelFor(0, 200)).toBe("idle");
  });

  it("labels a stall with the mark made during it, though delivered after", () => {
    const time = clock();
    const timeline = createInteractionTimeline({ now: time.now });
    // A click at 1000 runs its handler at 1040, which marks the switch.
    time.advance(40);
    timeline.mark("pane-switch");
    time.advance(500);
    // The observer delivers the frame [1000, 1300] later still.
    expect(timeline.labelFor(1000, 1300)).toBe("pane-switch");
  });

  it("lets a mark claim stalls for its ttl, and no longer", () => {
    const time = clock();
    const timeline = createInteractionTimeline({ now: time.now });
    timeline.mark("ticket-open");
    expect(timeline.labelFor(1000 + INTERACTION_TTL_MS, 1100 + INTERACTION_TTL_MS)).toBe(
      "ticket-open",
    );
    expect(timeline.labelFor(1001 + INTERACTION_TTL_MS, 1100 + INTERACTION_TTL_MS)).toBe("idle");
    // Nor a frame that ended before the mark.
    expect(timeline.labelFor(800, 999)).toBe("idle");
  });

  it("gives an overlapping stall the newest mark", () => {
    const time = clock();
    const timeline = createInteractionTimeline({ now: time.now });
    timeline.mark("workspace-switch");
    time.advance(100);
    timeline.mark("pane-switch");
    expect(timeline.labelFor(1050, 1200)).toBe("pane-switch");
    expect(timeline.labelFor(1000, 1050)).toBe("workspace-switch");
  });

  it("stretches one span across a run of keystrokes rather than flooding its memory", () => {
    const time = clock();
    const timeline = createInteractionTimeline({ now: time.now });
    timeline.mark("draft-typing");
    for (let key = 0; key < 100; key += 1) {
      time.advance(150);
      timeline.mark("draft-typing");
    }
    // The run started at 1000 and is still one span: a frame early in it keeps its label.
    expect(timeline.labelFor(1100, 1200)).toBe("draft-typing");
    expect(timeline.labelFor(time.now(), time.now() + 50)).toBe("draft-typing");
  });

  it("forgets the oldest marks past its capacity", () => {
    const time = clock();
    const timeline = createInteractionTimeline({ now: time.now, ttlMs: 10 });
    timeline.mark("send");
    for (let index = 0; index < 40; index += 1) {
      time.advance(100);
      timeline.mark(index % 2 === 0 ? "pane-switch" : "ticket-open");
    }
    expect(timeline.labelFor(1000, 1005)).toBe("idle");
  });

  it("labels a stall with a held interaction, after any mark", () => {
    const time = clock();
    const timeline = createInteractionTimeline({ now: time.now });
    const release = timeline.hold("stream");
    time.advance(5000);
    expect(timeline.labelFor(5000, 5200)).toBe("stream");
    timeline.mark("draft-typing");
    expect(timeline.labelFor(6000, 6100)).toBe("draft-typing");
    time.advance(2000);
    release();
    release();
    expect(timeline.labelFor(7900, 7950)).toBe("stream");
    expect(timeline.labelFor(8100, 8200)).toBe("idle");
  });

  it("forgets a released hold after a minute", () => {
    const time = clock();
    const timeline = createInteractionTimeline({ now: time.now });
    timeline.hold("stream")();
    time.advance(61_000);
    timeline.hold("stream")();
    expect(timeline.labelFor(1000, 1000)).toBe("idle");
  });

  it("serves the window's own timeline through markInteraction and holdInteraction", () => {
    expect(() => {
      markInteraction("board-return");
      holdInteraction("stream")();
    }).not.toThrow();
  });
});

const LOAF: FrameEntryLike = {
  entryType: "long-animation-frame",
  startTime: 1000,
  duration: 240.4,
  blockingDuration: 190.2,
  renderStart: 1200,
  styleAndLayoutStart: 1220,
  scripts: [
    { duration: 30, sourceURL: "app://volli/assets/a.js", invokerType: "event-listener" },
    {
      duration: 160,
      sourceURL: "http://localhost:5173/Users/me/src/components/chat/chat-plane.tsx?t=1",
      sourceFunctionName: "ChatPlaneContent",
      invokerType: "user-callback",
    },
    { duration: 10, sourceURL: "app://volli/assets/b.js", invokerType: "resolve-promise" },
  ],
};

describe("entries as stalls", () => {
  it("keeps a long frame's parts and its longest script as file and function", () => {
    expect(frameStall(LOAF, "pane-switch")).toEqual({
      kind: "frame",
      operation: "long-animation-frame",
      label: "pane-switch",
      durationMs: 240,
      blockingMs: 190,
      renderMs: 40,
      styleLayoutMs: 20,
      scripts: 3,
      script: {
        file: "chat-plane.tsx",
        function: "ChatPlaneContent",
        invoker: "user-callback",
        durationMs: 160,
      },
    });
  });

  it("keeps a frame with no script attribution, and a longtask, as frames", () => {
    expect(
      frameStall(
        {
          entryType: "long-animation-frame",
          startTime: 0,
          duration: 120,
          renderStart: 0,
          scripts: [],
        },
        "idle",
      ),
    ).toEqual({
      kind: "frame",
      operation: "long-animation-frame",
      label: "idle",
      durationMs: 120,
    });
    expect(frameStall({ entryType: "longtask", startTime: 0, duration: 150 }, "send")).toEqual({
      kind: "frame",
      operation: "longtask",
      label: "send",
      durationMs: 150,
    });
  });

  it("drops a script's unreadable function name and keeps its file", () => {
    const stall = frameStall(
      { ...LOAF, scripts: [{ duration: 120, sourceURL: "", sourceFunctionName: "" }] },
      "idle",
    );
    expect(stall.script).toEqual({ file: "no-url", invoker: "other", durationMs: 120 });
  });

  it("splits a slow input into its delay, handlers and paint", () => {
    const entry: EventEntryLike = {
      name: "keydown",
      startTime: 1000,
      duration: 136,
      processingStart: 1040,
      processingEnd: 1120,
      interactionId: 7,
    };
    expect(inputStall(entry, "draft-typing")).toEqual({
      kind: "input",
      operation: "keydown",
      label: "draft-typing",
      durationMs: 136,
      inputDelayMs: 40,
      processingMs: 80,
      presentationMs: 16,
    });
    expect(inputStall({ ...entry, name: "touchstart" }, "idle").operation).toBe("other");
    // A timestamp the browser could not give reads as zero, never as NaN on the wire.
    expect(inputStall({ ...entry, processingStart: Number.NaN }, "idle")).toMatchObject({
      inputDelayMs: 0,
      processingMs: 0,
    });
  });

  it("keeps the slowest event of each interaction and drops the ones outside any", () => {
    const at = { startTime: 0, processingStart: 0, processingEnd: 0 };
    const kept = slowestPerInteraction(
      [
        { ...at, name: "keydown", duration: 120, interactionId: 3 },
        { ...at, name: "keypress", duration: 180, interactionId: 3 },
        { ...at, name: "keyup", duration: 110, interactionId: 3 },
        { ...at, name: "pointerover", duration: 300, interactionId: 0 },
        { ...at, name: "click", duration: 40, interactionId: 4 },
        { ...at, name: "click", duration: 200 },
      ],
      100,
    );
    expect(kept.map((entry) => `${entry.name}:${entry.duration}`)).toEqual([
      "keypress:180",
      "click:200",
    ]);
  });

  it("observes LoAF where the build has it, else longtask, else nothing", () => {
    expect(frameEntryType(["longtask", "long-animation-frame"])).toBe("long-animation-frame");
    expect(frameEntryType(["longtask"])).toBe("longtask");
    expect(frameEntryType(["event"])).toBeNull();
  });
});

const INPUT: RendererStall = {
  kind: "input",
  operation: "click",
  label: "idle",
  durationMs: 120,
  inputDelayMs: 0,
  processingMs: 100,
  presentationMs: 20,
};

function manualTimer() {
  const pending: { run: () => void; ms: number }[] = [];
  return {
    pending,
    setTimer: (run: () => void, ms: number) => {
      const timer = { run, ms };
      pending.push(timer);
      return timer;
    },
    clearTimer: (timer: unknown) => {
      const index = pending.indexOf(timer as (typeof pending)[number]);
      if (index >= 0) pending.splice(index, 1);
    },
    fire: () => pending.shift()?.run(),
  };
}

describe("the stall batcher", () => {
  it("sends the stalls of one interval as one batch, the first stall arming it", () => {
    const sent: RendererStallBatch[] = [];
    const timer = manualTimer();
    const batcher = createStallBatcher({ send: (batch) => sent.push(batch), ...timer });
    batcher.push(INPUT);
    batcher.push(INPUT);
    expect(timer.pending.map((each) => each.ms)).toEqual([STALL_FLUSH_MS]);
    expect(sent).toEqual([]);
    timer.fire();
    expect(sent).toEqual([{ stalls: [INPUT, INPUT], dropped: 0 }]);
    // Nothing queued: nothing armed, nothing sent.
    batcher.flush();
    expect(sent).toHaveLength(1);
    expect(timer.pending).toEqual([]);
  });

  it("counts what overflows a batch and says so in it", () => {
    const sent: RendererStallBatch[] = [];
    const timer = manualTimer();
    const batcher = createStallBatcher({ send: (batch) => sent.push(batch), ...timer });
    for (let index = 0; index < RENDERER_STALL_BOUNDS.maxStalls + 3; index += 1)
      batcher.push(INPUT);
    timer.fire();
    expect(sent[0]?.stalls).toHaveLength(RENDERER_STALL_BOUNDS.maxStalls);
    expect(sent[0]?.dropped).toBe(3);
  });

  it("sends at once on flush, cancelling the pending send", () => {
    const sent: RendererStallBatch[] = [];
    const timer = manualTimer();
    const batcher = createStallBatcher({ send: (batch) => sent.push(batch), ...timer });
    batcher.push(INPUT);
    batcher.flush();
    expect(sent).toHaveLength(1);
    expect(timer.pending).toEqual([]);
  });

  it("never throws when the door does", () => {
    const timer = manualTimer();
    const batcher = createStallBatcher({
      send: () => {
        throw new Error("window closing");
      },
      ...timer,
    });
    batcher.push(INPUT);
    expect(() => timer.fire()).not.toThrow();
  });

  it("arms a real timer by default", () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn();
      const batcher = createStallBatcher({ send });
      batcher.push(INPUT);
      vi.advanceTimersByTime(STALL_FLUSH_MS);
      expect(send).toHaveBeenCalledTimes(1);
      batcher.push(INPUT);
      batcher.flush();
      expect(send).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

/** A `PerformanceObserver` stand-in whose deliveries a test makes. */
function fakeObserver(supportedEntryTypes: readonly string[]) {
  const live: { type: string; options: unknown; deliver: (entries: unknown[]) => void }[] = [];
  let disconnected = 0;
  class FakeObserver {
    static readonly supportedEntryTypes = supportedEntryTypes;
    constructor(private readonly callback: (list: { getEntries(): readonly unknown[] }) => void) {}
    observe(options: { type: string }) {
      live.push({
        type: options.type,
        options,
        deliver: (entries) => this.callback({ getEntries: () => entries }),
      });
    }
    disconnect() {
      disconnected += 1;
    }
  }
  return {
    host: FakeObserver as unknown as ObserverHost,
    live,
    deliver: (type: string, entries: unknown[]) =>
      live.find((each) => each.type === type)?.deliver(entries),
    disconnected: () => disconnected,
  };
}

describe("installing the stall signals", () => {
  function install(supported: readonly string[]) {
    const observer = fakeObserver(supported);
    const time = clock(0);
    const timeline = createInteractionTimeline({ now: time.now });
    const sent: RendererStallBatch[] = [];
    const undo = installRendererStallSignals({
      observer: observer.host,
      door: () => (batch) => sent.push(batch),
      timeline,
      batcher: (send) => createStallBatcher({ send, setTimer: () => 1, clearTimer: () => {} }),
    });
    return { observer, timeline, time, sent, undo };
  }

  it("labels long frames and slow inputs, ignores short ones, and sends them on undo", () => {
    const { observer, timeline, time, sent, undo } = install(["long-animation-frame", "event"]);
    expect(observer.live.map((each) => each.options)).toEqual([
      { type: "long-animation-frame", buffered: false },
      { type: "event", buffered: false, durationThreshold: 100 },
    ]);
    time.advance(1010);
    timeline.mark("pane-switch");
    observer.deliver("long-animation-frame", [
      { entryType: "long-animation-frame", startTime: 1000, duration: 60 },
      { entryType: "long-animation-frame", startTime: 1000, duration: 220 },
    ]);
    observer.deliver("event", [
      {
        name: "keydown",
        startTime: 5000,
        duration: 140,
        processingStart: 5010,
        processingEnd: 5100,
        interactionId: 9,
      },
    ]);
    undo();
    expect(observer.disconnected()).toBe(2);
    expect(sent).toEqual([
      {
        stalls: [
          {
            kind: "frame",
            operation: "long-animation-frame",
            label: "pane-switch",
            durationMs: 220,
          },
          {
            kind: "input",
            operation: "keydown",
            label: "idle",
            durationMs: 140,
            inputDelayMs: 10,
            processingMs: 90,
            presentationMs: 40,
          },
        ],
        dropped: 0,
      },
    ]);
  });

  it("falls back to longtask where LoAF is missing", () => {
    const { observer } = install(["longtask"]);
    expect(observer.live.map((each) => each.type)).toEqual(["longtask"]);
  });

  it("does nothing without an observer or a door", () => {
    expect(installRendererStallSignals({ door: () => null })).toBeTypeOf("function");
    const observer = fakeObserver(["event"]);
    installRendererStallSignals({ observer: observer.host, door: () => null })();
    expect(observer.live).toEqual([]);
    // The page's own window, which has no preload door here.
    installRendererStallSignals({ observer: observer.host })();
    expect(observer.live).toEqual([]);
  });

  it("uses the page's observer and the window's door by default", () => {
    const observer = fakeObserver(["event"]);
    const stalls = vi.fn();
    vi.stubGlobal("PerformanceObserver", observer.host);
    vi.stubGlobal("window", { api: { log: { stalls } } });
    try {
      const undo = installRendererStallSignals();
      expect(observer.live.map((each) => each.type)).toEqual(["event"]);
      undo();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
