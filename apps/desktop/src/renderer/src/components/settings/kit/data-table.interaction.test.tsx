// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { DataTable } from "./data-table";
it("makes every capped management row reachable by page and by complete-collection search", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const items = Array.from({ length: 1000 }, (_, i) => `FAKE_${String(i).padStart(4, "0")}`);
  const draw = (query = "") =>
    root.render(
      <DataTable
        label="Fake credentials"
        items={items}
        keyOf={(item) => item}
        columns={[{ key: "name", header: "Name", cell: (item) => <span>{item}</span> }]}
        search={(item) => item}
        query={query}
        maxItems={100}
        empty="No credentials"
      />,
    );
  try {
    await act(async () => draw());
    expect(host.querySelectorAll("tbody tr")).toHaveLength(100);
    const next = [...host.querySelectorAll("button")].find(
      (node) => node.textContent === "Next page",
    )!;
    for (let i = 0; i < 9; i++) await act(async () => next.click());
    expect(host.textContent).toContain("FAKE_0999");
    expect(next.disabled).toBe(true);
    expect(host.querySelectorAll("tbody tr")).toHaveLength(100);
    await act(async () => draw("0999"));
    expect(host.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(host.textContent).toContain("FAKE_0999");
    await act(async () => draw("missing"));
    expect(host.querySelectorAll("tbody tr")).toHaveLength(0);
    expect(host.textContent).toContain("No matching fake credentials");
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
