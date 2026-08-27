import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { TicketFilesList } from "./ticket-files-panel";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import type { FileNavigatorControls } from "@renderer/components/files/use-navigator-mutations";
import type { NavigatorEdit } from "@renderer/components/files/navigator-mutations";
import type { TicketFileRefRow, TicketWorktreeEntry } from "./ticket-files-model";

const noop = (_path: string): void => {};

/** A controller that only reports which field is open — enough for the drawing. */
function controlsWith(edit: NavigatorEdit): FileNavigatorControls {
  return {
    edit,
    startDraft: () => {},
    startRename: () => {},
    cancelEdit: () => {},
    commitDraft: () => {},
    commitRename: () => {},
    duplicate: () => {},
    remove: () => {},
  };
}

function render(
  referenced: TicketFileRefRow[],
  worktree: TicketWorktreeEntry[],
  controls?: FileNavigatorControls,
): string {
  // Row actions are tooltip triggers, and the real tree always has a provider
  // (SidebarProvider wraps the whole app).
  return renderToStaticMarkup(
    <TooltipProvider>
      <TicketFilesList
        projectId="project-1"
        ticketId="ticket-1"
        referenced={referenced}
        worktree={worktree}
        controls={controls}
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

describe("TicketFilesList inline edits (VC-191)", () => {
  it("opens a rename field in the row itself, and takes the row's own activation away", () => {
    const html = render(
      [],
      [{ relPath: "src/row.tsx", kind: "file" }],
      controlsWith({ kind: "rename", relPath: "src/row.tsx" }),
    );

    expect(html).toContain('aria-label="Rename row.tsx"');
    // An input inside the activating button would nest an interactive control
    // and preview the file on every click into the field.
    expect(html).not.toContain('aria-label="Open src/row.tsx in tab"');
  });

  it("leaves every other row alone while one is being renamed", () => {
    const html = render(
      [],
      [
        { relPath: "src/row.tsx", kind: "file" },
        { relPath: "src/list.tsx", kind: "file" },
      ],
      controlsWith({ kind: "rename", relPath: "src/row.tsx" }),
    );

    expect(html).toContain('aria-label="Open src/list.tsx in tab"');
    expect(html).not.toContain('aria-label="Rename list.tsx"');
  });

  it.each([
    ["file", "New file name", "New file"],
    ["directory", "New folder name", "New folder"],
  ] as const)("puts an unnamed %s row at the top of the listing", (entry, label, caption) => {
    const html = render(
      [],
      [{ relPath: "src/row.tsx", kind: "file" }],
      controlsWith({ kind: "draft", entry }),
    );

    expect(html).toContain(`aria-label="${label}"`);
    expect(html).toContain(caption);
    expect(html.indexOf(caption)).toBeLessThan(html.indexOf("row.tsx"));
  });

  it("draws the draft row in an EMPTY folder, where New File is most needed", () => {
    const html = render([], [], controlsWith({ kind: "draft", entry: "file" }));

    expect(html).toContain('aria-label="New file name"');
    expect(html).not.toContain("Nothing here yet");
  });
});
