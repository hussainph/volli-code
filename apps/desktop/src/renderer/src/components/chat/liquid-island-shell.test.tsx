// @vitest-environment jsdom
/**
 * The bead's drawn width against the caption it carries (VC-1198).
 *
 * jsdom has no layout, so the text is given a deterministic monospace width
 * and the animation clock is driven by hand. What is under test is the
 * contract between measurement and drawing: once the springs settle, every
 * caption fits inside the bead that carries it.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MotionGlobalConfig } from "motion/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { IslandFlash } from "@volli/session-presentation";

import type { TurnActivity } from "@renderer/chat/turn-activity";
import { LiquidIslandShell } from "./liquid-island-shell";

const CHAR = 7;
let root: Root | null = null;
let container: HTMLElement | null = null;
let now = 0;
let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;
let clusterWidth = 65;
let laidOut = true;

function textWidth(node: Element): number {
  return (node.textContent ?? "").length * CHAR;
}

beforeEach(() => {
  MotionGlobalConfig.skipAnimations = true;
  now = 0;
  frames = new Map();
  nextFrame = 1;
  clusterWidth = 65;
  laidOut = true;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextFrame++;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.classList.contains("liquid-island-measure") && laidOut ? textWidth(this) : 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
    function (this: HTMLElement) {
      return (laidOut ? [{}] : []) as unknown as DOMRectList;
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const width = this.classList.contains("liquid-island-measure")
        ? this.offsetWidth
        : this.classList.contains("liquid-island-clusters") && this.childElementCount > 0
          ? clusterWidth
          : 0;
      return {
        width,
        height: 20,
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: width,
        bottom: 20,
      } as DOMRect;
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  MotionGlobalConfig.skipAnimations = false;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function step(ms: number) {
  const end = now + ms;
  while (now < end) {
    now += 16;
    const due = [...frames.values()];
    frames.clear();
    act(() => {
      vi.advanceTimersByTime(16);
      for (const callback of due) callback(now);
    });
  }
}

function running(word: string, payload: string | null, key = "call-1"): TurnActivity {
  return {
    key,
    activity: "run",
    word,
    payload,
    waiting: false,
    announcement: `Running ${payload ?? ""}`,
  };
}

function render(
  activity: TurnActivity | null,
  {
    flash = null,
    populated = true,
    reduce = false,
  }: { flash?: IslandFlash | null; populated?: boolean; reduce?: boolean } = {},
) {
  act(() =>
    root!.render(
      <LiquidIslandShell
        activity={activity}
        flash={flash}
        populated={populated}
        exitKind="done"
        reduce={reduce}
      >
        {populated ? <span>0/5</span> : null}
      </LiquidIslandShell>,
    ),
  );
}

function label() {
  return container!.querySelector<HTMLElement>(".liquid-island-label")!;
}

/** The caption as drawn, its text width, and the bead under it. */
function picture() {
  const node = label();
  return {
    text: node.textContent ?? "",
    textWidth: textWidth(node),
    bead: Number.parseFloat(node.style.width),
    opacity: Number(node.style.opacity),
  };
}

function expectFits() {
  const drawn = picture();
  if (drawn.opacity > 0) expect(drawn.textWidth).toBeLessThanOrEqual(drawn.bead);
  return drawn;
}

const LONG =
  "cat > /tmp/vc1198-probe.sh <<'EOF2' echo probe EOF2 for i in 1 2 3; do sleep 2; ls /tmp | tail -1; done";

/** A settled caption: fully shown, inside its bead. */
function expectSettled(text?: string) {
  const drawn = expectFits();
  expect(drawn.opacity).toBeGreaterThan(0.99);
  if (text !== undefined) expect(drawn.text).toBe(text);
  return drawn;
}

