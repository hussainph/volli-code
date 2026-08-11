import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { TicketTabStrip } from "./ticket-tabs";

const noop = (): void => {};

function buttonTag(html: string, label: string): string {
  const labelOffset = html.indexOf(`aria-label="${label}"`);
  return html.slice(html.lastIndexOf("<button", labelOffset), html.indexOf(">", labelOffset) + 1);
}

function strip(creating: boolean): string {
  return renderToStaticMarkup(
    <TicketTabStrip
      tabs={[{ id: "doc", kind: "body", label: "VC-6" }]}
      activeTabId="doc"
      creating={creating}
      onSelectTab={noop}
      onCloseTab={noop}
      onRenameSessionTab={noop}
      onNewSession={noop}
      onNewChat={noop}
      canFocusTerminal={false}
      onEnterTerminalFocus={noop}
    />,
  );
}

describe("TicketTabStrip", () => {
  it("keeps one-press chat creation beside Ticket tabs", () => {
    const html = strip(false);

    expect(html).toContain('aria-label="New chat"');
    expect(buttonTag(html, "New chat")).not.toContain('aria-haspopup="menu"');
    expect(buttonTag(html, "Other session kinds")).toContain('aria-haspopup="menu"');
    expect(html).not.toContain('aria-label="New session"');
  });

  it("does not claim the global ⌘T for a ticket-scoped control", () => {
    expect(strip(false)).not.toContain("aria-keyshortcuts");
  });

  it("disables both halves while a ticket session is booting", () => {
    const html = strip(true);

    expect(buttonTag(html, "New chat")).toContain('disabled=""');
    expect(buttonTag(html, "Other session kinds")).toContain('disabled=""');
  });

  it("does not pretend the terminal-focus corner is a toggle", () => {
    // It is a one-way action: entering focus unmounts this strip, so the
    // control can never be drawn pressed.
    expect(buttonTag(strip(false), "Enter terminal focus")).not.toContain("aria-pressed");
  });
});
