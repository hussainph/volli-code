import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { TicketSessionsPanel } from "./ticket-sessions-panel";

const noop = (): void => {};

function buttonTag(html: string, label: string): string {
  const labelOffset = html.indexOf(`aria-label="${label}"`);
  return html.slice(html.lastIndexOf("<button", labelOffset), html.indexOf(">", labelOffset) + 1);
}

function panel(creating: boolean): string {
  return renderToStaticMarkup(
    <TicketSessionsPanel
      ticketId="ticket-6"
      creating={creating}
      onNewSession={noop}
      onNewChat={noop}
      onActivateSession={noop}
      onActivateChat={noop}
    />,
  );
}

describe("TicketSessionsPanel", () => {
  it("starts a chat in one press and keeps the terminal behind the caret", () => {
    const html = panel(false);

    expect(html).toContain('aria-label="New chat"');
    expect(buttonTag(html, "New chat")).not.toContain('aria-haspopup="menu"');
    expect(buttonTag(html, "Other session kinds")).toContain('aria-haspopup="menu"');
    expect(html).not.toContain('aria-label="New session"');
  });

  it("announces the chord, which now starts what this control starts", () => {
    // This rail only exists inside a ticket, and ⌘T / ⌥⌘T resolve against the
    // surface in front (lib/new-session-shortcut.ts) — so inside a ticket they
    // mint a Session on that ticket, exactly as this control does. The rule is
    // unchanged ("only advertise a key that does what the item does"); the chord
    // is what moved.
    expect(buttonTag(panel(false), "New chat")).toContain('aria-keyshortcuts="Meta+T"');
  });

  it("disables both halves while the ticket worktree is booting", () => {
    const html = panel(true);

    expect(buttonTag(html, "New chat")).toContain('disabled=""');
    expect(buttonTag(html, "Other session kinds")).toContain('disabled=""');
  });
});
