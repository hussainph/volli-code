import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { TicketTabStrip } from "./ticket-tabs";

const noop = (): void => {};

function buttonTag(html: string, label: string): string {
  const labelOffset = html.indexOf(`aria-label="${label}"`);
  return html.slice(html.lastIndexOf("<button", labelOffset), html.indexOf(">", labelOffset) + 1);
}

describe("TicketTabStrip", () => {
  it("keeps direct Chat and Terminal creation beside Ticket tabs", () => {
    const html = renderToStaticMarkup(
      <TicketTabStrip
        tabs={[{ id: "doc", kind: "body", label: "VC-6" }]}
        activeTabId="doc"
        creating={false}
        onSelectTab={noop}
        onCloseTab={noop}
        onRenameSessionTab={noop}
        onNewSession={noop}
        onNewChat={noop}
        canFocusTerminal={false}
        onEnterTerminalFocus={noop}
      />,
    );

    expect(html).toContain('aria-label="New chat"');
    expect(html).toContain('aria-label="New terminal"');
    expect(html).not.toContain('aria-label="New session"');
    expect(html).not.toContain('aria-haspopup="menu"');
  });

  it("disables both direct creation controls while a ticket session is booting", () => {
    const html = renderToStaticMarkup(
      <TicketTabStrip
        tabs={[{ id: "doc", kind: "body", label: "VC-6" }]}
        activeTabId="doc"
        creating
        onSelectTab={noop}
        onCloseTab={noop}
        onRenameSessionTab={noop}
        onNewSession={noop}
        onNewChat={noop}
        canFocusTerminal={false}
        onEnterTerminalFocus={noop}
      />,
    );

    expect(buttonTag(html, "New chat")).toContain('disabled=""');
    expect(buttonTag(html, "New terminal")).toContain('disabled=""');
  });
});
