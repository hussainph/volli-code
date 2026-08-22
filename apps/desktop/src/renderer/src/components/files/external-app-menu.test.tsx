import { describe, expect, it } from "vite-plus/test";

import { externalAppMenuEntries, preferredExternalApp } from "./external-app-menu";

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

  it("uses a configured app only while it is still installed", () => {
    const apps = [{ id: "vscode", label: "VS Code", kind: "editor" }] as const;

    expect(preferredExternalApp(apps, "vscode")).toEqual(apps[0]);
    expect(preferredExternalApp(apps, null)).toBeNull();
    expect(preferredExternalApp(apps, "cursor")).toBeNull();
  });
});
