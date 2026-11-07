// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { DataTable } from "./data-table";

it("selects only visible rows and hands bulk actions only the matched selected set", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  let bulk: readonly { id: string }[] = [];
  function Table({ query }: { query: string }) {
    const [keys, onChange] = React.useState<ReadonlySet<string>>(new Set());
    return (
      <DataTable
        label="Resources"
        items={[{ id: "one" }, { id: "two" }]}
        keyOf={(i) => i.id}
        columns={[{ key: "name", header: "Name", cell: (i) => i.id }]}
        search={(i) => i.id}
        query={query}
        selection={{ keys, onChange, labelOf: (i) => i.id }}
        bulk={(items) => {
          bulk = items;
          return null;
        }}
        empty="Empty"
      />
    );
  }
  try {
    act(() => root.render(<Table query="one" />));
    act(() =>
      host.querySelector<HTMLButtonElement>('[aria-label="Select all visible rows"]')!.click(),
    );
    expect(bulk.map((i) => i.id)).toEqual(["one"]);
    act(() => root.render(<Table query="" />));
    expect(host.querySelector('[aria-label="Select two"]')!.getAttribute("data-state")).toBe(
      "unchecked",
    );
    expect(
      host.querySelector('[aria-label="Select all visible rows"]')!.getAttribute("data-state"),
    ).toBe("indeterminate");
    act(() => root.render(<Table query="two" />));
    expect(bulk).toEqual([]);
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
