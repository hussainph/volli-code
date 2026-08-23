import { describe, expect, it } from "vite-plus/test";

import { editorThemeForAppearance } from "./editor-themes";

describe("editorThemeForAppearance", () => {
  it("answers Vitesse Light for light and Vitesse Dark for dark", () => {
    expect(editorThemeForAppearance("light")).toBe("vitesse-light");
    expect(editorThemeForAppearance("dark")).toBe("vitesse-dark");
  });

  it("has exactly one distinct fixed theme for each resolved appearance", () => {
    const pair = [editorThemeForAppearance("light"), editorThemeForAppearance("dark")];

    expect(pair).toEqual(["vitesse-light", "vitesse-dark"]);
    expect(new Set(pair)).toHaveLength(2);
  });
});
