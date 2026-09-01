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
  it("puts chat on the press and the other kinds behind a separate caret half", () => {
    const html = renderToStaticMarkup(
      <NewSessionControl disabled={false} onNewChat={noop} onNewTerminal={noop} />,
    );

    // Two buttons, not one: the label half commits, the caret half opens.
    expect(html.match(/<button/g)).toHaveLength(2);
    expect(buttonTag(html, "New chat")).not.toContain('aria-haspopup="menu"');
    expect(buttonTag(html, "Other things to open")).toContain('aria-haspopup="menu"');
    // The word is the target as much as the label — a terminal is two presses
    // and never has a peer control beside the default.
    expect(html).toContain("Chat");
    expect(html).not.toContain('aria-label="New terminal"');
  });

  it("takes both halves out of reach while a Session of either kind is booting", () => {
    const html = renderToStaticMarkup(
      <NewSessionControl disabled onNewChat={noop} onNewTerminal={noop} />,
    );

    expect(buttonTag(html, "New chat")).toContain('disabled=""');
    expect(buttonTag(html, "Other things to open")).toContain('disabled=""');
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
        disabled={false}
        onNewChat={noop}
        onNewBrowser={noop}
        onNewTerminal={noop}
      />,
    );

    // Still exactly the two halves of one pill. Offering a Browser Tab must not
    // grow a third target in the strip — that standalone button is the shape
    // this menu replaced.
    expect(html.match(/<button/g)).toHaveLength(2);
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

  it("announces ⌘T only where the chord starts what the control starts", () => {
    const quiet = renderToStaticMarkup(
      <NewSessionControl disabled={false} onNewChat={noop} onNewTerminal={noop} />,
    );
    const onTheSurface = renderToStaticMarkup(
      <NewSessionControl disabled={false} shortcuts onNewChat={noop} onNewTerminal={noop} />,
    );

    // ⌘T is CONTEXT-SENSITIVE (lib/new-session-shortcut.ts): it resolves against
    // the surface in front, so inside a ticket it mints a ticket Session and on
    // Home's strip a ticketless one. A control mounted ON one of those
    // surfaces starts exactly what the chord starts, and says so — which is why
    // both the ticket strip and Home's strip pass `shortcuts`. (The menus
    // carry the glyphs too, but they are portalled and closed at rest, so the
    // press half's `aria-keyshortcuts` is what static markup can be asked about.)
    expect(onTheSurface).toContain('aria-keyshortcuts="Meta+T"');
    // The flag still has an off position, and that is the whole rule: a menu may
    // only advertise a key that does what the item does. A mount that ever
    // appears where the chord resolves to some OTHER owner must stay quiet.
    expect(quiet).not.toContain("aria-keyshortcuts");
  });

  it("says what it does where it is the only affordance on screen", () => {
    const strip = renderToStaticMarkup(
      <NewSessionControl
        disabled={false}
        placement="strip"
        onNewChat={noop}
        onNewTerminal={noop}
      />,
    );
    const empty = renderToStaticMarkup(
      <NewSessionControl
        disabled={false}
        placement="empty"
        onNewChat={noop}
        onNewTerminal={noop}
      />,
    );

    expect(strip).toContain(">Chat<");
    expect(strip).toContain('data-variant="ghost"');
    expect(empty).toContain(">New chat<");
    expect(empty).toContain('data-variant="default"');
  });
});
