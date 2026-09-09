import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import type { ChangeSetFile } from "@volli/shared";

import {
  TicketChangesList,
  toChangeListRow,
  WorktreeStateStrip,
  type ChangeListRow,
} from "./ticket-changes-panel";
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

describe("WorktreeStateStrip", () => {
  it("renders working, local, and remote state as one compact summary", () => {
    const html = renderToStaticMarkup(
      <WorktreeStateStrip
        status={{
          uncommitted: true,
          sequencerActive: false,
          aheadOfBase: 3,
          behindBase: 0,
          unpushed: 1,
        }}
      />,
    );

    expect(html).toContain('data-testid="ticket-changes-git-state"');
    expect(html).toContain("Working");
    expect(html).toContain("Changes");
    expect(html).toContain("Local");
    expect(html).toContain("3 commits");
    expect(html).toContain("Remote");
    expect(html).toContain("1 to push");
  });
});

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

    expect(html).toContain(">rail<");
    expect(html).toContain(">.tsx<");
    expect(html).toContain(">src<");
    expect(html).toContain("Modified");
    expect(html).toContain("Binary");
    expect(html).toContain("Conflicted");
    expect(html).toContain("← ");
    expect(html).toContain(">/old.ts<");
    expect(html).toContain(">new<");
    // Flat list — no nested tree markup.
    expect(html).not.toContain("<ul><ul>");
    expect(html).toContain('data-testid="ticket-changes-list"');
  });

  // THE LIST IS A LIST, NOT A LISTBOX (VC-311): an `option` may not hold
  // interactive descendants, and every row here holds three (the activation
  // target plus Copy/Open). The old `listbox`/`option` pair was a content-model
  // violation screen readers answer by flattening the row.
  it("draws a plain named list of list items with no selection widget roles", () => {
    const html = render(listRows([file({ path: "src/a.ts" })]));

    expect(html).not.toContain('role="listbox"');
    expect(html).not.toContain('role="option"');
    expect(html).not.toContain("aria-selected");
    expect(html).toContain('aria-label="Change Set"');
  });

  it("marks the focused row current, not selected, and only that row", () => {
    const rows = listRows([file({ path: "src/a.ts" }), file({ path: "src/b.ts" })]);
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <TicketChangesList rows={rows} focusPath="src/b.ts" onSelectRow={noop} />
      </TooltipProvider>,
    );

    expect(html).toContain('aria-current="true"');
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
    expect(html).toContain(
      'aria-label="Modified: src/b.ts, 1 insertion, 0 deletions" aria-current="true"',
    );
  });

  it("carries status, the FULL path, and counts in words in the row's name", () => {
    const html = render(
      listRows([
        file({
          path: "apps/desktop/src/renderer/src/components/split/split-view-divider.test.tsx",
          insertions: 11,
          deletions: 2,
        }),
      ]),
    );

    expect(html).toContain(
      'aria-label="Modified: apps/desktop/src/renderer/src/components/split/split-view-divider.test.tsx, 11 insertions, 2 deletions"',
    );
  });

  // The audit's indistinguishable pair: end-truncation ate the tail that
  // distinguishes them. Both halves of the cut are separate spans, and only
  // the head may truncate.
  it("protects the filename suffix and the parent's last segment from the cut", () => {
    const html = render(
      listRows([
        file({
          path: "apps/desktop/src/renderer/src/components/split/split-view-divider.test.tsx",
        }),
        file({ path: "apps/desktop/src/renderer/src/components/ui/split-view-divider.tsx" }),
      ]),
    );

    // Suffixes ride in shrink-0 spans; heads in truncating ones.
    expect(html).toContain(">.test.tsx<");
    expect(html).toContain(">.tsx<");
    expect(html).toContain(">/split<");
    expect(html).toContain(">/ui<");
    expect(html).toContain(">split-view-divider</span>");
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
    expect(html).toContain("No changes vs base");
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
