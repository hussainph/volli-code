import { describe, expect, it } from "vite-plus/test";
import type { GhosttyAppearancePayload, GhosttyValueOrigin } from "@volli/shared";

import { buildTerminalSettingRows } from "./terminal-settings-model";

function payload(
  over: Partial<GhosttyAppearancePayload["prefs"]> = {},
  provenance: Record<string, GhosttyValueOrigin> = {},
): GhosttyAppearancePayload {
  return {
    prefs: {
      themeName: null,
      fontFamilies: [],
      fontSize: null,
      ligatures: null,
      mouseReporting: null,
      macosOptionAsAlt: null,
      scrollbackLimitBytes: null,
      ...over,
    },
    configText: null,
    themeSource: null,
    provenance,
    overlayPaths: { global: "/data/volli/ghostty/config", project: null },
    ghosttyConfigPath: "/home/u/.config/ghostty/config",
  };
}

const rowFor = (result: ReturnType<typeof buildTerminalSettingRows>, key: string) =>
  result.find((row) => row.key === key);

describe("buildTerminalSettingRows", () => {
  it("reports the built-in default when no layer sets a key", () => {
    const rows = buildTerminalSettingRows(payload());

    expect(rows.map((row) => row.key)).toEqual(["theme", "font-family", "font-size"]);
    for (const row of rows) {
      expect(row.value).toBeNull();
      expect(row.source).toBe("default");
      expect(row.sourceLabel).toBe("Built-in default");
      // Nothing to revert to — and Volli must never "revert" by writing the
      // user's own config.
      expect(row.revertible).toBe(false);
    }
  });

  it("labels a value the user's own ghostty config supplied, and refuses to revert it", () => {
    const rows = buildTerminalSettingRows(payload({ themeName: "Nord" }, { theme: "ghostty" }));

    expect(rowFor(rows, "theme")).toMatchObject({
      value: "Nord",
      source: "ghostty",
      sourceLabel: "Inherited from Ghostty",
      revertible: true,
    });
  });

  it("labels a value Volli's own overlay supplied", () => {
    const rows = buildTerminalSettingRows(
      payload({ themeName: "Dracula" }, { theme: "volli-global" }),
    );

    expect(rowFor(rows, "theme")).toMatchObject({
      value: "Dracula",
      source: "volli-global",
      sourceLabel: "Set by Volli",
      revertible: true,
    });
  });

  it("distinguishes a per-project overlay from the global one", () => {
    const rows = buildTerminalSettingRows(
      payload({ fontSize: 15 }, { "font-size": "volli-project" }),
    );

    expect(rowFor(rows, "font-size")).toMatchObject({
      value: "15 pt",
      source: "volli-project",
      sourceLabel: "Set by this project",
      revertible: true,
    });
  });

  it("shows the first configured font family", () => {
    const rows = buildTerminalSettingRows(
      payload({ fontFamilies: ["Berkeley Mono", "Menlo"] }, { "font-family": "ghostty" }),
    );

    expect(rowFor(rows, "font-family")?.value).toBe("Berkeley Mono");
  });

  it("treats a missing payload as all-defaults rather than an error", () => {
    const rows = buildTerminalSettingRows(null);

    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.source === "default")).toBe(true);
  });
});
