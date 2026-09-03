// @vitest-environment jsdom
import { DEFAULT_CANVAS, type Canvas } from "@volli/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { useThemeStore, type ThemeScope } from "@renderer/stores/theme";

import { AppearanceModeChoice, CanvasEditor } from "./canvas-editor";

const GLOBAL: ThemeScope = { kind: "global" };
const ORIGINAL_COMMIT_PREVIEW = useThemeStore.getState().commitPreview;

const THREE_STOPS: Canvas = {
  ...DEFAULT_CANVAS,
  stops: [
    { hex: "#e8652a", x: 0.2, y: 0.3 },
    { hex: "#2a7de8", x: 0.6, y: 0.5 },
    { hex: "#7de82a", x: 0.8, y: 0.8 },
  ],
  primaryIndex: 1,
};

function render(canvas: Canvas, resolved: "light" | "dark"): string {
  return renderToStaticMarkup(<CanvasEditor scope={GLOBAL} canvas={canvas} resolved={resolved} />);
}

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
    useThemeStore.setState({ preview: DEFAULT_CANVAS, commitPreview });
    const document = await mountEditor({
      scope: GLOBAL,
      canvas: DEFAULT_CANVAS,
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
    useThemeStore.setState({ preview: DEFAULT_CANVAS, commitPreview });
    const document = await mountEditor({ scope: GLOBAL, canvas: DEFAULT_CANVAS, resolved: "dark" });

    const add = document.querySelector<HTMLButtonElement>('button[aria-label="Add a colour"]');
    if (add === null) throw new Error("missing add colour button");
    await act(async () => add.click());

    expect(commitPreview).toHaveBeenCalledWith(GLOBAL);
  });

  it("restores a memory-only host's chosen canvas when Escape abandons a draft", async () => {
    useThemeStore.setState({ preview: DEFAULT_CANVAS });
    const document = await mountEditor({
      scope: GLOBAL,
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
      scope: GLOBAL,
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

  it("puts an orb on the pad for every stop, at its stored anchor", () => {
    const html = render(THREE_STOPS, "dark");

    expect(html).toContain('data-testid="canvas-stop-orb-0"');
    expect(html).toContain('data-testid="canvas-stop-orb-2"');
    expect(html).toContain("left:20%");
    expect(html).toContain("top:30%");
    // Every orb wears its AUTHORED colour, never the per-mode transform of it —
    // an orb that dimmed in dark would disagree with the swatch it came from.
    expect(html).toContain("background:#7de82a");
  });

  it("marks the primary and says so, since every other stop derives from it", () => {
    const html = render(THREE_STOPS, "dark");

    expect(html).toContain('aria-label="Colour 2, #2a7de8, primary"');
    expect(html).toContain("primary");
  });

  it("names which colour the minus button will take", () => {
    // `removeStop` never takes the primary — it would recolour the window rather
    // than remove a colour — so with the primary in the middle the LAST stop
    // goes, and the button says which.
    expect(render(THREE_STOPS, "dark")).toContain('aria-label="Remove colour 3"');
  });

  it("refuses to remove the last colour, and to add past the engine's ceiling", () => {
    const one = render(DEFAULT_CANVAS, "dark");
    expect(one).toContain('aria-label="Remove a colour"');
    expect(one).toContain("You need at least one colour");

    const three = render(THREE_STOPS, "dark");
    expect(three).toContain("A canvas can have at most 3 colours");
  });

  it("opens the swatch row on the page the primary lives on", () => {
    // The page FOLLOWS the primary: a row that stayed on page 0 would show nine
    // swatches with the ring on none of them, which is the control silently
    // disagreeing with the window.
    const html = render(DEFAULT_CANVAS, "dark");

    // Ember lives on the second page, beside the other deep seeds.
    expect(html).toContain('aria-label="#c53d43"');
    expect(html).not.toContain('aria-label="#f2ede4"');
  });

  it("carries the primary's hex in an editable field", () => {
    expect(render(DEFAULT_CANVAS, "dark")).toContain('aria-label="Primary colour hex"');
    expect(render(DEFAULT_CANVAS, "dark")).toContain('value="#e8652a"');
  });

  it("reports vibrancy and grain to the reader, and paints them for the eye", () => {
    // No visible percentages (the Arc arrangement): each fader's wave stand
    // IS its readout. The values still reach assistive tech through the
    // native inputs' own attributes.
    const html = render(DEFAULT_CANVAS, "dark");

    expect(html).toContain('aria-label="Vibrancy"');
    expect(html).toContain('value="0.6"');
    expect(html).toContain('aria-label="Grain"');
    expect(html).toContain('value="0.15"');
    expect(html).not.toContain("60%");
    expect(html).not.toContain("15%");
  });

  it("stands vibrancy and grain as two matching faders, and the dial is gone", () => {
    // The owner traded the rotary grain dial for the symmetry of two vertical
    // wave faders flanking the pad. Two native ranges: click-to-jump, the
    // keyboard and the focus ring come with the platform's own control.
    const html = render(DEFAULT_CANVAS, "dark");

    expect(html.match(/type="range"/g)).toHaveLength(2);
    expect(html).not.toContain('data-testid="canvas-grain-dial"');
  });

  it("wears the grain on the pad, which inherited the dial face's readout job", () => {
    // A value this subtle cannot be read off a thumb position, so the texture
    // shows on the picture being tuned: the pad is a minimap of the window,
    // and the window wears grain too.
    const textured = render(DEFAULT_CANVAS, "dark");
    const none = render({ ...DEFAULT_CANVAS, grain: 0 }, "dark");

    expect(textured).toContain("url(&quot;data:image/svg+xml");
    expect(none).not.toContain("url(&quot;data:image/svg+xml");
  });

  it("carries no visible copy — the controls are the explanation", () => {
    // The Arc arrangement: no row labels, no percentages, no hex chips. What
    // each control is lives in its aria-label; what it is SET TO lives in
    // its own drawing (orb colours, wave stand, knob face).
    const html = render(DEFAULT_CANVAS, "dark");

    for (const word of [">Colours<", ">Primary<", ">Vibrancy<", ">Grain<"]) {
      expect(html).not.toContain(word);
    }
    expect(html).not.toContain("canvas-stop-chip");
  });

  it("floats the page's mode control at the pad's head when one is passed", () => {
    // A SLOT, not a built-in: appearance and canvas are scoped independently,
    // so Configure keeps mode on its own overridable row and passes nothing.
    const withMode = renderToStaticMarkup(
      <CanvasEditor
        scope={GLOBAL}
        canvas={DEFAULT_CANVAS}
        resolved="dark"
        mode={<span data-testid="mode-slot" />}
      />,
    );
    const without = render(DEFAULT_CANVAS, "dark");

    expect(withMode).toContain('data-testid="mode-slot"');
    expect(without).not.toContain('data-testid="mode-slot"');
  });

  it("never lectures about contrast — the canvas is the user's own call", () => {
    // The stranded-floor alert came out at the owner's call: it was a
    // persistent warning about an outcome the user chose. Even the canvas
    // that used to trip it renders controls only.
    const stranding = {
      ...DEFAULT_CANVAS,
      stops: [{ hex: "#e068d8", x: 0.5, y: 0.5 }],
      vibrancy: 1,
    };

    expect(render(stranding, "light")).not.toContain("contrast");
  });
});

describe("AppearanceModeChoice", () => {
  it("offers all three modes and presses the one in force", () => {
    const html = renderToStaticMarkup(
      <AppearanceModeChoice value="auto" testId="mode" onChange={() => {}} />,
    );

    expect(html).toContain("Light");
    expect(html).toContain("Dark");
    expect(html).toContain("Auto");
    expect(html).toContain('aria-pressed="true" data-choice="auto"');
    expect(html).toContain('aria-pressed="false" data-choice="light"');
  });
});
