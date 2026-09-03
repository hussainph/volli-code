// @vitest-environment jsdom
import { DEFAULT_CANVAS, type Canvas } from "@volli/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useThemeStore } from "@renderer/stores/theme";
import { LabThemeToolbar, useLabThemeController, type LabThemeController } from "./theme-toolbar";

const ORIGINAL_THEME_ACTIONS = {
  commitPreview: useThemeStore.getState().commitPreview,
  setGlobalCanvas: useThemeStore.getState().setGlobalCanvas,
  setGlobalAppearance: useThemeStore.getState().setGlobalAppearance,
};

const THREE_STOPS: Canvas = {
  stops: [
    { hex: "#2ba39c", x: 0.2, y: 0.7 },
    { hex: "#e8652a", x: 0.6, y: 0.4 },
    { hex: "#7a4fa3", x: 0.8, y: 0.2 },
  ],
  primaryIndex: 2,
  vibrancy: 0.9,
  grain: 0.35,
};

let root: Root | null = null;
let container: HTMLElement | null = null;
let controller: LabThemeController | null = null;

async function mountController(toolbar = false, floating = false): Promise<void> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  function Probe() {
    controller = useLabThemeController();
    return toolbar ? <LabThemeToolbar controller={controller} floating={floating} /> : null;
  }
  await act(async () => root?.render(<Probe />));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  useThemeStore.setState({
    preview: null,
    previewAppearance: null,
    globalCanvas: DEFAULT_CANVAS,
    globalAppearance: "auto",
  });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  controller = null;
  useThemeStore.setState({
    preview: null,
    previewAppearance: null,
    ...ORIGINAL_THEME_ACTIONS,
  });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useLabThemeController", () => {
  it("owns and previews the complete canvas rather than only its primary hex", async () => {
    await mountController();
    if (controller === null) throw new Error("missing Lab theme controller");

    await act(async () => controller?.setCanvas(THREE_STOPS));

    expect(controller.canvas).toEqual(THREE_STOPS);
    expect(useThemeStore.getState().preview).toEqual(THREE_STOPS);
  });

  it("reapplies its complete choice after a scratch resets the theme store", async () => {
    await mountController();
    if (controller === null) throw new Error("missing Lab theme controller");
    await act(async () => {
      controller?.setCanvas(THREE_STOPS);
      controller?.setAppearance("dark");
    });
    useThemeStore.setState({ preview: null, previewAppearance: null });

    await act(async () => controller?.reapply());

    expect(useThemeStore.getState().preview).toEqual(THREE_STOPS);
    expect(useThemeStore.getState().previewAppearance).toBe("dark");
  });
});

describe("LabThemeToolbar", () => {
  it("opens the production canvas and appearance controls from one compact trigger", async () => {
    await mountController(true);
    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="Lab theme"]');
    if (trigger === null) throw new Error("missing Lab theme trigger");

    await act(async () => trigger.click());

    expect(document.querySelector('[role="dialog"][aria-label="Lab theme editor"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="canvas-pad"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="lab-appearance-choice"]')).not.toBeNull();
  });

  it("keeps the full-window scratch control and editor above app stacking contexts", async () => {
    await mountController(true, true);
    const toolbar = document.querySelector('[data-testid="lab-theme-toolbar"]');
    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="Lab theme"]');
    if (trigger === null) throw new Error("missing Lab theme trigger");

    expect(toolbar?.getAttribute("class")).toContain("fixed");
    expect(toolbar?.getAttribute("class")).toContain("z-[10000]");
    await act(async () => trigger.click());
    expect(
      document.querySelector('[data-slot="popover-content"]')?.getAttribute("class"),
    ).toContain("z-[10001]");
  });

  it("keeps a full non-saving choice active after closing and reopening", async () => {
    const commitPreview = vi.fn(async () => true);
    const setGlobalCanvas = vi.fn(async () => true);
    const setGlobalAppearance = vi.fn(async () => true);
    useThemeStore.setState({ commitPreview, setGlobalCanvas, setGlobalAppearance });
    await mountController(true);
    if (controller === null) throw new Error("missing Lab theme controller");
    await act(async () => controller?.setCanvas(THREE_STOPS));
    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="Lab theme"]');
    if (trigger === null) throw new Error("missing Lab theme trigger");

    await act(async () => trigger.click());
    const remove = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove colour 2"]',
    );
    const dark = document.querySelector<HTMLButtonElement>(
      '[data-testid="lab-appearance-choice"] button[data-choice="dark"]',
    );
    if (remove === null || dark === null) throw new Error("missing Lab theme controls");
    await act(async () => {
      remove.click();
      dark.click();
    });

    expect(controller?.canvas).toEqual({
      stops: [
        { hex: "#547300", x: 0.2, y: 0.7 },
        { hex: "#7a4fa3", x: 0.8, y: 0.2 },
      ],
      primaryIndex: 1,
      vibrancy: 0.9,
      grain: 0.35,
    });
    expect(controller?.appearance).toBe("dark");
    expect(useThemeStore.getState().preview).toEqual(controller?.canvas);
    expect(useThemeStore.getState().previewAppearance).toBe("dark");
    expect(commitPreview).not.toHaveBeenCalled();
    expect(setGlobalCanvas).not.toHaveBeenCalled();
    expect(setGlobalAppearance).not.toHaveBeenCalled();

    await act(async () => trigger.click());
    expect(document.querySelector('[data-testid="canvas-pad"]')).toBeNull();
    expect(useThemeStore.getState().preview).toEqual(controller?.canvas);

    await act(async () => trigger.click());
    expect(document.querySelectorAll('[data-testid^="canvas-stop-orb-"]')).toHaveLength(2);
    expect(
      document.querySelector('[data-testid="canvas-stop-orb-1"]')?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      document.querySelector('[data-testid="canvas-stop-orb-1"]')?.getAttribute("style"),
    ).toContain("left: 80%");
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Vibrancy"]')?.value).toBe(
      "0.9",
    );
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Grain"]')?.value).toBe(
      "0.35",
    );
    expect(
      document
        .querySelector('[data-testid="lab-appearance-choice"] button[data-choice="dark"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
  });
});
