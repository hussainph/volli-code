import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { TicketRailModeStrip } from "./ticket-rail";

const noop = (_mode: "sessions" | "files" | "changes" | "properties"): void => {};

describe("TicketRailModeStrip", () => {
  it("renders four icon-mode buttons with Sessions active by default", () => {
    const html = renderToStaticMarkup(<TicketRailModeStrip mode="sessions" onSelectMode={noop} />);

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

  it("marks the active mode with a primary-tint affordance distinct from idle icons", () => {
    const html = renderToStaticMarkup(<TicketRailModeStrip mode="changes" onSelectMode={noop} />);
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
