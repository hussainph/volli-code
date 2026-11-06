// @vitest-environment jsdom
import { DEFAULT_CANVAS } from "@volli/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { CANVAS_SWATCH_PAGES } from "@renderer/components/theme/canvas-editor-model";
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
  await act(async () =>
    root?.render(
      <TooltipProvider>
        <CanvasEditor {...props} />
      </TooltipProvider>,
    ),
  );
  return document;
}

async function openControl(label: string) {
  await act(async () =>
    document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click(),
  );
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

    await openControl("Edit canvas");
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

    await openControl("Edit canvas");
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
    await openControl("Custom accent colour");
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="Primary colour hex"]',
    );
    if (input === null) throw new Error("missing primary colour input");
    await act(async () => input.focus());
    await typeInto(input, "#2ba39c");
    expect(useThemeStore.getState().preview?.stops[0].hex).toBe("#2ba39c");

    await act(async () => {
      input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(useThemeStore.getState().preview).toEqual(DEFAULT_CANVAS);
    await openControl("Custom accent colour");
    expect(
      document.querySelector<HTMLInputElement>('input[aria-label="Primary colour hex"]')?.value,
    ).toBe(DEFAULT_CANVAS.stops[DEFAULT_CANVAS.primaryIndex].hex);
  });

  it("restores a memory-only host's chosen canvas when the editor unmounts mid-edit", async () => {
    useThemeStore.setState({ preview: DEFAULT_CANVAS });
    const document = await mountEditor({
      canvas: DEFAULT_CANVAS,
      resolved: "dark",
      onCanvasChange: vi.fn(),
    });
    await openControl("Custom accent colour");
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

  it("previews native slider input and commits only on release", async () => {
    const commitPreview = vi.fn(async () => true);
    useThemeStore.setState({ preview: null, commitPreview });
    await mountEditor({ scope: GLOBAL, canvas: DEFAULT_CANVAS, resolved: "dark" });
    const slider = document.querySelector<HTMLInputElement>('input[aria-label="Vibrancy"]')!;
    await typeInto(slider, String(DEFAULT_CANVAS.vibrancy + 0.01));
    expect(useThemeStore.getState().preview?.vibrancy).toBeCloseTo(DEFAULT_CANVAS.vibrancy + 0.01);
    expect(commitPreview).not.toHaveBeenCalled();
    await act(async () =>
      slider.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowUp", bubbles: true })),
    );
    expect(commitPreview).toHaveBeenCalledWith(GLOBAL);
  });
});

it.each([
  ["#abc", "#aabbcc"],
  ["ABCDEF", "#abcdef"],
  ["  #123456  ", "#123456"],
])("accepts the existing %s hex format and settles canonically", async (entry, normalized) => {
  const onCanvasChange = vi.fn();
  const doc = await mountEditor({ canvas: SINGLE_CANVAS, resolved: "light", onCanvasChange });
  await openControl("Custom accent colour");
  const field = doc.querySelector<HTMLInputElement>('[aria-label="Primary colour hex"]')!;
  await act(async () => field.focus());
  await typeInto(field, entry);
  expect(field.value).toBe(entry);
  await act(async () =>
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
  );
  expect(onCanvasChange).toHaveBeenLastCalledWith(
    expect.objectContaining({ stops: [expect.objectContaining({ hex: normalized })] }),
  );
  expect(field.value).toBe(normalized);
});

it("offers Canvas, seven accent swatches and Custom without inline HSL controls", async () => {
  const onCanvasChange = vi.fn();
  const doc = await mountEditor({ canvas: SINGLE_CANVAS, resolved: "light", onCanvasChange });
  expect(doc.querySelectorAll(".accent-swatch")).toHaveLength(8);
  expect(doc.querySelector('input[aria-label="Hue"]')).toBeNull();
  await act(async () =>
    doc.querySelector<HTMLButtonElement>('[aria-label="Blue accent"]')!.click(),
  );
  expect(onCanvasChange).toHaveBeenLastCalledWith(
    expect.objectContaining({
      stops: [expect.objectContaining({ hex: CANVAS_SWATCH_PAGES[0][7] })],
    }),
  );
  await openControl("Custom accent colour");
  expect(doc.querySelector('[aria-label="Saturation and brightness"]')).not.toBeNull();
  expect(doc.querySelector('input[aria-label="Hue"]')).not.toBeNull();
});

it("names the non-primary removal target and explains the maximum at a keyboard stop", async () => {
  const doc = await mountEditor({ scope: GLOBAL, canvas: DEFAULT_CANVAS, resolved: "dark" });
  await openControl("Edit canvas");
  expect(doc.querySelector('[aria-label="Remove colour 3"]')).not.toBeNull();
  const limit = doc.querySelector<HTMLElement>(
    '[aria-label="A canvas can have at most 3 colours"]',
  )!;
  expect(limit.tabIndex).toBe(0);
  await act(async () => limit.focus());
  await vi.waitFor(() =>
    expect(doc.querySelector('[role="tooltip"]')?.textContent).toContain("at most 3 colours"),
  );
});
