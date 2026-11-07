import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_CANVAS,
  effectiveStopHexes,
  regularGlassBackdrop,
  compositeHex,
  hexToOklch,
  oklchToHex,
  hexChannels,
  wcagContrast,
} from "@volli/shared";
import { deriveCanvasPaint } from "./canvas-paint";

/** Composite the emitted CSS, not a separately maintained approximation of its recipe. */
function over(css: string, background: string): string {
  if (css.startsWith("#")) return css;
  const mix = /^color-mix\(in oklab, (#[a-f0-9]{6}) ([\d.]+)%, transparent\)$/.exec(css);
  if (mix) return compositeHex(mix[1], Number(mix[2]) / 100, background);
  const rgba = /^rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)$/.exec(css);
  if (!rgba) throw new Error(`Unexpected fill: ${css}`);
  const hex = `#${rgba
    .slice(1, 4)
    .map((byte) => Number(byte).toString(16).padStart(2, "0"))
    .join("")}`;
  return compositeHex(hex, Number(rgba[4]), background);
}

const seeds = [
  "#e8652a",
  "#18b6a4",
  "#4653a2",
  "#a020f0",
  "#00ff00",
  "#80817f",
  "#ff00ff",
  "#000000",
  "#ffffff",
  "#0000ff",
  "#ffff00",
  "#ff0000",
  ...Array.from({ length: 24 }, (_, i) => oklchToHex(0.65, 0.25, i * 15)),
];

describe("tinted material contrast", () => {
  it.each([
    ["#e6f6ff", "#ebedef", "#333639", "#4d5052"],
    ["#f5eaff", "#eeecef", "#363439", "#504e52"],
  ])(
    "%s preserves a pale tint even when its 14% composite quantizes to neutral",
    (seed, fill, glass, rounded) => {
      const canvas = { ...DEFAULT_CANVAS, vibrancy: 0, stops: [{ hex: seed, x: 0, y: 1 }] };
      const { canvasTokens: c } = deriveCanvasPaint(canvas, "dark");
      const channels = [1, 3, 5].map((offset) => parseInt(fill.slice(offset, offset + 2), 16));
      expect(c["--control-face"]).toBe(`rgb(${channels.join(" ")} / 0.14)`);
      const backdrop = regularGlassBackdrop(effectiveStopHexes(canvas, "dark")[0], "dark");
      expect(over(c["--glass-pane-veil"], backdrop)).toBe(glass);
      // RGB alpha paint composites in gamma-encoded sRGB channels. Retain
      // the fractional bytes before the compositor rounds, not an Oklab mix.
      const under = hexChannels(glass);
      const unrounded = (hex: string) =>
        hexChannels(hex).map((channel, index) => under[index] + 0.14 * (channel - under[index]));
      expect(unrounded(fill)).not.toEqual(unrounded("#ededed"));
      expect(over(c["--control-face"], glass)).toBe(rounded);
      expect(compositeHex("#ededed", 0.14, glass)).toBe(rounded);
    },
  );

  describe.each(["light", "dark"] as const)("%s", (mode) => {
    it.each(["#ef8a4b", "#2a7de8", "#f8f0d8", "#e6f6ff", "#f5eaff", "#ffffff"])(
      "%s: opaque checkout faces preserve the navigation text and icon pairs",
      (seed) => {
        for (const vibrancy of [0, 0.6, 1]) {
          for (const placement of [
            { stops: [{ hex: seed, x: 0.5, y: 0.5 }], primaryIndex: 0 },
            {
              stops: [
                { hex: seed, x: 0, y: 1 },
                { hex: "#ffffff", x: 1, y: 0 },
                { hex: "#000000", x: 0.5, y: 0.5 },
              ],
              primaryIndex: 1,
            },
          ]) {
            const canvas = { ...DEFAULT_CANVAS, ...placement, vibrancy };
            const { tokens: t, canvasTokens: c } = deriveCanvasPaint(canvas, mode);
            // These faces are opaque even inside navigation glass. The JSX keeps
            // its inherited foreground/muted pair and the DriveIcon accent ink.
            const face = c["--card-face"];
            for (const [role, ink, floor] of [
              ["foreground(--glass-ink)", c["--glass-ink"], 4.5],
              ["path text(--glass-secondary)", c["--glass-secondary"], 4.5],
              ["folder icon(--glass-secondary)", c["--glass-secondary"], 3],
              ["drive icon(--primary-text)", t["--primary-text"], 3],
            ] as const) {
              expect(
                wcagContrast(ink, face),
                `${mode}/${seed}/v${vibrancy}/primary${placement.primaryIndex}/${role}=${ink}/opaque card-face=${face}`,
              ).toBeGreaterThanOrEqual(floor);
            }
          }
        }
      },
    );

    it.each([
      "#ef8a4b",
      "#2a7de8",
      "#00ff00",
      "#a020f0",
      "#f8f0d8",
      "#e6f6ff",
      "#f5eaff",
      "#80817f",
      "#000000",
      "#ffffff",
    ])(
      "%s: custom rail placements retain reading contrast on their actual veils and control faces",
      (seed) => {
        for (const primaryIndex of [0, 1, 2]) {
          for (const vibrancy of [0, 0.6, 1]) {
            const canvas = {
              ...DEFAULT_CANVAS,
              primaryIndex,
              vibrancy,
              stops: [
                { hex: seed, x: 0, y: 1 },
                { hex: "#ffffff", x: 1, y: 0 },
                { hex: "#000000", x: 0.5, y: 0.5 },
              ],
            };
            const { tokens: t, canvasTokens: c } = deriveCanvasPaint(canvas, mode);
            const neutralControl = deriveCanvasPaint(
              {
                ...canvas,
                stops: canvas.stops.map((stop) => ({ hex: "#808080", x: stop.x, y: stop.y })),
              },
              mode,
            ).canvasTokens["--control-face"];
            for (const peak of effectiveStopHexes(canvas, mode)) {
              const glass = over(c["--glass-pane-veil"], regularGlassBackdrop(peak, mode));
              const control = over(c["--control-face"], glass);
              // Hold the backdrop fixed: this proves the winning control material,
              // not just the canvas behind it, carries authored colour.
              if (["#ef8a4b", "#2a7de8", "#00ff00", "#a020f0"].includes(seed)) {
                expect(
                  control,
                  `${seed}/${primaryIndex}/${vibrancy}/${mode}/control=${c["--control-face"]}/neutral=${neutralControl}/glass=${glass}`,
                ).not.toBe(over(neutralControl, glass));
              }
              // Browse files / PR use outline text-foreground. Neither has
              // secondary text; the automation's muted chevron is inspector,
              // in a portalled writing popover, not on this control face.
              for (const surface of [control, over(c["--glass-outline-pressed"], control)]) {
                expect(
                  wcagContrast(c["--glass-ink"], surface),
                  `${seed}/primary${primaryIndex}/v${vibrancy}/${mode}/outline-${surface === control ? "rest" : "pressed"}/ink${c["--glass-ink"]}/face${surface}/glass${glass}/black-on-glass${wcagContrast("#000000", glass)}/white-on-glass${wcagContrast("#ffffff", glass)}`,
                ).toBeGreaterThanOrEqual(4.5);
              }
              for (const [role, surface] of [
                ["navigation", glass],
                ["tile-wash", compositeHex(c["--glass-wash-ink"], 0.1, glass)],
                ["rail-footer", compositeHex(t["--popover"], 0.3, glass)],
                [
                  "card-frame",
                  compositeHex(mode === "dark" ? t["--accent"] : t["--popover"], 0.5, glass),
                ],
              ] as const) {
                for (const [tier, ink] of [
                  ["foreground", c["--glass-ink"]],
                  ["secondary", c["--glass-secondary"]],
                ] as const) {
                  expect(
                    wcagContrast(ink, surface),
                    `${seed}/${primaryIndex}/${vibrancy}/${mode}/${role}/${tier}/${surface}/${ink}`,
                  ).toBeGreaterThanOrEqual(4.5);
                }
              }
            }
          }
        }
      },
    );

    it.each(seeds)("%s: reading ink survives actual material composites", (seed) => {
      for (const vibrancy of [0, 0.3, 0.6, 1]) {
        const canvas = { ...DEFAULT_CANVAS, stops: [{ hex: seed, x: 0.5, y: 0.5 }], vibrancy };
        const { tokens: t, canvasTokens: c } = deriveCanvasPaint(canvas, mode);
        const opaque = [
          t["--background"],
          t["--muted"],
          t["--popover"],
          c["--card-face"],
          c["--surface-secondary"],
          c["--surface-quaternary"],
        ];
        const surfaces = [
          ...opaque,
          compositeHex(seed, 0.18, t["--card"]),
          compositeHex(c["--wash-ink"], 0.22, t["--background"]),
          ...opaque.flatMap((base) => [
            over(c["--fill-row-hover"], base),
            over(c["--fill-row-selected"], base),
            over(c["--fill-secondary"], base), // translucent pressed/hover overlays
            over(c["--fill-quaternary"], base), // translucent quiet overlays
            over(c["--control-face"], base),
            over(c["--tab-selected-face"], base),
            over(c["--control-face"], over(c["--fill-secondary"], base)),
            over(c["--tab-selected-face"], over(c["--fill-secondary"], base)),
            over(c["--glass-writing-veil"], regularGlassBackdrop(base, mode)),
          ]),
          // Probe all RGB corners under floating menus, not just opaque paper.
          ...[
            "#000000",
            "#ffffff",
            "#ff0000",
            "#00ff00",
            "#0000ff",
            "#ffff00",
            "#00ffff",
            "#ff00ff",
          ].map((base) => over(c["--glass-veil"], regularGlassBackdrop(base, mode))),
        ];
        for (const surface of surfaces) {
          const context = `${seed}/${vibrancy}/${mode}/${surface}`;
          for (const ink of [
            t["--foreground"],
            t["--muted-foreground"],
            c["--label-ink"],
            c["--diff-added"],
            c["--diff-removed"],
          ]) {
            expect(wcagContrast(ink, surface), `${context}/${ink}`).toBeGreaterThanOrEqual(4.5);
          }
          expect(wcagContrast(c["--tertiary-foreground"], surface), context).toBeGreaterThanOrEqual(
            3,
          );
          expect(wcagContrast(t["--ring"], surface), context).toBeGreaterThanOrEqual(3);
        }
        for (const peak of effectiveStopHexes(canvas, mode)) {
          const glass = over(c["--glass-pane-veil"], regularGlassBackdrop(peak, mode));
          for (const surface of [
            over(c["--control-face"], glass),
            over(c["--glass-outline-pressed"], over(c["--control-face"], glass)),
          ]) {
            expect(
              wcagContrast(c["--glass-ink"], surface),
              `${seed}/v${vibrancy}/${mode}/outline-${surface === over(c["--control-face"], glass) ? "rest" : "pressed"}/ink${c["--glass-ink"]}/face${surface}`,
            ).toBeGreaterThanOrEqual(4.5);
          }
          for (const surface of [
            glass,
            over(c["--fill-row-hover"], glass),
            over(c["--fill-row-selected"], glass),
            compositeHex(c["--glass-wash-ink"], 0.1, glass),
            // Shared rail footer and card frame, including its dark override.
            compositeHex(t["--popover"], 0.3, glass),
            compositeHex(mode === "dark" ? t["--accent"] : t["--popover"], 0.5, glass),
          ]) {
            for (const ink of [c["--glass-ink"], c["--glass-secondary"]]) {
              expect(
                wcagContrast(ink, surface),
                `${seed}/${mode}/navigation/${surface}/${ink}`,
              ).toBeGreaterThanOrEqual(4.5);
            }
          }
        }
        // Automation Run-on is an inspector Button inside a portalled
        // writing popover: body label at 4.5, muted chevron (not text) at 3.
        for (const backing of [
          "#000000",
          "#ffffff",
          "#ff0000",
          "#00ff00",
          "#0000ff",
          "#ffff00",
          "#00ffff",
          "#ff00ff",
        ]) {
          const popover = over(c["--glass-veil"], regularGlassBackdrop(backing, mode));
          const inspector = over(c["--fill-secondary"], popover);
          expect(
            wcagContrast(t["--foreground"], inspector),
            `${seed}/v${vibrancy}/${mode}/inspector-label/ink${t["--foreground"]}/face${inspector}/backing${backing}`,
          ).toBeGreaterThanOrEqual(4.5);
          expect(
            wcagContrast(t["--muted-foreground"], inspector),
            `${seed}/${mode}/inspector-chevron`,
          ).toBeGreaterThanOrEqual(3);
        }
        expect(c["--glass-writing-veil"]).toBe(c["--glass-veil"]);
        expect(t["--foreground"]).toBe(mode === "light" ? "#272727" : "#ededed");
        // Hue-locked semantic colours remain independent of the canvas colour.
        for (const [name, hue] of [
          ["--positive", 162.48],
          ["--attention", 70.08],
          ["--info", 237.32],
          ["--destructive", 23.026],
        ] as const) {
          expect(Math.abs(hexToOklch(t[name]).h - hue)).toBeLessThan(3);
          expect(wcagContrast(t[name], t[`${name}-foreground`])).toBeGreaterThanOrEqual(4.5);
        }
      }
    });
  });
});
