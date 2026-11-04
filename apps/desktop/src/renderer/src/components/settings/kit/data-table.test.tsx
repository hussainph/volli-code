import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { TooltipProvider } from "@renderer/components/ui/tooltip";

import { actionsColumnWidth, Cell, DataTable } from "./data-table";

const activeSourceFilter = {
  label: "Filter by source",
  value: "personal",
  isFiltering: true,
  onChange: () => {},
  options: [
    { value: "all", label: "All sources" },
    { value: "project", label: "This project" },
    { value: "personal", label: "Personal" },
  ],
};

describe("DataTable", () => {
  it("keeps an active filter available when it excludes every row", () => {
    const html = renderToStaticMarkup(
      <DataTable
        label="Commands available to this project"
        items={[]}
        keyOf={(command: { name: string }) => command.name}
        columns={[
          {
            key: "name",
            header: "Command",
            cell: (command: { name: string }) => <Cell>/{command.name}</Cell>,
          },
        ]}
        filter={activeSourceFilter}
        empty="No commands yet."
        noResults="No commands match."
      />,
    );

    expect(html).toContain('aria-label="Filter by source"');
    expect(html).toContain("No commands match.");
    expect(html).not.toContain("No commands yet.");
  });
});

describe("Cell", () => {
  it("keeps a plain cell's whole value on its title", () => {
    const html = renderToStaticMarkup(<Cell muted>Personal</Cell>);
    expect(html).toContain('title="Personal"');
    expect(html).not.toContain("value-reveal");
  });

  it("reveals an identity cell through ValueReveal instead of a native title", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <Cell strong reveal="Skill">
          a-very-long-skill-name
        </Cell>
      </TooltipProvider>,
    );
    expect(html).toContain('data-slot="value-reveal"');
    expect(html).toContain('aria-label="Skill · a-very-long-skill-name"');
    expect(html).not.toContain("title=");
  });
});

describe("actionsColumnWidth", () => {
  it("measures glyph actions, the gaps between them, and the cell's two insets", () => {
    expect(actionsColumnWidth(1)).toBe(
      "calc(1 * var(--spacing-control-default) + 4 * var(--spacing))",
    );
    expect(actionsColumnWidth(2)).toBe(
      "calc(2 * var(--spacing-control-default) + 6 * var(--spacing))",
    );
  });
});
