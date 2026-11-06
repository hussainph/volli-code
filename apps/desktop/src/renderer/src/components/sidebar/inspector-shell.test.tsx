// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { InspectorShell } from "./inspector-shell";
import { InspectorHostContext } from "./inspector-host";
import { EXIT_GRACE_MS } from "./edge-reveal";
import { useUiStore } from "@renderer/stores/ui";

const preferences = vi.hoisted(() => ({ reduced: false }));
vi.mock("@renderer/hooks/use-reduced-motion", () => ({
  useReducedMotion: () => preferences.reduced,
  prefersReducedMotion: () => preferences.reduced,
}));
vi.mock("@renderer/components/browser/browser-plane-freeze", () => ({
  hasVisibleNativePlane: () => false,
}));
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let panel: HTMLDivElement;
let button: HTMLButtonElement;
const cancel = vi.fn();
const animate = vi.fn(() => ({ cancel, onfinish: null }));
function Harness({ owner = "home" }: { owner?: "home" | "ticket" }) {
  return (
    <>
      <div data-slot="chrome-bar" />
      <button
        data-inspector-trigger={owner}
        onClick={() => useUiStore.getState().toggleRailCollapsed()}
      >
        Details
      </button>
      <div data-reading-plane="" />
      <InspectorShell enabled owner={owner}>
        <div data-live-child="">Resident page</div>
      </InspectorShell>
    </>
  );
}
async function move(x: number, y: number, elapsed = 0) {
  await act(async () => {
    const event = new Event("pointermove");
    Object.assign(event, { pointerType: "mouse", clientX: x, clientY: y });
    window.dispatchEvent(event);
    vi.advanceTimersByTime(elapsed + 1);
  });
}
async function click(detail: number) {
  await act(async () => button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail })));
}
beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) =>
    window.setTimeout(() => fn(0), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  preferences.reduced = false;
  useUiStore.setState({ railCollapsed: false, railWidth: 300 });
  animate.mockClear();
  cancel.mockClear();
  Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  Reflect.deleteProperty(HTMLElement.prototype, "animate");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function setup(owner: "home" | "ticket") {
  await act(async () => root.render(<Harness owner={owner} />));
  panel = host.querySelector("[data-inspector-panel]")!;
  button = host.querySelector("button")!;
  Object.defineProperties(panel, {
    offsetParent: { get: () => panel.parentElement },
    offsetWidth: { value: 300 },
    offsetLeft: { value: 0 },
    offsetTop: { value: 0 },
    animate: { value: animate },
  });
  vi.spyOn(panel, "getBoundingClientRect").mockReturnValue(new DOMRect(700, 36, 300, 700));
  vi.spyOn(panel.parentElement!, "getBoundingClientRect").mockReturnValue(
    new DOMRect(700, 36, 300, 700),
  );
  vi.spyOn(button, "getBoundingClientRect").mockReturnValue(new DOMRect(970, 6, 28, 28));
  vi.spyOn(
    host.querySelector('[data-slot="chrome-bar"]')!,
    "getBoundingClientRect",
  ).mockReturnValue(new DOMRect(0, 0, 1000, 36));
  vi.spyOn(panel.parentElement!.lastElementChild!, "getBoundingClientRect").mockReturnValue(
    new DOMRect(992, 60, 8, 700),
  );
}
describe("resident inspector", () => {
  for (const owner of ["home", "ticket"] as const) {
    it(`${owner}: mirrors pointer push, dwell, suppression and pin without remounting its page`, async () => {
      await setup(owner);
      const child = host.querySelector("[data-live-child]");
      await click(1);
      expect(panel.getAttribute("aria-hidden")).toBe("true");
      expect(panel.hasAttribute("data-pane-withdrawn")).toBe(true);
      expect(panel.parentElement!.style.width).toBe("var(--right-pane-push, 0px)");
      expect(animate).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ duration: 270 }),
      );
      expect(animate).toHaveBeenCalledTimes(1);
      expect(document.querySelector("[data-pane-pour-shell]")).toBeNull();
      expect(panel.dataset.glassBlur).toBeUndefined();
      expect(button.dataset.panePouring).toBeUndefined();
      // Settle via the same preference gate used when Motion is turned off live.
      preferences.reduced = true;
      await act(async () => root.render(<Harness owner={owner} />));
      preferences.reduced = false;
      await act(async () => root.render(<Harness owner={owner} />));
      await move(980, 18, 200);
      expect(panel.getAttribute("aria-hidden")).toBe("true");
      await move(500, 300);
      await move(980, 18, 138);
      expect(panel.getAttribute("aria-hidden")).toBe("true");
      await move(980, 18, 2);
      expect(panel.getAttribute("aria-hidden")).toBeNull();
      expect(panel.hasAttribute("data-pane-withdrawn")).toBe(false);
      expect(panel.style.getPropertyValue("--reveal-duration")).not.toBe("0ms");
      await click(1);
      expect(panel.parentElement!.style.width).toBe("var(--right-pane-push, 0px)");
      expect(host.querySelector("[data-live-child]")).toBe(child);
    });
  }
  it("keyboard toggles and Escape are immediate and never pour", async () => {
    await setup("home");
    await click(0);
    expect(animate).not.toHaveBeenCalled();
    expect(panel.style.getPropertyValue("--reveal-duration")).toBe("0ms");
    vi.advanceTimersByTime(300);
    await move(500, 300);
    await move(996, 200, 140);
    expect(panel.getAttribute("aria-hidden")).toBeNull();
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(panel.getAttribute("aria-hidden")).toBe("true");
    expect(panel.style.getPropertyValue("--reveal-duration")).toBe("0ms");
    expect(animate).not.toHaveBeenCalled();
  });
  it("withdraws the peek after pointer departure but preserves the selected page", async () => {
    await setup("home");
    await click(0);
    await move(500, 300);
    await move(980, 18, 140);
    const child = host.querySelector("[data-live-child]");
    await move(400, 400, EXIT_GRACE_MS);
    expect(animate).not.toHaveBeenCalled();
    expect(host.querySelector("[data-live-child]")).toBe(child);
  });
  it("commits right-hand width once, without a competing clip-path track", async () => {
    await setup("home");
    await click(0);
    await click(1);
    expect(panel.parentElement!.style.width).toBe("var(--right-pane-push, 0px)");
    expect(animate.mock.calls.every((args) => !JSON.stringify(args).includes("clipPath"))).toBe(
      true,
    );
  });
});

