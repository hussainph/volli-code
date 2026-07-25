import { describe, expect, it } from "vite-plus/test";

import { splitChangePath } from "./ticket-changes-model";

describe("splitChangePath", () => {
  it("leads with the filename and keeps the parent path secondary", () => {
    expect(splitChangePath("src/components/ticket/rail.tsx")).toEqual({
      filename: "rail.tsx",
      parentPath: "src/components/ticket",
    });
  });

  it("uses an empty parent for repo-root files", () => {
    expect(splitChangePath("README.md")).toEqual({ filename: "README.md", parentPath: "" });
  });
});
