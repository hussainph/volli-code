import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { TicketTabStrip } from "./ticket-tabs";

const noop = (): void => {};

function buttonTag(html: string, label: string): string {
  const labelOffset = html.indexOf(`aria-label="${label}"`);
  return html.slice(html.lastIndexOf("<button", labelOffset), html.indexOf(">", labelOffset) + 1);
}

function strip(creating: boolean, railCollapsed = false): string {
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
      railCollapsed={railCollapsed}
      onToggleRail={noop}
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

  it("puts the details-rail toggle in the corner, above the pane it collapses", () => {
    expect(strip(false)).toContain('aria-label="Hide details rail"');
    expect(strip(false, true)).toContain('aria-label="Show details rail"');
    // Terminal focus left this strip for the chrome band, where entering and
    // exiting are one button rather than two controls 40px apart.
    expect(strip(false)).not.toContain("terminal focus");
  });

  it("never disables the corner: the rail is always there to collapse", () => {
    // The old occupant was conditional on the active tab's kind, which is what
    // made the corner need a reserved slot and a fade in the first place.
    expect(buttonTag(strip(false), "Hide details rail")).not.toContain('disabled=""');
  });

  it("does not double up state on the corner control", () => {
    // The label already says which way the button goes; `aria-pressed` beside
    // it announces "Hide details rail, pressed" while the rail is showing.
    expect(buttonTag(strip(false), "Hide details rail")).not.toContain("aria-pressed");
  });
});
