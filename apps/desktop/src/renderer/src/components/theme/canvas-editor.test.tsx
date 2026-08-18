import { DEFAULT_CANVAS, type Canvas } from "@volli/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { ThemeScope } from "@renderer/stores/theme";

import { AppearanceModeChoice, CanvasEditor } from "./canvas-editor";

const GLOBAL: ThemeScope = { kind: "global" };

/** A saturated magenta in light — the one input that strands a declared floor. */
const STRANDING: Canvas = {
  ...DEFAULT_CANVAS,
  stops: [{ hex: "#e068d8", x: 0.5, y: 0.5 }],
  vibrancy: 1,
};

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

describe("CanvasEditor", () => {
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
    expect(one).toContain("A canvas needs at least one colour");

    const three = render(THREE_STOPS, "dark");
    expect(three).toContain("A canvas carries at most 3 colours");
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

  it("shows vibrancy and grain as their stored fractions", () => {
    const html = render(DEFAULT_CANVAS, "dark");

    expect(html).toContain('aria-label="Vibrancy"');
    expect(html).toContain('value="0.6"');
    expect(html).toContain("60%");
    expect(html).toContain('aria-label="Grain"');
    expect(html).toContain("15%");
  });

  it("gives grain a dial and vibrancy a track, because they are not the same control", () => {
    // A rushed port flattened both into `<input type="range">`. Vibrancy has a
    // position along a line and grain does not — it has an amount of texture,
    // which only a face can show.
    const html = render(DEFAULT_CANVAS, "dark");

    expect(html).toContain('data-testid="canvas-grain-dial"');
    expect(html).toContain('role="slider"');
    expect(html).toContain('aria-valuenow="0.15"');
    // Exactly one native range, and it is vibrancy's.
    expect(html.match(/type="range"/g)).toHaveLength(1);
  });

  it("puts the grain itself on the dial's face, which is the reason it is a dial", () => {
    // A value this subtle cannot be read off a number or a thumb position, so
    // the knob shows the texture it is setting — on a mid-grey backdrop, the one
    // surface that carries both black noise and a white notch in either mode.
    const textured = render(DEFAULT_CANVAS, "dark");
    const none = render({ ...DEFAULT_CANVAS, grain: 0 }, "dark");

    expect(textured).toContain("#8a8a8a");
    expect(textured).toContain("url(&quot;data:image/svg+xml");
    expect(none).toContain("#8a8a8a");
    expect(none).not.toContain("url(&quot;data:image/svg+xml");
  });

  it("keeps the dial operable without a pointer", () => {
    const html = render(DEFAULT_CANVAS, "dark");

    expect(html).toContain('tabindex="0"');
    expect(html).toContain('aria-valuemin="0"');
    expect(html).toContain('aria-valuemax="1"');
  });

  it("reads out every floor it measured, in both modes, with nothing stranded", () => {
    for (const resolved of ["light", "dark"] as const) {
      const html = render(DEFAULT_CANVAS, resolved);

      expect(html).toContain('data-testid="canvas-contrast-readout"');
      expect(html).toContain("Body copy");
      expect(html).toContain("Secondary copy");
      expect(html).toContain("Sidebar nav");
      expect(html).not.toContain('data-testid="canvas-contrast-stranded"');
    }
  });

  it("names what is unreachable, and says nothing else", () => {
    // The state the whole report exists for: the engine clamps an impossible
    // floor to the best its surface allows and says nothing, so this is the only
    // surface in the app that can tell anyone.
    const html = render(STRANDING, "light");

    expect(html).toContain('data-testid="canvas-contrast-stranded"');
    expect(html).toContain("Sidebar nav does not meet its contrast floor");
  });

  // A blocked state earns one line and one action (AGENTS.md, UI copy). The
  // numbers behind it are already on screen in the readout above, and the
  // reason is a property of colour space rather than of anything the user can
  // act on — so it belongs in the module comment, which is where it lives.
  it("does not lecture: no token names, no solver arithmetic, no colour-space essay", () => {
    const html = render(STRANDING, "light");
    const alert = html.slice(html.indexOf('data-testid="canvas-contrast-stranded"'));

    for (const lecture of ["--sidebar", "asks for Lc", "colour space", "Nav rows and section"]) {
      expect(alert).not.toContain(lecture);
    }
  });

  it("annotates a hairline ceiling in the readout without raising an alarm over it", () => {
    // Body copy is also at its ceiling on this canvas, by a third of an Lc —
    // finer than the hex it is emitted as. It is reported, and it is not alarmed
    // about; the shipped canvas crosses that same hairline as vibrancy moves.
    const html = render(STRANDING, "light");

    expect(html).toContain("at this canvas&#x27;s ceiling");
    expect(html).not.toContain("Body copy</span> asks for Lc");
  });

  it("offers the vibrancy that recovers it, as a slider position", () => {
    const html = render(STRANDING, "light");

    expect(html).toContain('data-testid="canvas-contrast-ease"');
    expect(html).toContain("Set vibrancy to");
  });

  it("raises no alarm for the same canvas in dark, where the ladder has room", () => {
    expect(render(STRANDING, "dark")).not.toContain('data-testid="canvas-contrast-stranded"');
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
