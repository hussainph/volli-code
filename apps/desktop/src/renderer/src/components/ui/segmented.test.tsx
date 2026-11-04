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
  it("uses a shared thumb and preserves selected and disabled controls, without rewriting on reselect", () => {
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
    expect(buttons.map((button) => button.props.variant)).toEqual(["ghost", "ghost"]);
    expect(buttons.map((button) => button.props["aria-pressed"])).toEqual([true, false]);
    expect(buttons[1].props.disabled).toBe(true);
    buttons[0].props.onClick?.({
      currentTarget: { parentElement: null },
      detail: 0,
    } as React.MouseEvent<HTMLButtonElement>);
    expect(writes).toEqual([]);
  });

  it.each(["sm", "default"] as const)(
    "gives %s icon-only choices larger targets and names",
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
      expect(html).toContain(`data-size="${size === "sm" ? "icon" : "icon-lg"}"`);
      expect(html).toContain('title="Board"');
      expect(html).toContain('class="sr-only">Board');
      expect(html).toContain('title="List"');
    },
  );
});
