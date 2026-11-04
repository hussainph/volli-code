// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { Button } from "./button";
import { IdentityTile } from "./identity-tile";
import { Input } from "./input";
import { Progress } from "./progress";
import { Segmented } from "./segmented";

const css = readFileSync(resolve(import.meta.dirname, "../../globals.css"), "utf8");

describe("Glass primitives", () => {
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
