import * as React from "react";
import { CodeIcon } from "@phosphor-icons/react/dist/csr/Code";
import { describe, expect, it } from "vite-plus/test";

import { ContextMenuItem, ContextMenuSubTrigger } from "./context-menu";

function renderedIconWeight(subject: React.ReactElement): unknown {
  const icon = React.Children.toArray(
    (subject.props as { children?: React.ReactNode }).children,
  )[0];
  if (!React.isValidElement(icon)) throw new Error("Expected a menu icon");
  return (icon.props as { weight?: unknown }).weight;
}

describe("ContextMenu icons", () => {
  it("permits an explicit filled treatment for a surface that requires it", () => {
    expect(
      renderedIconWeight(
        ContextMenuItem({ icon: CodeIcon, iconWeight: "fill", children: "Open in VS Code" }),
      ),
    ).toBe("fill");
    expect(
      renderedIconWeight(
        ContextMenuSubTrigger({ icon: CodeIcon, iconWeight: "fill", children: "Open in…" }),
      ),
    ).toBe("fill");
  });
});
