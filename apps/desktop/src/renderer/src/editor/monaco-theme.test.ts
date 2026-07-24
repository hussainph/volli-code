import { describe, expect, it } from "vite-plus/test";

import { createVolliMonacoTheme } from "./monaco-theme";

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
});
