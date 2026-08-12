import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { TicketDialogHost, useTicketDialogs } from "./ticket-dialog-host";

/**
 * What this harness can and cannot pin down. Renderer tests server-render once
 * (node env, no DOM), so effects never run, refs never attach, and re-renders
 * cannot be counted. The host's real load-bearing property — that its context
 * value never changes identity, so 150 memoized cards never re-render through
 * it — is therefore unprovable here; it is instead made structural, by leaving
 * the host no state to change (see the module doc) rather than by a memo whose
 * dependency list a later edit could widen. The same goes for the single-flight
 * archive gate and the deferred unmount, both of which live in state and effects
 * one level down. What IS assertable is the provider contract below.
 */
function Consumer() {
  useTicketDialogs();
  return <span>consumer</span>;
}

describe("TicketDialogHost", () => {
  it("passes children through untouched and mounts no visible dialog", () => {
    const html = renderToStaticMarkup(
      <TicketDialogHost projectId="p1">
        <div>board</div>
      </TicketDialogHost>,
    );
    // Both confirms start closed, so the host adds nothing to the board's markup.
    expect(html).toBe("<div>board</div>");
  });

  it("provides the request surface to a descendant", () => {
    const html = renderToStaticMarkup(
      <TicketDialogHost projectId="p1">
        <Consumer />
      </TicketDialogHost>,
    );
    expect(html).toBe("<span>consumer</span>");
  });

  it("throws rather than no-op'ing when a consumer renders outside the host", () => {
    expect(() => renderToStaticMarkup(<Consumer />)).toThrow(
      "useTicketDialogs must be used inside <TicketDialogHost>",
    );
  });
});
