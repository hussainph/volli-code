// @vitest-environment jsdom
import { DEFAULT_CANVAS } from "@volli/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { useThemeStore, type ThemeScope } from "@renderer/stores/theme";

import { CanvasInstrument as CanvasEditor } from "./canvas-instrument";

const GLOBAL: ThemeScope = { kind: "global" };
// Adding a stop needs spare capacity; the shipped mesh already fills its slots.
const SINGLE_CANVAS = { ...DEFAULT_CANVAS, stops: [DEFAULT_CANVAS.stops[0]] };
const ORIGINAL_COMMIT_PREVIEW = useThemeStore.getState().commitPreview;

let root: Root | null = null;
let container: HTMLElement | null = null;

async function mountEditor(props: React.ComponentProps<typeof CanvasEditor>) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<CanvasEditor {...props} />));
  return document;
}

async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    setValue?.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  useThemeStore.setState({
    preview: null,
    previewAppearance: null,
    commitPreview: ORIGINAL_COMMIT_PREVIEW,
  });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CanvasEditor", () => {
  it("hands a finished edit to a memory-only host without committing it", async () => {
    const onCanvasChange = vi.fn();
    const commitPreview = vi.fn(async () => true);
    useThemeStore.setState({ preview: SINGLE_CANVAS, commitPreview });
    const document = await mountEditor({
      canvas: SINGLE_CANVAS,
      resolved: "dark",
      onCanvasChange,
    });

    const add = document.querySelector<HTMLButtonElement>('button[aria-label="Add a colour"]');
    if (add === null) throw new Error("missing add colour button");
    await act(async () => add.click());

    expect(onCanvasChange).toHaveBeenCalledWith(
      expect.objectContaining({
        stops: expect.arrayContaining([expect.any(Object), expect.any(Object)]),
      }),
    );
    expect(onCanvasChange.mock.calls[0]?.[0].stops).toHaveLength(2);
    expect(commitPreview).not.toHaveBeenCalled();
  });

  it("keeps Settings' scoped save behavior when no memory-only host is passed", async () => {
    const commitPreview = vi.fn(async () => true);
    useThemeStore.setState({ preview: SINGLE_CANVAS, commitPreview });
    const document = await mountEditor({ scope: GLOBAL, canvas: SINGLE_CANVAS, resolved: "dark" });

    const add = document.querySelector<HTMLButtonElement>('button[aria-label="Add a colour"]');
    if (add === null) throw new Error("missing add colour button");
    await act(async () => add.click());

    expect(commitPreview).toHaveBeenCalledWith(GLOBAL);
  });

  it("restores a memory-only host's chosen canvas when Escape abandons a draft", async () => {
    useThemeStore.setState({ preview: DEFAULT_CANVAS });
    const document = await mountEditor({
      canvas: DEFAULT_CANVAS,
      resolved: "dark",
      onCanvasChange: vi.fn(),
    });
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="Primary colour hex"]',
    );
    if (input === null) throw new Error("missing primary colour input");
    await typeInto(input, "#2ba39c");
    expect(useThemeStore.getState().preview?.stops[0].hex).toBe("#2ba39c");

    await act(async () => {
      input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(useThemeStore.getState().preview).toEqual(DEFAULT_CANVAS);
  });

  it("restores a memory-only host's chosen canvas when the editor unmounts mid-edit", async () => {
    useThemeStore.setState({ preview: DEFAULT_CANVAS });
    const document = await mountEditor({
      canvas: DEFAULT_CANVAS,
      resolved: "dark",
      onCanvasChange: vi.fn(),
    });
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="Primary colour hex"]',
    );
    if (input === null) throw new Error("missing primary colour input");
    await typeInto(input, "#2ba39c");
    expect(useThemeStore.getState().preview?.stops[0].hex).toBe("#2ba39c");

    await act(async () => root?.unmount());
    root = null;

    expect(useThemeStore.getState().preview).toEqual(DEFAULT_CANVAS);
  });

  it("previews rotary keys and commits only on release", async () => {
    const commitPreview = vi.fn(async () => true);
    useThemeStore.setState({ preview: null, commitPreview });
    const document = await mountEditor({ scope: GLOBAL, canvas: DEFAULT_CANVAS, resolved: "dark" });
    const knob = document.querySelector<HTMLElement>('[role="slider"][aria-label="Vibrancy"]')!;
    expect(knob.className).toContain("glass-control");
    expect(knob.className).toContain("border-(--glass-edge)");
    expect(knob.querySelector("[aria-hidden]")?.className).not.toContain("border");
    expect(knob.querySelector("[aria-hidden]")?.className).not.toContain("shadow");
    await act(async () =>
      knob.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })),
    );
    expect(useThemeStore.getState().preview?.vibrancy).toBeCloseTo(DEFAULT_CANVAS.vibrancy + 0.01);
    expect(commitPreview).not.toHaveBeenCalled();
    await act(async () =>
      knob.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowUp", bubbles: true })),
    );
    expect(commitPreview).toHaveBeenCalledWith(GLOBAL);
  });
});
