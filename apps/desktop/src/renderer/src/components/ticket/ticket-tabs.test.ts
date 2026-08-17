import { describe, expect, it } from "vite-plus/test";

import { isClosableTicketTab, type TicketTabDescriptor, type TicketTabKind } from "./ticket-tabs";

describe("isClosableTicketTab", () => {
  it("treats file, diff, and chat tabs as closable like sessions", () => {
    const kinds: TicketTabKind[] = ["body", "session", "file", "diff", "chat"];
    expect(kinds.map(isClosableTicketTab)).toEqual([false, true, true, true, true]);
  });

  it("accepts a chat descriptor with a prefixed id and a lifecycle dot", () => {
    const tab: TicketTabDescriptor = {
      id: "chat:sess-9",
      kind: "chat",
      label: "Plan the migration",
      status: "working",
    };
    expect(isClosableTicketTab(tab.kind)).toBe(true);
    expect(tab.id.startsWith("chat:")).toBe(true);
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

  it("accepts a preview File descriptor (decision #56)", () => {
    const tab: TicketTabDescriptor = {
      id: "file:src/app.ts",
      kind: "file",
      label: "app.ts",
      relPath: "src/app.ts",
      preview: true,
    };
    expect(isClosableTicketTab(tab.kind)).toBe(true);
    expect(tab.preview).toBe(true);
  });
});
