import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Icon, SearchIcon } from "./icon";

describe("shared symbols", () => {
  it("draws the semantic free rounded glyph with inherited ink and preserves its label", () => {
    const html = renderToStaticMarkup(<SearchIcon aria-label="Search files" className="size-4" />);
    expect(html).toContain('aria-label="Search files"');
    expect(html).toContain('viewBox="0 0 24 24"');
    expect(html).toContain('fill="none"');
    expect(html).toContain('stroke="currentColor"');
    expect(html).toContain('stroke-width="1.5"');
    expect(html).not.toContain("aria-hidden");
  });

  it("keeps caller sizing, hidden semantics and SVG attributes", () => {
    const html = renderToStaticMarkup(
      <Icon name="close" size={14} aria-hidden="true" data-slot="close" />,
    );
    expect(html).toContain('width="14" height="14"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('data-slot="close"');
  });

  it("steps up the small-size stroke and permits the deliberate heavier stroke", () => {
    expect(renderToStaticMarkup(<SearchIcon size={12} />)).toContain("--icon-stroke:2.25");
    expect(renderToStaticMarkup(<SearchIcon size={16} />)).not.toContain("--icon-stroke");
    expect(renderToStaticMarkup(<SearchIcon size={16} strokeWidth={2.25} />)).toContain(
      "--icon-stroke:2.25",
    );
    expect(renderToStaticMarkup(<SearchIcon size={12} strokeWidth={1.5} />)).toContain(
      "--icon-stroke:1.5",
    );
  });

  it("accepts a native SVG ref without adding a wrapper element", () => {
    const ref = createRef<SVGSVGElement>();
    expect(renderToStaticMarkup(<SearchIcon ref={ref} />)).toMatch(/^<svg.*<\/svg>$/);
  });
});
