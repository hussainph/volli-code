// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { GLASS_MOTION } from "@renderer/lib/glass-motion";
import { Button } from "./button";
import { GlassSurface, PaperSurface } from "./surface";
import { IdentityTile } from "./identity-tile";
import { Input } from "./input";
import { Progress } from "./progress";
import { Segmented } from "./segmented";

const css = readFileSync(resolve(import.meta.dirname, "../../globals.css"), "utf8");

describe("Glass primitives", () => {
  it("preserves a composed surface's transport hooks", () => {
    for (const Surface of [GlassSurface, PaperSurface]) {
      const html = renderToStaticMarkup(
        <Surface asChild>
          <main data-slot="sidebar-inset" aria-label="Workspace">
            Content
          </main>
        </Surface>,
      );
      expect(html).toContain('data-slot="sidebar-inset"');
      expect(html).toContain('aria-label="Workspace"');
      expect(html).toContain("data-material=");
    }
    expect(css).toContain("backdrop-filter: blur(24px) saturate(1.8)");
    expect(css).toContain("background: var(--glass-rim)");
    expect(css).not.toContain('.glass[data-glass-static="true"]');
  });
  it("keeps JS compositor clocks aligned with the shared CSS recipes", () => {
    for (const [token, value] of [
      ["menu-in", GLASS_MOTION.menuIn],
      ["menu-out", GLASS_MOTION.menuOut],
      ["sheet", GLASS_MOTION.sheet],
    ] as const)
      expect(css).toContain(`--duration-${token}: ${value}ms`);
    expect(GLASS_MOTION.menuInSeconds * 1000).toBe(GLASS_MOTION.menuIn);
    expect(GLASS_MOTION.menuOutSeconds * 1000).toBe(GLASS_MOTION.menuOut);
    expect(GLASS_MOTION.sheetSeconds * 1000).toBe(GLASS_MOTION.sheet);
    expect(css).toContain(`--ease-out: ${GLASS_MOTION.easeOutCss}`);
  });
  it("keeps native button states and affordances across tonal, toolbar and inspector", () => {
    for (const variant of ["default", "toolbar", "inspector"] as const) {
      const html = renderToStaticMarkup(
        <Button variant={variant} disabled aria-busy="true" title="Save changes" aria-invalid>
          Save
        </Button>,
      );
      expect(html).toContain("disabled");
      expect(html).toContain('aria-busy="true"');
      expect(html).toContain('title="Save changes"');
      expect(html).toContain('aria-invalid="true"');
      expect(html).toContain("focus-visible:ring-ring");
    }
  });
  it("has one thumb, no keyboard transition, and unchanged accessible choices", () => {
    const tree = Segmented({
      ariaLabel: "Style",
      value: "modern",
      options: [
        { key: "macos", label: "macOS" },
        { key: "modern", label: "Modern" },
      ],
      onChange: () => {},
    });
    const target = { dataset: {} };
    tree.props.onPointerDown({ currentTarget: target });
    expect(target.dataset).toEqual({ pointerMotion: "true" });
    tree.props.onKeyDown({ currentTarget: target });
    expect(target.dataset).toEqual({ pointerMotion: "false" });
    expect(renderToStaticMarkup(tree)).toContain("--segment-index:1");
    expect(css).toContain('.segmented[data-pointer-motion="true"]::before');
    const track = css.slice(css.indexOf(".segmented {"), css.indexOf(".segmented::before"));
    const thumb = css.slice(
      css.indexOf(".segmented::before"),
      css.indexOf(".segmented[data-pointer-motion"),
    );
    expect(track).toContain("background: var(--fill-secondary)");
    expect(thumb).toContain("background: var(--control-face)");
    expect(thumb).toContain("box-shadow: var(--control-bezel-shadow)");
  });
  it("keeps material defaults below hover/selected utilities and composes focus rings", () => {
    expect(css).toMatch(/@layer components \{\s*\.glass-control/);
    const layer = css.slice(
      css.indexOf("@layer components {", css.indexOf("/* Material defaults")),
      css.indexOf(".segmented {"),
    );
    expect(layer).toContain(".inspector-popup");
    expect(layer).toContain(".search-capsule");
    expect(css).toContain("var(--tw-ring-offset-shadow, 0 0 transparent)");
    expect(css).toContain("var(--tw-ring-shadow, 0 0 transparent)");
  });
  it("uses outline-capsule search without losing the field label", () => {
    const html = renderToStaticMarkup(<Input variant="search" type="search" aria-label="Search" />);
    expect(html).toContain("search-capsule");
    expect(html).toContain('aria-label="Search"');
  });
  it("centres identities and clamps progress, including invalid values", () => {
    expect(renderToStaticMarkup(<IdentityTile aria-hidden>A</IdentityTile>)).toContain(
      'data-slot="identity-tile"',
    );
    expect(renderToStaticMarkup(<IdentityTile size="sm">A</IdentityTile>)).toContain(
      'data-size="sm"',
    );
    expect(css).toContain('.identity-tile[data-size="sm"]');
    // Root material values also need utility registrations for sheet callers.
    const themeUtilities = css.slice(css.indexOf("@theme inline {"), css.indexOf("@theme {"));
    expect(themeUtilities).toContain("--radius-sheet: 14px");
    expect(themeUtilities).toContain("--shadow-glass: var(--shadow-glass)");
    expect(themeUtilities).toContain("--shadow-glass-small: var(--shadow-glass-small)");
    for (const [value, expected] of [
      [-1, 0],
      [50, 50],
      [101, 100],
      [NaN, 0],
    ]) {
      const html = renderToStaticMarkup(<Progress value={value} aria-label="Download" />);
      expect(html).toContain(`aria-valuenow="${expected}"`);
      expect(html).toContain("var(--flow)");
    }
  });
  it("bounds blur, supports a tint boolean and morph opt-out, and gates motion", () => {
    expect(css).toContain('.material-floating[data-tint="true"]');
    expect(css).toContain('[data-glass-blur="off"]');
    expect(css).toContain(":is(.glass, .material-floating) :is(.glass, .material-floating)");
    expect(css).toContain("var(--bx, 0px) var(--by, 0px)");
    expect(css).toContain(':root[data-motion="off"]');
    for (const name of ["snappy", "smooth", "bouncy"])
      expect(css).toContain(`--spring-${name}: linear(`);
  });
});
