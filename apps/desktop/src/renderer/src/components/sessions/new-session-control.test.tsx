import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { NewSessionControl } from "./new-session-control";

const noop = (): void => {};

/** The `<button …>` open tag carrying `aria-label`, so attributes are read per half. */
function buttonTag(html: string, label: string): string {
  const labelOffset = html.indexOf(`aria-label="${label}"`);
  return html.slice(html.lastIndexOf("<button", labelOffset), html.indexOf(">", labelOffset) + 1);
}

describe("NewSessionControl", () => {
  it("puts chat on the press and the other kinds behind a separate caret half", () => {
    const html = renderToStaticMarkup(
      <NewSessionControl disabled={false} onNewChat={noop} onNewTerminal={noop} />,
    );

    // Two buttons, not one: the label half commits, the caret half opens.
    expect(html.match(/<button/g)).toHaveLength(2);
    expect(buttonTag(html, "New chat")).not.toContain('aria-haspopup="menu"');
    expect(buttonTag(html, "Other session kinds")).toContain('aria-haspopup="menu"');
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
    expect(buttonTag(html, "Other session kinds")).toContain('disabled=""');
  });

  it("announces ⌘T only where the chord starts what the control starts", () => {
    const scoped = renderToStaticMarkup(
      <NewSessionControl disabled={false} onNewChat={noop} onNewTerminal={noop} />,
    );
    const global = renderToStaticMarkup(
      <NewSessionControl disabled={false} shortcuts onNewChat={noop} onNewTerminal={noop} />,
    );

    // ⌘T is global (lib/new-session-shortcut.ts), so a ticket-scoped mount
    // claiming it would be teaching a Session into the wrong owner.
    expect(scoped).not.toContain("aria-keyshortcuts");
    expect(global).toContain('aria-keyshortcuts="Meta+T"');
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
