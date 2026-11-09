import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Button } from "./button";
import { PaneHeader } from "./pane-header";

const title = "A very long pane title that still names the complete source";

describe("PaneHeader", () => {
  it("centres identity and truncates the title inside a 28px header", () => {
    const html = renderToStaticMarkup(<PaneHeader identity={<svg />} title={title} />);
    expect(html).toContain("h-control-default");
    expect(html).toContain("items-center justify-center");
    expect(html).toContain(`title="${title}"`);
    expect(html).toContain("truncate");
    expect(html).not.toContain('data-slot="pane-header-actions"');
  });

  it("reveals actions instantly for pointer, keyboard, touch and an open menu", () => {
    const html = renderToStaticMarkup(
      <PaneHeader identity={<svg />} title={title} actions={<Button>Close</Button>} />,
    );
    for (const state of [
      "group-hover/pane:opacity-100",
      "group-focus-within/pane-header:opacity-100",
      "has-[[data-state=open]]:opacity-100",
      "[@media(hover:none)]:opacity-100",
    ])
      expect(html).toContain(state);
    expect(html.split('data-slot="pane-header-actions"')[1]?.split(">")[0]).not.toContain(
      "transition",
    );
    expect(html).not.toContain("backdrop");
  });
});
