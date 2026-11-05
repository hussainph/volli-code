import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { CodeIcon } from "./icon";
import { ContextMenuItem, ContextMenuSubTrigger } from "./context-menu";

function renderedIcon(subject: React.ReactElement): string {
  const icon = React.Children.toArray(
    (subject.props as { children?: React.ReactNode }).children,
  )[0];
  if (!React.isValidElement(icon)) throw new Error("Expected a menu icon");
  return renderToStaticMarkup(icon);
}

describe("ContextMenu icons", () => {
  it("requires a neighbouring shared outline symbol, hidden from the action's name", () => {
    for (const subject of [
      ContextMenuItem({ icon: CodeIcon, children: "Open in VS Code" }),
      ContextMenuSubTrigger({ icon: CodeIcon, children: "Open in…" }),
    ]) {
      const html = renderedIcon(subject);
      expect(html).toContain('aria-hidden="true"');
      expect(html).toContain('fill="none"');
      expect(html).toContain('stroke="currentColor"');
      expect(html).toContain('stroke-width="1.5"');
    }
  });
});
