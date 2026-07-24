import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createVolliMonacoTheme, readVolliMonacoTokens } from "./monaco-theme";

afterEach(() => {
  vi.unstubAllGlobals();
});

function fakeStyles(values: Readonly<Record<string, string>>): CSSStyleDeclaration {
  return {
    getPropertyValue: (name: string) => values[name] ?? "",
  } as CSSStyleDeclaration;
}

describe("createVolliMonacoTheme", () => {
  it("derives editor chrome and syntax colors from canonical Volli tokens", () => {
    const theme = createVolliMonacoTheme({
      background: "#111111",
      foreground: "#f5f5f5",
      muted: "#1c1c1c",
      mutedForeground: "#9a9a9a",
      border: "#262626",
      primary: "#e8652a",
      destructive: "#e5484d",
    });

    expect(theme).toMatchObject({
      base: "vs-dark",
      inherit: true,
      colors: {
        "editor.background": "#111111",
        "editor.foreground": "#f5f5f5",
        "editorLineNumber.foreground": "#9a9a9a",
        "editorGutter.background": "#111111",
        "editorCursor.foreground": "#e8652a",
        "editor.selectionBackground": "#e8652a40",
        "editor.inactiveSelectionBackground": "#e8652a24",
        "editorWidget.background": "#1c1c1c",
        "editorWidget.border": "#262626",
        "editorError.foreground": "#e5484d",
      },
    });
  });

  it("expands minified three-digit CSS token colors for Monaco's hex parser", () => {
    const theme = createVolliMonacoTheme({
      background: "#111",
      foreground: "#fff",
      muted: "#222",
      mutedForeground: "#999",
      border: "#333",
      primary: "#e65",
      destructive: "#e54",
    });

    expect(theme.rules).toContainEqual({ token: "string", foreground: "ffffff" });
    expect(theme.colors).toMatchObject({
      "editor.background": "#111111",
      "editor.foreground": "#ffffff",
      "editor.selectionBackground": "#ee665540",
      "editorError.foreground": "#ee5544",
    });
  });

  it("rejects design-token formats Monaco cannot parse safely", () => {
    expect(() =>
      createVolliMonacoTheme({
        background: "rgb(17 17 17)",
        foreground: "#fff",
        muted: "#222",
        mutedForeground: "#999",
        border: "#333",
        primary: "#e65",
        destructive: "#e54",
      }),
    ).toThrow("must resolve to #RGB or #RRGGBB");
  });

  it("reads every theme color from the supplied canonical CSS tokens", () => {
    const styles = fakeStyles({
      "--background": " #111 ",
      "--foreground": "#fff",
      "--muted": "#222",
      "--muted-foreground": "#999",
      "--border": "#333",
      "--primary": "#e65",
      "--destructive": "#e54",
    });

    expect(readVolliMonacoTokens(styles)).toEqual({
      background: "#111",
      foreground: "#fff",
      muted: "#222",
      mutedForeground: "#999",
      border: "#333",
      primary: "#e65",
      destructive: "#e54",
    });
  });

  it("fails visibly when a canonical CSS token is missing", () => {
    expect(() => readVolliMonacoTokens(fakeStyles({}))).toThrow(
      "Missing canonical design token --background",
    );
  });

  it("reads from the document root by default", () => {
    const documentElement = {};
    const styles = fakeStyles({
      "--background": "#111",
      "--foreground": "#fff",
      "--muted": "#222",
      "--muted-foreground": "#999",
      "--border": "#333",
      "--primary": "#e65",
      "--destructive": "#e54",
    });
    const getComputedStyle = vi.fn(() => styles);
    vi.stubGlobal("document", { documentElement });
    vi.stubGlobal("getComputedStyle", getComputedStyle);

    expect(readVolliMonacoTokens().background).toBe("#111");
    expect(getComputedStyle).toHaveBeenCalledWith(documentElement);
  });
});
