import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import type { ChangeSetFile } from "@volli/shared";

import { TicketChangesList, toChangeListRow, type ChangeListRow } from "./ticket-changes-panel";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { sortChangeSetFiles } from "./ticket-changes-model";
import { EMPTY_CHANGE_RECENCY_STATE } from "./ticket-change-recency";

function file(overrides: Partial<ChangeSetFile> & Pick<ChangeSetFile, "path">): ChangeSetFile {
  return {
    status: "modified",
    insertions: 1,
    deletions: 0,
    binary: false,
    ...overrides,
  };
}

const noop = (_path: string): void => {};

/** Row actions are tooltip triggers; the real tree always has a provider. */
function render(rows: readonly ChangeListRow[], props: { hiddenCount?: number } = {}): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <TicketChangesList rows={rows} focusPath={null} onSelectRow={noop} {...props} />
    </TooltipProvider>,
  );
}

function listRows(files: readonly ChangeSetFile[]): ChangeListRow[] {
  return sortChangeSetFiles(files).map((f) => toChangeListRow(f, EMPTY_CHANGE_RECENCY_STATE));
}

describe("TicketChangesList", () => {
  it("renders a compact flat list with filename leading and parent muted", () => {
    const html = render(
      listRows([
        file({ path: "src/rail.tsx", insertions: 11, deletions: 2 }),
        file({
          path: "assets/logo.png",
          status: "added",
          insertions: null,
          deletions: null,
          binary: true,
        }),
        file({
          path: "src/new.ts",
          previousPath: "src/old.ts",
          status: "renamed",
          insertions: 0,
          deletions: 0,
        }),
        file({ path: "conflicted.ts", status: "conflicted", insertions: 1, deletions: 1 }),
      ]),
    );

    expect(html).toContain("rail.tsx");
    expect(html).toContain("src");
    expect(html).toContain("Modified");
    expect(html).toContain("Binary");
    expect(html).toContain("Conflicted");
    expect(html).toContain("src/old.ts");
    expect(html).toContain("new.ts");
    // Flat list — no nested tree markup.
    expect(html).not.toContain("<ul><ul>");
    expect(html).toContain('data-testid="ticket-changes-list"');
  });

  // The two halves are separate marks in separate inks, so they must not be
  // rendered from one joined string.
  it("colours insertions and deletions as two spans", () => {
    const html = render(listRows([file({ path: "src/rail.tsx", insertions: 11, deletions: 2 })]));

    expect(html).toContain(">+11<");
    expect(html).toContain(">−2<");
    expect(html).not.toContain("+11 −2");
  });

  it("gives every Change Set status a glyph", () => {
    for (const status of [
      "added",
      "modified",
      "deleted",
      "renamed",
      "untracked",
      "conflicted",
    ] as const) {
      const html = render(listRows([file({ path: "a.ts", status })]));
      expect(html).toContain("<svg");
    }
  });

  it("renders a framed empty state when there are no changes", () => {
    const html = render([]);
    expect(html).toContain("No changes from base");
    expect(html).toContain("The branch is up to date.");
  });

  it("says how many files the cap left out rather than silently dropping them", () => {
    const html = render(listRows([file({ path: "src/a.ts" })]), { hiddenCount: 4000 });
    expect(html).toContain('data-testid="ticket-changes-truncated"');
    expect(html).toContain("more files not shown");
  });

  it("has no trailing row when nothing was cut", () => {
    const html = render(listRows([file({ path: "src/a.ts" })]));
    expect(html).not.toContain('data-testid="ticket-changes-truncated"');
  });

  it("renders updated awareness as visible text with an accessible explanation", () => {
    const html = render([
      {
        ...toChangeListRow(file({ path: "src/ticket.tsx" }), EMPTY_CHANGE_RECENCY_STATE),
        updatedLabel: "Updated",
        updatedDescription: "Updated since you last opened this file",
      },
    ]);

    expect(html).toContain(">Updated<");
    expect(html).toContain('aria-label="Updated since you last opened this file"');
  });
});
