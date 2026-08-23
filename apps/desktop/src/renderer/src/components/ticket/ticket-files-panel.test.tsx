import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { TicketFilesList } from "./ticket-files-panel";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import type { TicketFileRefRow, TicketWorktreeEntry } from "./ticket-files-model";

const noop = (_path: string): void => {};

function render(referenced: TicketFileRefRow[], worktree: TicketWorktreeEntry[]): string {
  // Row actions are tooltip triggers, and the real tree always has a provider
  // (SidebarProvider wraps the whole app).
  return renderToStaticMarkup(
    <TooltipProvider>
      <TicketFilesList
        projectId="project-1"
        ticketId="ticket-1"
        referenced={referenced}
        worktree={worktree}
        onPreviewFile={noop}
        onPinFile={noop}
        onOpenDirectory={noop}
      />
    </TooltipProvider>,
  );
}

describe("TicketFilesList", () => {
  it("renders worktree entries and referenced context as one flat list", () => {
    const html = render(
      [
        { relPath: "src/rail.tsx", label: "rail.tsx", source: "body" },
        { relPath: ".volli/attachments/spec.png", label: "homepage mock", source: "attachment" },
      ],
      [
        { relPath: "README.md", kind: "file" },
        { relPath: "src", kind: "directory" },
      ],
    );

    expect(html).toContain("rail.tsx");
    expect(html).toContain("homepage mock");
    expect(html).toContain("README.md");
    expect(html).toContain('data-testid="ticket-files-list"');
    // One list, not a section per kind — the row's own sub-line says which
    // rows are referenced context.
    expect(html).toContain("Referenced ·");
    expect(html.match(/<ul/g)?.length).toBe(1);
    expect(html).not.toContain("<ul><ul>");
  });

  it("puts the worktree first and referenced context after it", () => {
    const html = render(
      [{ relPath: "docs/DESIGN.md", label: "DESIGN.md", source: "body" }],
      [{ relPath: "README.md", kind: "file" }],
    );

    expect(html.indexOf("README.md")).toBeLessThan(html.indexOf("DESIGN.md"));
  });

  it("marks a directory with a trailing slash and no open-in-tab action", () => {
    const html = render([], [{ relPath: "src", kind: "directory" }]);

    expect(html).toContain("src/");
    expect(html).not.toContain('aria-label="Open src in tab"');
  });

  it("shows an empty hint when there is nothing to list", () => {
    expect(render([], [])).toContain("Nothing here yet");
  });
});
