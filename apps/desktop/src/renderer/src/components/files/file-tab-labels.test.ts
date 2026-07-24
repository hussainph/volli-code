import { describe, expect, it } from "vite-plus/test";

import { fileTabLabels } from "./file-tab-labels";

describe("fileTabLabels", () => {
  it("uses the file's basename as the tab label", () => {
    expect(fileTabLabels(["src/renderer/app-shell.tsx"])).toEqual([
      { relPath: "src/renderer/app-shell.tsx", name: "app-shell.tsx", hint: null },
    ]);
  });

  it("leaves a unique basename without a parent hint", () => {
    const labels = fileTabLabels(["src/index.ts", "docs/CONCEPT.md"]);

    expect(labels.map((label) => label.hint)).toEqual([null, null]);
  });

  it("disambiguates tabs that share a basename with their parent directory", () => {
    const labels = fileTabLabels(["src/main/index.ts", "src/preload/index.ts"]);

    expect(labels).toEqual([
      { relPath: "src/main/index.ts", name: "index.ts", hint: "main" },
      { relPath: "src/preload/index.ts", name: "index.ts", hint: "preload" },
    ]);
  });

  it("walks further up the path when the immediate parents also collide", () => {
    const labels = fileTabLabels(["apps/desktop/src/index.ts", "packages/shared/src/index.ts"]);

    expect(labels.map((label) => label.hint)).toEqual(["desktop/src", "shared/src"]);
  });

  it("marks a colliding repository-root file with the root hint", () => {
    const labels = fileTabLabels(["README.md", "docs/README.md"]);

    expect(labels).toEqual([
      { relPath: "README.md", name: "README.md", hint: "/" },
      { relPath: "docs/README.md", name: "README.md", hint: "docs" },
    ]);
  });

  it("disambiguates only the group that collides", () => {
    const labels = fileTabLabels(["a/index.ts", "b/index.ts", "c/main.ts"]);

    expect(labels.map((label) => label.hint)).toEqual(["a", "b", null]);
  });

  it("keeps the caller's tab order", () => {
    const labels = fileTabLabels(["z/index.ts", "a/index.ts"]);

    expect(labels.map((label) => label.relPath)).toEqual(["z/index.ts", "a/index.ts"]);
  });
});
