import { describe, expect, it } from "vite-plus/test";

import { isClosableTicketTab, type TicketTabDescriptor, type TicketTabKind } from "./ticket-tabs";

describe("isClosableTicketTab", () => {
  it("treats file and diff tabs as closable like sessions", () => {
    const kinds: TicketTabKind[] = ["body", "session", "file", "diff"];
    expect(kinds.map(isClosableTicketTab)).toEqual([false, true, true, true]);
  });

  it("accepts diff descriptors with relPath, optional previousPath, and dirty", () => {
    const tab: TicketTabDescriptor = {
      id: "diff:src/app.ts",
      kind: "diff",
      label: "app.ts",
      relPath: "src/app.ts",
      previousPath: "src/old.ts",
      dirty: true,
    };
    expect(isClosableTicketTab(tab.kind)).toBe(true);
    expect(tab.previousPath).toBe("src/old.ts");
  });
});
