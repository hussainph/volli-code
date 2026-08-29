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
      projectId="project-1"
      ticketId="ticket-1"
      tabs={[{ id: "doc", kind: "body", label: "VC-6" }]}
      activeTabId="doc"
      creating={creating}
      onSelectTab={noop}
      onCloseTab={noop}
      onRenameSessionTab={noop}
      onNewSession={noop}
      onNewChat={noop}
      onNewBrowser={noop}
      railCollapsed={railCollapsed}
      onToggleRail={noop}
    />,
  );
}

describe("TicketTabStrip", () => {
  it("keeps one-press chat creation on the strip", () => {
    const html = strip(false);

    expect(html).toContain('aria-label="New chat"');
    expect(buttonTag(html, "New chat")).not.toContain('aria-haspopup="menu"');
    expect(buttonTag(html, "Other session kinds")).toContain('aria-haspopup="menu"');
    expect(html).not.toContain('aria-label="New session"');
  });

  it("offers a Browser Tab from the same trailing cluster", () => {
    expect(strip(false)).toContain('aria-label="New Browser Tab"');
  });

  it("draws a live-titled, closable Browser Tab", () => {
    const html = renderToStaticMarkup(
      <TicketTabStrip
        projectId="project-1"
        ticketId="ticket-1"
        tabs={[
          { id: "doc", kind: "body", label: "VC-6" },
          {
            id: "browser:tab-7",
            kind: "browser",
            label: "Volli docs",
            browserTabId: "tab-7",
            loading: true,
          },
        ]}
        activeTabId="browser:tab-7"
        creating={false}
        onSelectTab={noop}
        onCloseTab={noop}
        onRenameSessionTab={noop}
        onNewSession={noop}
        onNewChat={noop}
        onNewBrowser={noop}
        railCollapsed={false}
        onToggleRail={noop}
      />,
    );

    expect(html).toContain('data-testid="ticket-browser-tab"');
    expect(html).toContain("Volli docs");
    expect(html).toContain('aria-label="Close Volli docs"');
  });

  it("puts creation in the trailing action cluster, out of the tab scroller", () => {
    // The whole of issue #3: the control used to ride INSIDE the scrolling tab
    // cluster, immediately after the last tab, where it wore a tab's silhouette
    // — same row, same baseline, and a ghost hover surface that in dark mode is
    // the same token an inactive tab hovers to. Tabs are places; the things past
    // the divider act on them. The divided cluster must come AFTER the tablist's
    // scroller closes, or the control is back inside the population it is trying
    // not to belong to.
    const html = strip(false);
    const scroller = html.indexOf("overflow-x-auto");
    const divider = html.indexOf("border-l");
    const control = html.indexOf('aria-label="New chat"');

    expect(scroller).toBeGreaterThan(-1);
    expect(divider).toBeGreaterThan(scroller);
    expect(control).toBeGreaterThan(divider);
  });

  it("announces the chord, which now starts what this control starts", () => {
    // ⌘T / ⌥⌘T resolve against the surface in front (lib/new-session-shortcut.ts),
    // so inside a ticket they mint a Session on THAT ticket — exactly what this
    // control mints. The rule is still "a menu may only advertise a key that does
    // what the item does"; what changed is that this mount now satisfies it.
    expect(buttonTag(strip(false), "New chat")).toContain('aria-keyshortcuts="Meta+T"');
  });

  it("disables both halves while a ticket session is booting", () => {
    const html = strip(true);

    expect(buttonTag(html, "New chat")).toContain('disabled=""');
    expect(buttonTag(html, "Other session kinds")).toContain('disabled=""');
  });

  it("puts the details-rail toggle in the corner, above the pane it collapses", () => {
    expect(strip(false)).toContain('aria-label="Hide details rail"');
    expect(strip(false, true)).toContain('aria-label="Show details rail"');
    // Terminal focus is drawn on the terminal PANE now (session-split-layout.tsx),
    // not on this strip and not on the chrome band: it acts on one pane, so it
    // lives on that pane and cannot appear where a terminal isn't.
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