describe("LiquidIslandShell caption fit", () => {
  it("draws the bead around a long, truncated payload", () => {
    render(running("Running", LONG));
    step(2000);
    const drawn = expectSettled();
    expect(drawn.text).toContain("…");
    expect(drawn.textWidth).toBeLessThanOrEqual(226);
  });

  it("grows when the payload arrives under the same verb", () => {
    render(running("Running", null));
    step(2000);
    render(running("Running", LONG));
    step(2000);
    expect(expectSettled().text).toContain("tail -1; done");
  });

  it("follows a payload that changes under the same key and verb", () => {
    render(running("Running", "ls"));
    step(2000);
    render(running("Running", LONG));
    step(2000);
    expectSettled();
    render(running("Running", "pwd"));
    step(2000);
    expectSettled("Running pwd");
  });

  it("follows the escalated verb under the same key", () => {
    render(running("Running", "ls"));
    step(2000);
    render(running("Still running", LONG));
    step(2000);
    expect(expectSettled().text).toMatch(/^Still running cat/u);
  });

  it("fits a flash and the verb it returns to", () => {
    render(running("Running", "ls"));
    step(2000);
    render(running("Running", "ls"), {
      flash: { id: "f1", event: "Opened", payload: "github.com/hussainph/volli/pull/1249" },
    });
    step(2000);
    expect(expectSettled().text).toMatch(/^Opened · github\.c.*1249$/u);
    render(running("Running", "ls"));
    step(2000);
    expectSettled("Running ls");
  });

  it("never freezes on a caption when the verb changes right after a swap", () => {
    // The field failure: verbs churning faster than the crossfade. The caption
    // must end on the newest words, however the changes interleave.
    render(running("On it", null, "busy"));
    step(500);
    const churn: TurnActivity[] = [
      running("Executing", "todo_write", "plan"),
      running("On it", null, "busy"),
      running("Wording", null, "reply"),
      running("Firing off", "sleep 1", "call-2"),
    ];
    for (const [index, next] of churn.entries()) {
      render(next);
      step(index % 2 === 0 ? 16 : 144);
    }
    render(running("Running", LONG, "call-3"));
    step(2000);
    expect(expectSettled().text).toMatch(/^Running cat/u);
  });

  it("fits as a standalone pill and across narrow and wide clusters", () => {
    render(running("Running", LONG), { populated: false });
    step(2000);
    expectSettled();
    clusterWidth = 30;
    render(running("Running", LONG));
    step(2000);
    expectSettled();
    clusterWidth = 400;
    render(running("Running", LONG));
    step(2000);
    expectSettled();
  });

  it("fits under reduced motion, including a wide caption giving way to a narrow one", () => {
    render(running("Running", null), { reduce: true });
    step(100);
    render(running("Running", LONG), { reduce: true });
    step(100);
    expectSettled();
    render(running("Reading", "a.ts", "call-2"), { reduce: true });
    for (let i = 0; i < 20; i++) {
      step(16);
      expectFits();
    }
    expectSettled("Reading a.ts");
  });

  it("measures again once a hidden pane is laid out", () => {
    const observers: Array<() => void> = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          observers.push(callback);
        }
        observe() {}
        disconnect() {}
      },
    );
    laidOut = false;
    render(running("Running", LONG));
    step(500);
    laidOut = true;
    act(() => {
      for (const callback of observers) callback();
    });
    step(2000);
    expect(expectSettled().text).toContain("…");
  });

  it("gates a wider payload at commit, before the next frame draws", () => {
    render(running("Running", null));
    step(2000);
    render(running("Running", LONG));
    const drawn = picture();
    expect(drawn.text).toContain("tail -1; done");
    expect(drawn.opacity).toBe(0);
  });

  it("requests no frame once settled, nor for a re-render with the same words", () => {
    render(running("Running", LONG));
    step(2000);
    expect(frames.size).toBe(0);
    // A streamed chunk: a new activity object carrying the same words.
    render(running("Running", LONG));
    render({ ...running("Running", LONG), announcement: "Running something else" });
    expect(frames.size).toBe(0);
    render(running("Running", "pwd"));
    expect(frames.size).toBe(1);
  });

  it("never shows a caption wider than the bead while it moves", () => {
    render(running("Running", null));
    step(2000);
    render(running("Running", LONG));
    for (let i = 0; i < 120; i++) {
      step(16);
      expectFits();
    }
    render(running("Reading", "a.ts", "call-2"));
    for (let i = 0; i < 120; i++) {
      step(16);
      expectFits();
    }
  });
});
