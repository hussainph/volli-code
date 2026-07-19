import { describe, expect, it } from "vite-plus/test";

import { diffManagedContent } from "./diff";

describe("diffManagedContent", () => {
  it("shows only the changed middle as - old / + new hunks", () => {
    const current = "line one\nEDITED\nline three\n";
    const desired = "line one\nline two\nline three\n";
    expect(diffManagedContent(current, desired)).toBe("- EDITED\n+ line two");
  });

  it("reports no textual difference when the content matches", () => {
    expect(diffManagedContent("same\ntext", "same\ntext")).toBe("(no textual difference)");
  });

  it("caps a wholesale rewrite so it cannot flood a dialog", () => {
    const current = Array.from({ length: 500 }, (_, i) => `old ${i}`).join("\n");
    const desired = Array.from({ length: 500 }, (_, i) => `new ${i}`).join("\n");
    const out = diffManagedContent(current, desired);
    expect(out).toContain("more changed lines)");
    expect(out.split("\n")).toHaveLength(201);
  });
});
