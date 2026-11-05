import { describe, expect, it } from "vite-plus/test";
import type {
  ActiveSessionRow,
  PreviousSessionRow,
  PreviousListingEntry,
} from "./active-session-listing";
import { navigatorRowDomId, sessionNavigatorRows } from "./session-navigator-rows";

describe("flat fixed-height Session navigator", () => {
  it("models bands, disclosures and visible children in one stable offset order at scale", () => {
    const active = Array.from({ length: 1000 }, (_, i) => ({
      id: `chat:active-${i}`,
    })) as ActiveSessionRow[];
    const children = Array.from({ length: 1000 }, (_, i) => ({
      id: `chat:previous-${i}`,
    })) as PreviousSessionRow[];
    const previous = [{ kind: "ticket", id: "ticket", rows: children }] as PreviousListingEntry[];
    const closed = sessionNavigatorRows({
      active,
      previous,
      expanded: [],
      activeHeader: true,
      reach: true,
    });
    const open = sessionNavigatorRows({
      active,
      previous,
      expanded: ["ticket"],
      activeHeader: true,
      reach: true,
    });
    expect(closed).toHaveLength(1004);
    expect(open).toHaveLength(2004);
    expect(open.map((row) => row.kind).slice(999, 1005)).toEqual([
      "active",
      "active",
      "band",
      "ticket",
      "previous",
      "previous",
    ]);
    expect(new Set(open.map((row) => row.key)).size).toBe(open.length);
    let offset = 0;
    for (const row of open) {
      expect(row.offset).toBe(offset);
      offset += row.height + 2;
    }
    expect(open.at(-2)).toMatchObject({ folderId: "ticket", lastInFolder: true, height: 32 });
    expect(open[1].key).toBe(closed[1].key);
    expect(navigatorRowDomId("chat:a/b")).toBe("session-nav-chat%3Aa%2Fb");
  });
  it("omits the external Active heading and keeps standalone Previous rows", () => {
    const row = { id: "session:one" } as PreviousSessionRow;
    expect(
      sessionNavigatorRows({
        active: [],
        previous: [{ kind: "session", id: row.id, row }],
        expanded: [],
        activeHeader: false,
        reach: false,
      }).map(({ kind, offset }) => ({ kind, offset })),
    ).toEqual([
      { kind: "band", offset: 0 },
      { kind: "previous", offset: 34 },
    ]);
  });
});

it("keeps multi-selection separate from the keyboard-focused row", () => {
  const rows = sessionNavigatorRows({
    active: [{ id: "a" }, { id: "b" }] as ActiveSessionRow[],
    previous: [],
    expanded: [],
    activeHeader: false,
    reach: false,
    selection: { focusedId: "b", selectedIds: new Set(["a"]) },
  });
  expect(rows[0]).toMatchObject({ selected: true, focused: false, height: 46 });
  expect(rows[1]).toMatchObject({ selected: false, focused: true, offset: 48 });
});
