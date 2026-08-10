import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { TicketSessionActions } from "./ticket-session-actions";

const noop = (): void => {};

describe("TicketSessionActions", () => {
  it("offers Chat before its Terminal companion without a generic create menu", () => {
    const html = renderToStaticMarkup(
      <TicketSessionActions disabled={false} onNewChat={noop} onNewTerminal={noop} />,
    );

    const chat = html.indexOf('aria-label="New chat"');
    const terminal = html.indexOf('aria-label="New terminal"');
    expect(chat).toBeGreaterThan(-1);
    expect(terminal).toBeGreaterThan(chat);
    expect(html).toContain('title="New chat"');
    expect(html).toContain('title="New terminal"');
    expect(html).not.toContain('aria-label="New session"');
    expect(html).not.toContain("menuitem");
  });

  it("disables both direct actions while either kind of Session is starting", () => {
    const html = renderToStaticMarkup(
      <TicketSessionActions disabled onNewChat={noop} onNewTerminal={noop} />,
    );

    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });
});
