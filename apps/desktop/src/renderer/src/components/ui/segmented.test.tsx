// @vitest-environment jsdom
import * as React from "react";
import { BoardIcon, RowsIcon } from "@renderer/components/ui/icon";

import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";
import { Segmented } from "./segmented";

const options = [
  { key: "board", label: "Board", icon: BoardIcon },
  { key: "list", label: "List", icon: RowsIcon, disabled: true },
] as const;

describe("Segmented", () => {
  it("uses a shared thumb and preserves selected and disabled controls, without rewriting on reselect", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const writes: string[] = [];
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      await React.act(async () =>
        root.render(
          <Segmented
            ariaLabel="View"
            value="board"
            options={options}
            onChange={(key) => writes.push(key)}
          />,
        ),
      );
      const buttons = Array.from(host.querySelectorAll("button"));
      expect(buttons.map((button) => button.dataset.variant)).toEqual(["ghost", "ghost"]);
      expect(buttons.map((button) => button.getAttribute("aria-pressed"))).toEqual([
        "true",
        "false",
      ]);
      expect(buttons[1].disabled).toBe(true);
      await React.act(async () => buttons[0].click());
      expect(writes).toEqual([]);
    } finally {
      await React.act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  });

  it.each(["sm", "default"] as const)(
    "gives %s icon-only choices the matching 24/28px targets and names",
    (size) => {
      const html = renderToStaticMarkup(
        <Segmented
          ariaLabel="View"
          value="board"
          options={options}
          size={size}
          iconOnly
          onChange={() => {}}
        />,
      );
      expect(html).toContain(`data-size="${size === "sm" ? "icon-sm" : "icon"}"`);
      expect(html).toContain('title="Board"');
      expect(html).toContain('class="sr-only">Board');
      expect(html).toContain('title="List"');
    },
  );
});
