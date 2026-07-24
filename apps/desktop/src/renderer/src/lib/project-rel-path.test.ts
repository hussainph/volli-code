import { describe, expect, it } from "vite-plus/test";

import { toProjectRelPath } from "./project-rel-path";

describe("toProjectRelPath", () => {
  it("converts an absolute child path to a project-relative path", () => {
    expect(toProjectRelPath("/Users/me/repo", "/Users/me/repo/src/main/index.ts")).toBe(
      "src/main/index.ts",
    );
  });

  it("returns the empty root path for the project directory itself", () => {
    expect(toProjectRelPath("/Users/me/repo", "/Users/me/repo")).toBe("");
  });

  it("tolerates a trailing separator on either side", () => {
    expect(toProjectRelPath("/Users/me/repo/", "/Users/me/repo/src")).toBe("src");
    expect(toProjectRelPath("/Users/me/repo", "/Users/me/repo/src/")).toBe("src");
  });

  it("rejects a sibling directory whose name merely starts with the project path", () => {
    expect(toProjectRelPath("/Users/me/repo", "/Users/me/repo-old/src/index.ts")).toBeNull();
    expect(toProjectRelPath("/Users/me/repo", "/Users/me/repository")).toBeNull();
  });

  it("rejects a path outside the project entirely", () => {
    expect(toProjectRelPath("/Users/me/repo", "/etc/passwd")).toBeNull();
  });

  it("normalizes backslash separators to forward slashes", () => {
    expect(toProjectRelPath("C:\\Users\\me\\repo", "C:\\Users\\me\\repo\\src\\index.ts")).toBe(
      "src/index.ts",
    );
  });

  it("collapses repeated separators inside the relative remainder", () => {
    expect(toProjectRelPath("/Users/me/repo", "/Users/me/repo//src//index.ts")).toBe(
      "src/index.ts",
    );
  });
});
