import { describe, expect, it } from "vite-plus/test";

import { fileTabId, isFileTabId, parseFileTabId } from "./ticket-file-tab";

describe("ticket file tab id", () => {
  it("round-trips a relPath through fileTabId / parseFileTabId", () => {
    expect(parseFileTabId(fileTabId("src/app.ts"))).toBe("src/app.ts");
    expect(parseFileTabId(fileTabId("docs/plan.md"))).toBe("docs/plan.md");
  });

  it("rejects non-file tab ids", () => {
    expect(parseFileTabId("doc")).toBeNull();
    expect(parseFileTabId("diff:src/app.ts")).toBeNull();
    expect(parseFileTabId("file:")).toBeNull();
    expect(parseFileTabId("session-9")).toBeNull();
    expect(isFileTabId("file:a.ts")).toBe(true);
    expect(isFileTabId("diff:a.ts")).toBe(false);
  });
});
