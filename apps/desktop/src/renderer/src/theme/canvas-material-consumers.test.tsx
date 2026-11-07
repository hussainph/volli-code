import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_CANVAS,
  compositeHex,
  hexToOklch,
  tintCanvasNeutral,
  wcagContrast,
} from "@volli/shared";
import { Message, MessageContent } from "@renderer/components/ui/ai-elements/message";
import { Checkbox } from "@renderer/components/ui/checkbox";
import { Select, SelectTrigger, SelectValue } from "@renderer/components/ui/select";
import { FIELD_SURFACE } from "@renderer/components/ui/field-classes";
import { deriveCanvasPaint } from "./canvas-paint";

const css = readFileSync(resolve(import.meta.dirname, "../globals.css"), "utf8");
const tabCss = readFileSync(resolve(import.meta.dirname, "../components/ui/tab-strip.css"), "utf8");
const rule = (source: string, selector: string) => {
  const start = source.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  return source.slice(start, source.indexOf("}", start));
};

describe("tinted material consumers", () => {
  it.each([
    ["automations/armed-run-window.tsx", "bg-wash-ink/10", 1],
    ["automations/armed-run-window.tsx", "bg-wash-ink/50", 1],
    ["automations/automation-lanes.tsx", "bg-(--surface-quaternary)", 2],
    ["settings/panes/provider-accounts.tsx", "bg-(--surface-quaternary)", 1],
    ["pages/model-access-accounts.tsx", "bg-(--surface-quaternary)", 1],
    ["attachments/attachment-strip.tsx", "bg-(--card-face)", 2],
    ["board/project-folder-banner.tsx", "bg-(--card-face)", 1],
    ["chat/runner-picker-start-status.tsx", "bg-(--card-face)", 1],
    ["chat/empty/working-copy-chips.tsx", "bg-(--card-face)", 1],
    ["chat/composer-chrome.ts", "bg-(--card-face)", 1],
    ["app-shell.tsx", "bg-wash-ink/10", 1],
    ["app-shell.tsx", "bg-wash-ink/30", 1],
    ["rail/add-project-tile.tsx", "bg-wash-ink/10", 1],
    ["rail/project-tile.tsx", "bg-wash-ink/10", 1],
    ["rail/project-tile.tsx", "border-border/30", 1],
    ["rail/cloud-rail.tsx", "bg-wash-ink/10", 2],
    ["board/ticket-card.tsx", "border-wash-ink/40", 1],
    ["home/home-rail-footer.tsx", "bg-(--card-face)", 2],
    ["ticket/rail-panel-parts.tsx", "bg-popover/30", 2],
    ["ticket/rail-panel-parts.tsx", "bg-popover/50 dark:bg-accent/50", 1],
  ] as const)("%s consumes %s in its production material classes", (file, material, count) => {
    const source = readFileSync(resolve(import.meta.dirname, "../components", file), "utf8");
    expect(source.split(material).length - 1).toBe(count);
  });

  it("keeps checkout objects opaque and retains their actual inherited text/icon classes", () => {
    const source = readFileSync(resolve(import.meta.dirname, "../components/home/home-rail-footer.tsx"), "utf8");
    expect(source).not.toContain("bg-popover/50");
    expect(source).toContain('className="size-4 text-primary-text"');
    expect(source).toContain('className="size-4 shrink-0 text-muted-foreground"');
    expect(source).toContain('className="min-w-0 truncate rounded-sm text-left font-mono text-ui text-muted-foreground"');
    const navigation = rule(css, "[data-volli-rail].glass");
    expect(navigation).toContain("--foreground: var(--glass-ink)");
    expect(navigation).toContain("--muted-foreground: var(--glass-secondary)");
  });

  it("gives choice controls a tinted base without changing semantic or inspector overrides", () => {
    for (const checked of [false, true, "indeterminate"] as const) {
      const html = renderToStaticMarkup(<Checkbox checked={checked} aria-label="Enabled" />);
      expect(html).toContain("bg-(--card-face)");
      expect(html).toContain("data-[state=checked]:bg-primary");
      expect(html).toContain("data-[state=indeterminate]:bg-primary");
      expect(html).toContain("focus-visible:ring-ring");
      expect(html).toContain(`data-state="${checked === true ? "checked" : checked === false ? "unchecked" : "indeterminate"}"`);
    }
    for (const variant of ["regular", "inspector"] as const) {
      const html = renderToStaticMarkup(
        <Select>
          <SelectTrigger variant={variant} aria-label="Model"><SelectValue /></SelectTrigger>
        </Select>,
      );
      if (variant === "regular") expect(html).toContain("bg-(--card-face)");
      else {
        expect(html).toContain("bg-transparent");
        expect(html).not.toContain("bg-(--card-face)");
      }
      expect(html).toContain("hover:bg-accent");
      expect(html).toContain("focus-visible:ring-ring");
    }
    expect(FIELD_SURFACE).toContain("bg-card"); // Text entry is still neutral writing paper.
  });

  it("wires the real user-message shell to a tinted object face, not diluted ink", () => {
    const html = renderToStaticMarkup(
      <Message from="user">
        <MessageContent>Reading on paper</MessageContent>
      </Message>,
    );
    expect(html).toMatch(/class="[^"]*is-user[^"]*"[^>]*><div class="message-content/);
    const bubble = rule(css, ".is-user > .message-content");
    expect(bubble).toContain("background: var(--surface-secondary)");
    expect(bubble).toContain("color: var(--foreground)");
    expect(bubble).not.toContain("var(--fill-secondary)");
  });

  it("wires paper wells without replacing translucent navigation and pressed layers", () => {
    for (const selector of [".board-column", '.settings-window [data-slot="pref-group"]']) {
      expect(rule(css, selector)).toContain("background: var(--surface-quaternary)");
    }
    expect(rule(tabCss, ".tab-track")).toContain("background: var(--surface-quaternary)");
    expect(
      rule(css, '.settings-window [data-slot="pref-content"] .segmented:not([data-icon-only="true"])'),
    ).toContain("background: var(--surface-secondary)");
    expect(rule(css, ".segmented")).toContain("background: var(--fill-secondary)");
    expect(
      rule(css, '[data-control="button"].control-material:active:not(:disabled)'),
    ).toContain("linear-gradient(var(--fill-secondary), var(--fill-secondary))");
    expect(rule(css, ".session-envelope")).toContain("var(--wash-ink)");
    expect(rule(css, ".session-envelope")).not.toContain("var(--foreground)");
    expect(css).toContain("--wash-ink: var(--glass-wash-ink)");
  });

  it("uses material washes for editor furniture without changing paper or syntax ink", () => {
    for (const mode of ["document", "source"]) {
      const editor = readFileSync(resolve(import.meta.dirname, `../editor/${mode}-mode.css`), "utf8");
      expect(editor).toContain(
        "--vscode-editor-selectionBackground: color-mix(in oklab, var(--wash-ink) 22%, transparent)",
      );
      expect(editor).toContain("var(--wash-ink) 10%");
      expect(editor).not.toMatch(/--vscode-editor-foreground:\s*var\(--wash-ink\)/);
      expect(editor).not.toMatch(/--vscode-editor-background:\s*var\(--wash-ink\)/);
    }
    const illustration = readFileSync(resolve(import.meta.dirname, "../components/ui/empty-state.css"), "utf8");
    expect(illustration).toContain("--es-tile: color-mix(in srgb, var(--card-face) 88%, transparent)");
    expect(illustration).toContain("--es-dot: color-mix(in srgb, var(--wash-ink) 16%, transparent)");
    expect(illustration).toContain("color: var(--foreground)");
  });

  it.each(["light", "dark"] as const)("%s tints final paper-object rungs at the existing budget", (mode) => {
    for (const seed of ["#ef8a4b", "#2a7de8", "#a020f0", "#00ff00", "#808080"]) {
      for (const vibrancy of [0, 0.6, 1]) {
        const canvas = { ...DEFAULT_CANVAS, stops: [{ hex: seed, x: 0.5, y: 0.5 }], vibrancy };
        const { tokens: t, canvasTokens: c } = deriveCanvasPaint(canvas, mode);
        for (const [name, alpha] of [
          ["--surface-secondary", 0.078],
          ["--surface-quaternary", 0.027],
        ] as const) {
          const neutral = compositeHex(t["--foreground"], alpha, t["--background"]);
          expect(c[name]).toBe(tintCanvasNeutral(neutral, canvas, mode));
          expect(Math.abs(hexToOklch(c[name]).L - hexToOklch(neutral).L)).toBeLessThan(0.005);
          expect(wcagContrast(t["--foreground"], c[name])).toBeGreaterThanOrEqual(4.5);
          expect(wcagContrast(t["--muted-foreground"], c[name])).toBeGreaterThanOrEqual(4.5);
          if (seed === "#808080") expect(hexToOklch(c[name]).C).toBeLessThan(0.002);
          else if (name === "--surface-secondary")
            expect(hexToOklch(c[name]).C).toBeGreaterThan(0.008);
        }
        expect(t["--background"]).toBe(mode === "dark" ? "#1e1e1e" : "#ffffff");
        expect(t["--foreground"]).toBe(mode === "dark" ? "#ededed" : "#272727");
      }
    }
  });

  it.each(["light", "dark"] as const)("%s keeps object hue independent of canvas placement and primaryIndex", (mode) => {
    for (const seed of ["#ff0000", "#00ff00", "#0000ff", "#808080"]) {
      const stops = [
        { hex: seed, x: 0, y: 1 },
        { hex: "#ffffff", x: 1, y: 0 },
        { hex: "#000000", x: 0.5, y: 0.5 },
      ];
      for (const vibrancy of [0, 0.6, 1]) {
        const base = { ...DEFAULT_CANVAS, stops, vibrancy };
        const expected = deriveCanvasPaint(base, mode);
        for (const primaryIndex of [0, 1, 2]) {
          const { tokens: t, canvasTokens: c } = deriveCanvasPaint(
            {
              ...base,
              primaryIndex,
              stops: stops.map((s) => ({ ...s, x: 1 - s.x, y: 1 - s.y })),
            },
            mode,
          );
          for (const name of ["--surface-secondary", "--surface-quaternary"] as const) {
            expect(c[name]).toBe(expected.canvasTokens[name]);
            for (const ink of [t["--foreground"], t["--muted-foreground"], c["--label-ink"]]) {
              expect(wcagContrast(ink, c[name])).toBeGreaterThanOrEqual(4.5);
            }
          }
        }
      }
    }
  });
});
