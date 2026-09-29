// @vitest-environment jsdom
/**
 * The Browser replay (VC-453): opens a Session's traces at the step it was
 * asked for, steps with buttons, keys and the scrub track, shows each frame's
 * action, target, page and time, follows a growing trace, and says so when
 * nothing was recorded or the read failed.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  appendBrowserTraceStep,
  newBrowserTrace,
  type BrowserTrace,
  type BrowserTraceStep,
} from "@volli/shared";

import type { BrowserApi } from "./browser-api";
import { BrowserTraceDialog } from "./browser-trace-dialog";
import type { BrowserTraceRequest } from "./browser-trace-model";
import { forgetBrowserPictures } from "./browser-tab-card";

vi.mock("@renderer/lib/toast", () => ({ toastError: vi.fn() }));
import { toastError } from "@renderer/lib/toast";

type StepInput = Omit<BrowserTraceStep, "seq">;

function step(over: Partial<StepInput> = {}): StepInput {
  return {
    action: "click",
    target: "Save",
    url: "https://example.com/form",
    title: "Form",
    generation: 1,
    at: 1_000,
    outcome: "ok",
    rule: null,
    error: null,
    pictureId: null,
    ...over,
  };
}

function trace(tabId: string, steps: StepInput[], traceId = `trace-${tabId}`): BrowserTrace {
  return steps.reduce(
    (built, one) => appendBrowserTraceStep(built, one).trace,
    newBrowserTrace({ traceId, sessionId: "s1", tabId, startedAt: 0 }),
  );
}

const THREE = trace("tab-1", [
  step({ action: "open", target: null, at: 1_000, pictureId: "p-1" }),
  step({ at: 3_000, pictureId: "p-2" }),
  step({ at: 5_000, outcome: "refused", rule: "browser.stale-ref", target: "e4", pictureId: null }),
]);

function api(traces: () => BrowserTrace[] | Error): BrowserApi {
  return {
    traces: vi.fn(async () => {
      const answer = traces();
      if (answer instanceof Error) throw answer;
      return { ok: true, traces: answer } as const;
    }),
    picture: vi.fn(async ({ pictureId }: { pictureId: string }) =>
      pictureId === "p-gone"
        ? ({ ok: true, dataUrl: null } as const)
        : ({ ok: true, dataUrl: `data:image/jpeg;base64,${btoa(pictureId)}` } as const),
    ),
  } as unknown as BrowserApi;
}

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(toastError).mockClear();
  forgetBrowserPictures();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function open(
  bridge: BrowserApi,
  request: BrowserTraceRequest | null = { sessionId: "s1", tabId: null, pictureId: null },
  onClose = vi.fn(),
  refreshMs = 60_000,
) {
  await act(async () => {
    root?.render(
      <BrowserTraceDialog request={request} api={bridge} onClose={onClose} refreshMs={refreshMs} />,
    );
  });
  // Let the trace read and the frame read both land.
  await act(async () => {});
  await act(async () => {});
  return { onClose };
}

const dialog = () => document.querySelector<HTMLElement>("[data-browser-trace-dialog]");
const text = () => dialog()?.textContent ?? "";
const position = () => document.querySelector("[data-trace-position]")?.textContent ?? "";
const caption = () => document.querySelector("[data-trace-caption]")?.textContent ?? "";
const frame = () => document.querySelector("[data-trace-frame]")?.getAttribute("data-trace-frame");
const button = (label: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const track = () => document.querySelector<HTMLElement>("[data-trace-scrub]")!;

async function press(key: string, extra: KeyboardEventInit = {}) {
  await act(async () => {
    track().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...extra }));
  });
  await act(async () => {});
}

async function click(target: HTMLElement) {
  await act(async () => target.click());
  await act(async () => {});
}

describe("BrowserTraceDialog", () => {
  it("draws nothing while closed, and reads nothing", async () => {
    const bridge = api(() => [THREE]);
    await open(bridge, null);
    expect(dialog()).toBeNull();
    expect(bridge.traces).not.toHaveBeenCalled();
  });

  it("opens at the Session's latest step, with its action, target, page, time and rule", async () => {
    const bridge = api(() => [THREE]);
    await open(bridge);

    expect(bridge.traces).toHaveBeenCalledWith({ sessionId: "s1" });
    expect(position()).toBe("Step 3 of 3");
    expect(caption()).toBe("Clicked e4");
    expect(text()).toContain("refused by browser.stale-ref");
    expect(text()).toContain("Form");
    expect(text()).toContain("example.com/form");
    expect(text()).toContain("+4s");
    // A refusal changed nothing and took no picture: the tab as its last step left it.
    await act(async () => {});
    expect(frame()).toBe("p-2");
    expect(text()).toContain("As of step 2");
    expect(document.querySelector("[data-trace-outcome]")?.getAttribute("data-trace-outcome")).toBe(
      "refused",
    );
  });

  it("opens at the frame the card showed, and shows it", async () => {
    await open(
      api(() => [THREE]),
      { sessionId: "s1", tabId: "tab-1", pictureId: "p-2" },
    );

    expect(position()).toBe("Step 2 of 3");
    expect(caption()).toBe("Clicked “Save”");
    expect(frame()).toBe("p-2");
  });

  it("steps with Previous and Next, and stops at either end", async () => {
    await open(
      api(() => [THREE]),
      { sessionId: "s1", tabId: null, pictureId: "p-1" },
    );

    expect(caption()).toBe("Opened");
    expect(button("Previous step").disabled).toBe(true);
    await click(button("Next step"));
    expect(position()).toBe("Step 2 of 3");
    await click(button("Next step"));
    expect(button("Next step").disabled).toBe(true);
    await click(button("Previous step"));
    expect(position()).toBe("Step 2 of 3");
  });

  it("steps and jumps with the keyboard, and leaves modified keys alone", async () => {
    await open(api(() => [THREE]));

    await press("Home");
    expect(position()).toBe("Step 1 of 3");
    await press("ArrowRight");
    expect(position()).toBe("Step 2 of 3");
    await press("End");
    expect(position()).toBe("Step 3 of 3");
    await press("ArrowLeft", { metaKey: true });
    expect(position()).toBe("Step 3 of 3");
    await press("x");
    expect(position()).toBe("Step 3 of 3");
  });

  it("scrubs to the step under the pointer, and keeps scrubbing while it is held", async () => {
    await open(api(() => [THREE]));
    const scrub = track();
    scrub.getBoundingClientRect = () => ({ left: 100, width: 300 }) as DOMRect;
    let captured = false;
    scrub.setPointerCapture = () => {
      captured = true;
    };
    scrub.hasPointerCapture = () => captured;
    const pointer = (type: string, clientX: number) =>
      act(async () => {
        const event = new MouseEvent(type, { bubbles: true, clientX });
        Object.defineProperty(event, "pointerId", { value: 1 });
        scrub.dispatchEvent(event);
      });

    await pointer("pointermove", 120);
    expect(position()).toBe("Step 3 of 3");
    await pointer("pointerdown", 120);
    expect(position()).toBe("Step 1 of 3");
    await pointer("pointermove", 250);
    expect(position()).toBe("Step 2 of 3");
    expect(scrub.getAttribute("aria-valuenow")).toBe("2");
    expect(scrub.getAttribute("aria-valuetext")).toBe("Step 2 of 3: Clicked");
  });

  it("names the tab each step ran in once the replay spans two, and says when earlier steps were let go", async () => {
    const second = trace("tab-2", [step({ at: 2_000, pictureId: "p-gone" })]);
    const bounded: BrowserTrace = { ...THREE, droppedSteps: 4 };
    await open(
      api(() => [bounded, second]),
      { sessionId: "s1", tabId: "tab-2", pictureId: null },
    );

    expect(position()).toBe("Step 2 of 4 · earlier steps not kept");
    expect(text()).toContain("Tab 2");
    expect(text()).toContain("Picture unavailable");
  });

  it("follows a growing trace while the person watches its newest step, and not once they scrub back", async () => {
    vi.useFakeTimers();
    let current: BrowserTrace[] = [THREE];
    await open(
      api(() => current),
      undefined,
      undefined,
      1_000,
    );
    expect(position()).toBe("Step 3 of 3");

    current = [
      trace("tab-1", [step(), step(), step(), step({ action: "press", target: "Enter" })]),
    ];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(position()).toBe("Step 4 of 4");
    expect(caption()).toBe("Pressed Enter");

    await press("Home");
    current = [trace("tab-1", [step(), step(), step(), step(), step()])];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(position()).toBe("Step 1 of 5");

    // The same trace again changes nothing, and a failed refresh keeps what is on screen.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    current = new Error("bridge hiccup") as unknown as BrowserTrace[];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(position()).toBe("Step 1 of 5");
    expect(warn).toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("says so when a tab has no picture yet", async () => {
    await open(api(() => [trace("tab-1", [step({ action: "read", target: null })])]));
    expect(caption()).toBe("Read page");
    expect(text()).toContain("No picture for this step");
  });

  it("says when nothing was recorded", async () => {
    await open(api(() => []));
    expect(document.querySelector("[data-trace-empty]")?.textContent).toBe(
      "Nothing recorded for this Session",
    );
    expect(position()).toBe("");
  });

  it("toasts a first read that failed, whether it threw or answered a refusal", async () => {
    await open(api(() => new Error("bridge went away")));
    expect(toastError).toHaveBeenCalledWith("Could not load the Browser replay: bridge went away");
    expect(document.querySelector("[data-trace-empty]")).not.toBeNull();

    const refusing = {
      traces: vi.fn(async () => ({ ok: false, error: "Invalid Browser Trace request" }) as const),
      picture: vi.fn(),
    } as unknown as BrowserApi;
    await open(refusing, { sessionId: "s2", tabId: null, pictureId: null });
    expect(toastError).toHaveBeenLastCalledWith(
      "Could not load the Browser replay: Invalid Browser Trace request",
    );
  });

  it("closes through the door it was handed", async () => {
    const { onClose } = await open(api(() => [THREE]));
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).toHaveBeenCalled();
  });
});
