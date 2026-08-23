import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Cell, DataTable } from "./data-table";

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
