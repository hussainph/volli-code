import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ContextMenuItem } from "@renderer/components/ui/context-menu";
import { DropdownMenuItem } from "@renderer/components/ui/dropdown-menu";
import { NewSessionControl, newSessionMenuRows } from "./new-session-control";

const noop = (): void => {};

/** The `<button …>` open tag carrying `aria-label`, so attributes are read per half. */
function buttonTag(html: string, label: string): string {
  const labelOffset = html.indexOf(`aria-label="${label}"`);
  return html.slice(html.lastIndexOf("<button", labelOffset), html.indexOf(">", labelOffset) + 1);
}

interface ItemProps {
  children?: React.ReactNode;
  onSelect?(): void;
}

/**
 * Both menus are portalled and closed at rest, so static markup cannot see a
 * row. The control is hook-free, so the honest read is to call it and walk the
 * tree it returns — the same shape `context-menu.test.tsx` uses.
 */
function collect(node: React.ReactNode, type: React.ElementType): React.ReactElement<ItemProps>[] {
  const found: React.ReactElement<ItemProps>[] = [];
  for (const child of React.Children.toArray(node)) {
    if (!React.isValidElement(child)) continue;
    if (child.type === type) found.push(child as React.ReactElement<ItemProps>);
    found.push(...collect((child.props as ItemProps).children, type));
  }
  return found;
}

/** A menu row's own words, ignoring its icon and any shortcut glyph. */
function labelOf(item: React.ReactElement<ItemProps>): string {
  return React.Children.toArray(item.props.children)
    .filter((child) => typeof child === "string")
    .join("")
    .trim();
}

describe("NewSessionControl", () => {
  it("puts every kind behind one anchored plus, not a split button", () => {
    const html = renderToStaticMarkup(
      <NewSessionControl projectId="p1" disabled={false} onNewChat={noop} onNewTerminal={noop} />,
    );
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(buttonTag(html, "Open a tab")).toContain('aria-haspopup="menu"');
    expect(html).not.toContain('aria-label="New chat"');
    expect(html).not.toContain('data-slot="button-group"');
  });

  it("takes the chooser out of reach while a Session is booting", () => {
    const html = renderToStaticMarkup(
      <NewSessionControl projectId="p1" disabled onNewChat={noop} onNewTerminal={noop} />,
    );
    expect(buttonTag(html, "Open a tab")).toContain('disabled=""');
  });

  it("gathers chat, terminal and browser into the one menu, and drops skills", () => {
    let opened = 0;
    const handlers = {
      onNewChat: noop,
      onNewBrowser: () => (opened += 1),
      onNewTerminal: noop,
    };

    for (const [menu, type] of [
      ["dropdown", DropdownMenuItem],
      ["context", ContextMenuItem],
    ] as const) {
      const rows = collect(newSessionMenuRows(menu, handlers), type);
      // Sessions first, then the surface — the separator's distinction. Both
      // menus are the same offer reached two ways, so both are asked.
      expect(rows.map(labelOf)).toEqual(["Chat", "Terminal", "Browser"]);
      // Gone on purpose: a skill is a property of the chat you are about to
      // have, not a kind of thing to open.
      expect(rows.map(labelOf)).not.toContain("Chat with skill");

      // The row is wired, not decorative.
      rows.find((item) => labelOf(item) === "Browser")?.props.onSelect?.();
    }
    expect(opened).toBe(2);
  });

  it("keeps Browser inside the menu rather than beside it as a second button", () => {
    const html = renderToStaticMarkup(
      <NewSessionControl
        projectId="p1"
        disabled={false}
        onNewChat={noop}
        onNewBrowser={noop}
        onNewTerminal={noop}
      />,
    );

    // Offering Browser never adds a second target beside the chooser.
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).not.toContain('aria-label="New Browser Tab"');
  });

  it("offers no Browser row on a surface that cannot host one", () => {
    const handlers = { onNewChat: noop, onNewTerminal: noop };

    // An item is a promise the press has to keep, so a mount with no handler
    // shows no row at all rather than a dead one.
    expect(
      collect(newSessionMenuRows("dropdown", handlers), DropdownMenuItem).map(labelOf),
    ).toEqual(["Chat", "Terminal"]);
    expect(collect(newSessionMenuRows("context", handlers), ContextMenuItem).map(labelOf)).toEqual([
      "Chat",
      "Terminal",
    ]);
  });

  it("offers chat alone where terminals and Browser Tabs have nowhere to run (a cloud launch)", () => {
    for (const [menu, type] of [
      ["dropdown", DropdownMenuItem],
      ["context", ContextMenuItem],
    ] as const) {
      expect(collect(newSessionMenuRows(menu, { onNewChat: noop }), type).map(labelOf)).toEqual([
        "Chat",
      ]);
    }
  });

  it("announces ⌘T only where the chord starts what the control starts", () => {
    const quiet = renderToStaticMarkup(
      <NewSessionControl projectId="p1" disabled={false} onNewChat={noop} onNewTerminal={noop} />,
    );
    const onTheSurface = renderToStaticMarkup(
      <NewSessionControl
        projectId="p1"
        disabled={false}
        shortcuts
        onNewChat={noop}
        onNewTerminal={noop}
      />,
    );

    // The plus opens a menu; it must not claim the direct chat shortcut.
    // The menu rows retain that announcement in their existing scoped calls.
    expect(onTheSurface).not.toContain("aria-keyshortcuts");
    expect(quiet).not.toContain("aria-keyshortcuts");
  });

  it("says what it does where it is the only affordance on screen", () => {
    const strip = renderToStaticMarkup(
      <NewSessionControl
        projectId="p1"
        disabled={false}
        placement="strip"
        onNewChat={noop}
        onNewTerminal={noop}
      />,
    );
    const empty = renderToStaticMarkup(
      <NewSessionControl
        projectId="p1"
        disabled={false}
        placement="empty"
        onNewChat={noop}
        onNewTerminal={noop}
      />,
    );

    expect(strip).toContain('aria-label="Open a tab"');
    expect(strip).toContain('data-variant="ghost"');
    expect(strip).not.toContain("active:scale-");
    expect(empty).toContain('aria-label="Open a tab"');
    expect(empty).toContain('data-variant="default"');
  });
});
