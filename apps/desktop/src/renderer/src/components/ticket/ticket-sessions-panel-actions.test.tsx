import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { TicketSessionsPanel } from "./ticket-sessions-panel";

const noop = (): void => {};

function buttonTag(html: string, label: string): string {
  const labelOffset = html.indexOf(`aria-label="${label}"`);
  return html.slice(html.lastIndexOf("<button", labelOffset), html.indexOf(">", labelOffset) + 1);
}

describe("TicketSessionsPanel", () => {
  it("uses direct Chat and Terminal controls instead of a generic create menu", () => {
    const html = renderToStaticMarkup(
      <TicketSessionsPanel
        ticketId="ticket-6"
        creating={false}
        onNewSession={noop}
        onNewChat={noop}
        onActivateSession={noop}
        onActivateChat={noop}
      />,
    );

    expect(html).toContain('aria-label="New chat"');
    expect(html).toContain('aria-label="New terminal"');
    expect(html).not.toContain('aria-label="New session"');
    expect(html).not.toContain('aria-haspopup="menu"');
  });

  it("disables both direct creation controls while the ticket worktree is booting", () => {
    const html = renderToStaticMarkup(
      <TicketSessionsPanel
        ticketId="ticket-6"
        creating
        onNewSession={noop}
        onNewChat={noop}
        onActivateSession={noop}
        onActivateChat={noop}
      />,
    );

    expect(buttonTag(html, "New chat")).toContain('disabled=""');
    expect(buttonTag(html, "New terminal")).toContain('disabled=""');
  });
});
