import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { TicketFilesList } from "./ticket-files-panel";
import type { TicketFileRefRow, TicketWorktreeEntry } from "./ticket-files-model";

const noop = (_path: string): void => {};

describe("TicketFilesList", () => {
  it("renders referenced context and worktree files as flat sections", () => {
    const referenced: TicketFileRefRow[] = [
      { relPath: "src/rail.tsx", label: "rail.tsx", source: "body" },
      {
        relPath: ".volli/attachments/spec.png",
        label: "homepage mock",
        source: "attachment",
      },
    ];
    const worktree: TicketWorktreeEntry[] = [
      { relPath: "README.md", kind: "file" },
      { relPath: "src", kind: "directory" },
    ];
    const html = renderToStaticMarkup(
      <TicketFilesList
        referenced={referenced}
        worktree={worktree}
        onOpenFile={noop}
        onOpenDirectory={noop}
      />,
    );

    expect(html).toContain("Referenced");
    expect(html).toContain("rail.tsx");
    expect(html).toContain("homepage mock");
    expect(html).toContain("Worktree");
    expect(html).toContain("README.md");
    expect(html).toContain("src");
    expect(html).toContain('data-testid="ticket-files-list"');
    expect(html).not.toContain("<ul><ul>");
  });

  it("shows an empty hint when both sections are empty", () => {
    const html = renderToStaticMarkup(
      <TicketFilesList referenced={[]} worktree={[]} onOpenFile={noop} onOpenDirectory={noop} />,
    );
    expect(html).toContain("No referenced files yet");
  });
});
