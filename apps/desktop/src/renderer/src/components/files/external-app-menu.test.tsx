import { describe, expect, it } from "vite-plus/test";

import { externalAppMenuEntries } from "./external-app-menu";

describe("externalAppMenuEntries", () => {
  it("shows only detected apps and Finder when no external editor is present", () => {
    const empty = externalAppMenuEntries([]);
    const detected = externalAppMenuEntries([
      { id: "vscode", label: "VS Code", kind: "editor" },
      { id: "terminal", label: "Terminal", kind: "terminal" },
    ]);

    expect(empty).toEqual([{ kind: "finder" }]);
    expect(detected).toEqual([
      { kind: "app", app: { id: "vscode", label: "VS Code", kind: "editor" } },
      { kind: "app", app: { id: "terminal", label: "Terminal", kind: "terminal" } },
      { kind: "finder" },
    ]);
  });
});
