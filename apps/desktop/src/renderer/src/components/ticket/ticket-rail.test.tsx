import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { TicketRailModeStrip } from "./ticket-rail";
import { availableRailModes, type TicketRailMode } from "./ticket-rail-model";

const noop = (_mode: TicketRailMode): void => {};

/** The strip only ever renders what the gate offers — see `availableRailModes`. */
const onDoc = availableRailModes({});
const onSessionTab = availableRailModes({ activeTabKind: "session" });

describe("TicketRailModeStrip", () => {
  it("renders four icon-mode buttons with Sessions active by default", () => {
    const html = renderToStaticMarkup(
      <TicketRailModeStrip mode="sessions" modes={onDoc} onSelectMode={noop} />,
    );

    expect(html).toContain('aria-label="Sessions"');
    expect(html).toContain('aria-label="Files"');
    expect(html).toContain('aria-label="Changes"');
    expect(html).toContain('aria-label="Properties"');
    expect(html).toContain('aria-pressed="true"');
    // Only Sessions is pressed when mode is sessions.
    expect(html.match(/aria-pressed="true"/g)?.length).toBe(1);
    expect(html).toContain('data-testid="ticket-rail-mode-sessions"');
    expect(html).toContain('data-testid="ticket-rail-mode-files"');
    expect(html).toContain('data-testid="ticket-rail-mode-changes"');
    expect(html).toContain('data-testid="ticket-rail-mode-properties"');
  });

  it("offers the Session mode only once a session tab is active", () => {
    const doc = renderToStaticMarkup(
      <TicketRailModeStrip mode="sessions" modes={onDoc} onSelectMode={noop} />,
    );
    expect(doc).not.toContain('data-testid="ticket-rail-mode-session"');

    const session = renderToStaticMarkup(
      <TicketRailModeStrip mode="session" modes={onSessionTab} onSelectMode={noop} />,
    );
    expect(session).toContain('data-testid="ticket-rail-mode-session"');
    expect(session).toContain('aria-label="Session"');
  });

  it("marks the active mode with a primary-tint affordance distinct from idle icons", () => {
    const html = renderToStaticMarkup(
      <TicketRailModeStrip mode="changes" modes={onDoc} onSelectMode={noop} />,
    );
    const activeIdx = html.indexOf('data-testid="ticket-rail-mode-changes"');
    const idleIdx = html.indexOf('data-testid="ticket-rail-mode-files"');
    expect(activeIdx).toBeGreaterThan(-1);
    expect(idleIdx).toBeGreaterThan(-1);

    // className is emitted before data-testid on the Button — look back at the
    // opening tag for the primary-tint affordance.
    const activeTag = html.slice(Math.max(0, activeIdx - 220), activeIdx + 40);
    const idleTag = html.slice(Math.max(0, idleIdx - 220), idleIdx + 40);
    expect(activeTag).toContain("bg-primary/15");
    expect(activeTag).toContain("text-primary");
    expect(activeTag).toContain("ring-primary/40");
    expect(idleTag).not.toContain("bg-primary/15");
    expect(idleTag).not.toContain("ring-primary/40");
  });
});
