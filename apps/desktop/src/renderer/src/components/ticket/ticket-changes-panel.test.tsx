import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import type { ChangeSetFile } from "@volli/shared";

import { TicketChangesList } from "./ticket-changes-panel";
import { presentChangeRow, sortChangeSetFiles } from "./ticket-changes-model";

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

describe("TicketChangesList", () => {
  it("renders a compact flat list with filename leading and parent muted", () => {
    const files = sortChangeSetFiles([
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
    ]);
    const rows = files.map(presentChangeRow);
    const html = renderToStaticMarkup(
      <TicketChangesList rows={rows} focusPath={null} onSelectRow={noop} />,
    );

    expect(html).toContain("rail.tsx");
    expect(html).toContain("src");
    expect(html).toContain("+11 −2");
    expect(html).toContain("Modified");
    expect(html).toContain("Binary");
    expect(html).toContain("Conflicted");
    expect(html).toContain("src/old.ts");
    expect(html).toContain("new.ts");
    // Flat list — no nested tree markup.
    expect(html).not.toContain("<ul><ul>");
    expect(html).toContain('data-testid="ticket-changes-list"');
  });

  it("renders an empty state when there are no changes", () => {
    const html = renderToStaticMarkup(
      <TicketChangesList rows={[]} focusPath={null} onSelectRow={noop} />,
    );
    expect(html).toContain("No changes vs base");
  });

  it("says how many files the cap left out rather than silently dropping them", () => {
    const rows = [file({ path: "src/a.ts" })].map(presentChangeRow);
    const html = renderToStaticMarkup(
      <TicketChangesList rows={rows} focusPath={null} onSelectRow={noop} hiddenCount={4000} />,
    );
    expect(html).toContain('data-testid="ticket-changes-truncated"');
    expect(html).toContain("more files not shown");
  });

  it("has no trailing row when nothing was cut", () => {
    const rows = [file({ path: "src/a.ts" })].map(presentChangeRow);
    const html = renderToStaticMarkup(
      <TicketChangesList rows={rows} focusPath={null} onSelectRow={noop} />,
    );
    expect(html).not.toContain('data-testid="ticket-changes-truncated"');
  });
});
