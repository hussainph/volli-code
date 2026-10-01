import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { FilesNavigatorHeader } from "./navigator-header";
import { TooltipProvider } from "@renderer/components/ui/tooltip";

const noop = (): void => {};

function header(props: Partial<React.ComponentProps<typeof FilesNavigatorHeader>> = {}): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <FilesNavigatorHeader
        root="volli/VC-406-rail"
        cwd=""
        upTestId="ticket-files-up"
        filtering={false}
        query=""
        onToggleFilter={noop}
        onQueryChange={noop}
        onNavigateUp={noop}
        {...props}
      />
    </TooltipProvider>,
  );
}

describe("FilesNavigatorHeader (VC-406, revision 06)", () => {
  it("opens with the directory, not with a second name for the page", () => {
    const html = header({
      actions: <button type="button">New file</button>,
      attachmentMenu: <button type="button">Attachments</button>,
    });

    // The Files tab has already said the word; the header says the one thing
    // nothing else says — where the listing is.
    expect(html).not.toContain("Ticket files");
    expect(html).not.toContain("Project files");
    expect(html.indexOf("volli/VC-406-rail")).toBeLessThan(html.indexOf("New file"));
  });

  it("puts the folder action, the paperclip and the filter on that same line", () => {
    const html = header({
      actions: <button type="button">New file</button>,
      attachmentMenu: <button type="button">Attachments</button>,
    });

    expect(html.indexOf("New file")).toBeLessThan(html.indexOf("Attachments"));
    expect(html.indexOf("Attachments")).toBeLessThan(html.indexOf('aria-label="Filter files"'));
    // One row, so the three controls are siblings of the directory rather than
    // a second band under it.
    expect(html.match(/<header/g)?.length).toBe(1);
  });

  it("has no paperclip where there is no Ticket to attach to", () => {
    const html = header({ root: "Volli Code" });

    expect(html).toContain("Volli Code");
    expect(html).toContain('aria-label="Filter files"');
    expect(html).not.toContain("Attachments");
  });

  it("keeps the paperclip while a folder is open and the filter is up", () => {
    // The rule the header's geometry exists for: attachments belong to the
    // Ticket, so neither walking into a folder nor narrowing the listing may
    // take the menu away.
    const html = header({
      cwd: "apps/desktop",
      filtering: true,
      query: "rail",
      attachmentMenu: <button type="button">Attachments</button>,
    });

    expect(html).toContain("Attachments");
    expect(html).toContain('aria-label="Leave apps/desktop"');
    expect(html).toContain('value="rail"');
  });

  it("makes the folder's own name the way back out of it", () => {
    const root = header();
    const inside = header({ cwd: "src/renderer" });

    expect(root).toContain("volli/VC-406-rail");
    expect(root).not.toContain('data-testid="ticket-files-up"');
    expect(inside).toContain('data-testid="ticket-files-up"');
    expect(inside).not.toContain("volli/VC-406-rail");
  });

  it("draws the filter field only once it is opened, under the directory", () => {
    expect(header()).not.toContain('placeholder="Filter files…"');
    const open = header({ filtering: true, query: "panel" });

    expect(open).toContain('placeholder="Filter files…"');
    expect(open.indexOf("volli/VC-406-rail")).toBeLessThan(
      open.indexOf('placeholder="Filter files…"'),
    );
  });

  it("reserves nothing for the read: at rest the header is one line", () => {
    // `RailHeadingReadStatus` renders nothing when there is nothing to report,
    // and a null child of the column takes neither height nor gap — so a
    // resting navigator pays no empty band for a state it is in for half a
    // second a minute.
    const resting = header({ status: null });
    const reading = header({ status: <span data-testid="read-status">Reading…</span> });

    expect(resting).not.toContain("read-status");
    expect(reading).toContain("Reading…");
    // Under the directory it is about, not squeezed onto its line beside three
    // controls — at the 240px floor that line has no room for a fourth thing.
    expect(reading.indexOf("volli/VC-406-rail")).toBeLessThan(reading.indexOf("Reading…"));
    expect(reading.indexOf('aria-label="Filter files"')).toBeLessThan(reading.indexOf("Reading…"));
  });
});
