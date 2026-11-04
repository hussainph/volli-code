import * as React from "react";
import { KanbanIcon } from "@phosphor-icons/react/dist/csr/Kanban";
import { RowsIcon } from "@phosphor-icons/react/dist/csr/Rows";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { Button } from "./button";
import { Segmented } from "./segmented";

const options = [
  { key: "board", label: "Board", icon: KanbanIcon },
  { key: "list", label: "List", icon: RowsIcon, disabled: true },
] as const;

describe("Segmented", () => {
  it("draws a solid thumb and bare siblings on one track, without rewriting on reselect", () => {
    const writes: string[] = [];
    const tree = Segmented({
      ariaLabel: "View",
      value: "board",
      options,
      onChange: (key) => writes.push(key),
    });
    const buttons = React.Children.toArray(tree.props.children) as React.ReactElement<
      React.ComponentProps<typeof Button>
    >[];
    expect(buttons.map((button) => button.props.variant)).toEqual(["selected", "ghost"]);
    // The track is a borderless capsule; every member is a capsule thumb.
    expect(tree.props.className).toContain("rounded-segmented");
    expect(tree.props.className).toContain("bg-glass-1");
    expect(tree.props.className).not.toMatch(/\bborder\b/);
    expect(buttons.every((button) => button.props.className === "rounded-segmented")).toBe(true);
    expect(buttons.map((button) => button.props["aria-pressed"])).toEqual([true, false]);
    expect(buttons[1].props.disabled).toBe(true);
    buttons[0].props.onClick?.({} as React.MouseEvent<HTMLButtonElement>);
    expect(writes).toEqual([]);
  });

  it.each(["sm", "default"] as const)(
    "gives %s icon-only choices thumbs one rung under the track, and names",
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
