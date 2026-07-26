import { describe, expect, it } from "vite-plus/test";

import { diffTabId, parseDiffTabId } from "./ticket-diff-tab";

describe("diffTabId", () => {
  it("returns a path-stable diff:<relPath> id", () => {
    expect(diffTabId("src/app.ts")).toBe("diff:src/app.ts");
    expect(diffTabId("docs/plan.md")).toBe("diff:docs/plan.md");
  });

  it("round-trips through parseDiffTabId", () => {
    const id = diffTabId("lib/foo.ts");
    expect(parseDiffTabId(id)).toBe("lib/foo.ts");
    expect(parseDiffTabId("file:lib/foo.ts")).toBeNull();
    expect(parseDiffTabId("doc")).toBeNull();
    expect(parseDiffTabId("diff:")).toBeNull();
  });
});
