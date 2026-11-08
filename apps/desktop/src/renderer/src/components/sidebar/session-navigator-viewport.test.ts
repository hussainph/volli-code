import { expect, it } from "vite-plus/test";
import { sessionNavigatorRows } from "./session-navigator-rows";
import { navigatorViewportRows } from "./session-navigator-viewport";
import type { ActiveSessionRow } from "./active-session-listing";
it("bounds a thousand rows while retaining an independently focused row and the reach control", () => {
  const rows = sessionNavigatorRows({
    active: Array.from({ length: 1000 }, (_, i) => ({ id: `chat:${i}` })) as ActiveSessionRow[],
    previous: [],
    expanded: [],
    activeHeader: true,
    reach: true,
    selection: { focusedId: "chat:999", selectedIds: new Set(["chat:888"]) },
  });
  const first = navigatorViewportRows(rows, 0, 600);
  expect(first.length).toBeLessThan(22);
  expect(first.some((row) => row.focused)).toBe(true);
  expect(first.at(-1)?.kind).toBe("reach");
  const middle = navigatorViewportRows(rows, 24000, 24600);
  expect(middle.length).toBeLessThan(28);
  expect(middle.some((row) => row.kind === "active" && row.row.id === "chat:500")).toBe(true);
  expect(middle.some((row) => row.kind === "active" && row.row.id === "chat:888")).toBe(false);
});