describe("inspector shell placement", () => {
  it("reserves the pinned width when its portal host arrives after the first commit", async () => {
    const shell = document.createElement("div");
    shell.dataset.volliShell = "framed";
    const paper = document.createElement("main");
    paper.dataset.slot = "sidebar-inset";
    paper.dataset.volliSurface = "";
    const outlet = document.createElement("div");
    shell.append(paper, outlet);
    document.body.append(shell);
    const draw = (portal: HTMLDivElement | null) =>
      root.render(
        <InspectorHostContext.Provider value={portal}>
          <InspectorShell enabled owner="home">
            Pinned inspector
          </InspectorShell>
        </InspectorHostContext.Provider>,
      );
    try {
      await act(async () => draw(null));
      expect(shell.style.getPropertyValue("--right-pane-push")).toBe("");
      await act(async () => draw(outlet));
      expect(outlet.querySelector("[data-inspector-panel]")).not.toBeNull();
      expect(shell.style.getPropertyValue("--right-pane-push")).toBe("300px");
      await act(async () => useUiStore.setState({ railCollapsed: true }));
      expect(shell.style.getPropertyValue("--right-pane-push")).toBe("0px");
    } finally {
      await act(async () => root.unmount());
      shell.remove();
    }
  });

  it("portals outside paper while retaining the resident page through pin and enable changes", async () => {
    const outlet = document.createElement("div");
    const paper = document.createElement("main");
    paper.dataset.slot = "sidebar-inset";
    paper.dataset.volliSurface = "";
    document.body.append(paper, outlet);
    function Workspace({ enabled }: { enabled: boolean }) {
      return (
        <InspectorHostContext.Provider value={outlet}>
          <InspectorShell enabled={enabled} owner="ticket">
            <input aria-label="Resident draft" defaultValue="Preserved" />
          </InspectorShell>
        </InspectorHostContext.Provider>
      );
    }
    await act(async () => root.render(<Workspace enabled />));
    const draft = outlet.querySelector("input")!;
    expect(paper.contains(draft)).toBe(false);
    expect(outlet.querySelector("aside")!.style.width).toBe("var(--right-pane-push, 0px)");
    await act(async () => useUiStore.setState({ railCollapsed: true }));
    expect(outlet.querySelector("input")).toBe(draft);
    await act(async () => root.render(<Workspace enabled={false} />));
    expect(outlet.querySelector("input")).toBe(draft);
    expect(outlet.querySelector("aside")!.style.width).toBe("0px");
    expect(outlet.querySelector("aside")!.style.display).toBe("none");
    await act(async () => root.unmount());
    // afterEach still unmounts the already-empty root.
    paper.remove();
    outlet.remove();
  });
});
