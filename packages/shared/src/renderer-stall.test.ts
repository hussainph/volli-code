import { describe, expect, it } from "vite-plus/test";

import {
  INTERACTION_LABELS,
  readInteractionLabel,
  readRendererStall,
  readRendererStallBatch,
  RENDERER_STALL_BOUNDS,
  rendererInputOperation,
  rendererScriptInvoker,
  rendererStallFile,
  rendererStallFunction,
  rendererStallMs,
} from "./renderer-stall";

const FRAME = {
  kind: "frame",
  operation: "long-animation-frame",
  label: "pane-switch",
  durationMs: 240,
  blockingMs: 190,
  renderMs: 30,
  styleLayoutMs: 12,
  scripts: 3,
  script: { file: "chat-plane.tsx", function: "render", invoker: "user-callback", durationMs: 180 },
} as const;

const INPUT = {
  kind: "input",
  operation: "keydown",
  label: "draft-typing",
  durationMs: 136,
  inputDelayMs: 40,
  processingMs: 80,
  presentationMs: 16,
} as const;

describe("the renderer stall vocabulary", () => {
  it("closes every label, operation and invoker", () => {
    expect(INTERACTION_LABELS).toContain("idle");
    expect(readInteractionLabel("pane-switch")).toBe("pane-switch");
    expect(readInteractionLabel("typing my secret")).toBeNull();
    expect(readInteractionLabel(3)).toBeNull();
    expect(rendererInputOperation("keydown")).toBe("keydown");
    expect(rendererInputOperation("gotpointercapture")).toBe("other");
    expect(rendererInputOperation(undefined)).toBe("other");
    expect(rendererScriptInvoker("event-listener")).toBe("event-listener");
    expect(rendererScriptInvoker("something-new")).toBe("other");
  });

  it("rounds and bounds every duration, and refuses what is not one", () => {
    expect(rendererStallMs(12.6)).toBe(13);
    expect(rendererStallMs(-4)).toBe(0);
    expect(rendererStallMs(Number.MAX_SAFE_INTEGER)).toBe(RENDERER_STALL_BOUNDS.maxDurationMs);
    expect(rendererStallMs(Number.NaN)).toBeNull();
    expect(rendererStallMs(Number.POSITIVE_INFINITY)).toBeNull();
    expect(rendererStallMs("12")).toBeNull();
  });

  it("reduces a script URL to its file's base name, never the path", () => {
    expect(
      rendererStallFile(
        "http://localhost:5173/Users/someone/code/src/components/chat-plane.tsx?t=17#x",
      ),
    ).toBe("chat-plane.tsx");
    expect(rendererStallFile("app://volli/assets/index-3f9a.js")).toBe("index-3f9a.js");
    expect(rendererStallFile("")).toBe("no-url");
    expect(rendererStallFile(undefined)).toBe("no-url");
    expect(rendererStallFile("app://volli/assets/")).toBe("unknown");
    expect(rendererStallFile("data:text/javascript,alert(1)")).toBe("unknown");
    expect(rendererStallFile(`app://x/${"a".repeat(RENDERER_STALL_BOUNDS.maxName + 1)}.js`)).toBe(
      "unknown",
    );
  });

  it("keeps a function name only when it reads as an identifier", () => {
    expect(rendererStallFunction("render")).toBe("render");
    expect(rendererStallFunction("Object.flush")).toBe("Object.flush");
    expect(rendererStallFunction("<anonymous>")).toBeUndefined();
    expect(rendererStallFunction("")).toBeUndefined();
    expect(rendererStallFunction("hello world")).toBeUndefined();
    expect(rendererStallFunction("a".repeat(RENDERER_STALL_BOUNDS.maxName + 1))).toBeUndefined();
    expect(rendererStallFunction(7)).toBeUndefined();
  });
});

describe("reading a renderer stall off the wire", () => {
  it("keeps a well-formed frame and input exactly", () => {
    expect(readRendererStall(FRAME)).toEqual(FRAME);
    expect(readRendererStall(INPUT)).toEqual(INPUT);
  });

  it("keeps a frame with none of its optional parts", () => {
    expect(
      readRendererStall({ kind: "frame", operation: "longtask", label: "idle", durationMs: 120 }),
    ).toEqual({ kind: "frame", operation: "longtask", label: "idle", durationMs: 120 });
  });

  it("drops malformed optional parts rather than the frame", () => {
    expect(
      readRendererStall({
        ...FRAME,
        blockingMs: "lots",
        scripts: Number.NaN,
        script: { file: "/Users/me/secret.ts", function: "do it", invoker: "x", durationMs: 9.4 },
      }),
    ).toEqual({
      kind: "frame",
      operation: "long-animation-frame",
      label: "pane-switch",
      durationMs: 240,
      renderMs: 30,
      styleLayoutMs: 12,
      script: { file: "unknown", invoker: "other", durationMs: 9 },
    });
    expect(readRendererStall({ ...FRAME, script: { file: "a.js" } })).not.toHaveProperty("script");
    expect(readRendererStall({ ...FRAME, script: "a.js" })).not.toHaveProperty("script");
  });

  it("names an unforeseen input event other", () => {
    expect(readRendererStall({ ...INPUT, operation: "touchstart" })).toEqual({
      ...INPUT,
      operation: "other",
    });
  });

  it("refuses what is not a stall", () => {
    expect(readRendererStall(null)).toBeNull();
    expect(readRendererStall([FRAME])).toBeNull();
    expect(readRendererStall({ ...FRAME, label: "free text" })).toBeNull();
    expect(readRendererStall({ ...FRAME, durationMs: undefined })).toBeNull();
    expect(readRendererStall({ ...FRAME, operation: "paint" })).toBeNull();
    expect(readRendererStall({ ...FRAME, kind: "paint" })).toBeNull();
    expect(readRendererStall({ ...INPUT, inputDelayMs: null })).toBeNull();
    expect(readRendererStall({ ...INPUT, processingMs: null })).toBeNull();
    expect(readRendererStall({ ...INPUT, presentationMs: null })).toBeNull();
  });
});

describe("reading a renderer stall batch", () => {
  it("keeps its stalls and counts the malformed ones as dropped", () => {
    expect(readRendererStallBatch({ stalls: [FRAME, { kind: "?" }, INPUT], dropped: 2 })).toEqual({
      stalls: [FRAME, INPUT],
      dropped: 3,
    });
  });

  it("keeps at most the bound and counts the rest as dropped", () => {
    const stalls = Array.from({ length: RENDERER_STALL_BOUNDS.maxStalls + 5 }, () => INPUT);
    const batch = readRendererStallBatch({ stalls });
    expect(batch?.stalls).toHaveLength(RENDERER_STALL_BOUNDS.maxStalls);
    expect(batch?.dropped).toBe(5);
  });

  it("bounds a claimed dropped count and defaults a missing one", () => {
    expect(readRendererStallBatch({ stalls: [], dropped: 1e12 })?.dropped).toBe(
      RENDERER_STALL_BOUNDS.maxCount,
    );
    expect(readRendererStallBatch({ stalls: [], dropped: "many" })?.dropped).toBe(0);
  });

  it("refuses what is not a batch", () => {
    expect(readRendererStallBatch(undefined)).toBeNull();
    expect(readRendererStallBatch({ stalls: "x" })).toBeNull();
  });
});
