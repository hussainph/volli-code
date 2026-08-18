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
