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
});
