import type { editor } from "monaco-editor";

export interface VolliMonacoTokens {
  background: string;
  foreground: string;
  muted: string;
  mutedForeground: string;
  border: string;
  primary: string;
  destructive: string;
}

function withoutHash(color: string): string {
  return color.startsWith("#") ? color.slice(1) : color;
}

function withAlpha(color: string, alpha: string): string {
  return `${color}${alpha}`;
}

/** Maps the canonical renderer tokens onto Monaco's supported theme surface. */
export function createVolliMonacoTheme(tokens: VolliMonacoTokens): editor.IStandaloneThemeData {
  return {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: withoutHash(tokens.mutedForeground) },
      { token: "keyword", foreground: withoutHash(tokens.primary) },
      { token: "number", foreground: withoutHash(tokens.primary) },
      { token: "string", foreground: withoutHash(tokens.foreground) },
    ],
    colors: {
      "editor.background": tokens.background,
      "editor.foreground": tokens.foreground,
      "editorLineNumber.foreground": tokens.mutedForeground,
      "editorGutter.background": tokens.background,
      "editorCursor.foreground": tokens.primary,
      "editor.selectionBackground": withAlpha(tokens.primary, "40"),
      "editor.inactiveSelectionBackground": withAlpha(tokens.primary, "24"),
      "editorWidget.background": tokens.muted,
      "editorWidget.border": tokens.border,
      "editorError.foreground": tokens.destructive,
    },
  };
}

function cssToken(styles: CSSStyleDeclaration, name: string): string {
  const value = styles.getPropertyValue(name).trim();
  if (value === "") throw new Error(`Missing canonical design token ${name}`);
  return value;
}

export function readVolliMonacoTokens(
  styles: CSSStyleDeclaration = getComputedStyle(document.documentElement),
): VolliMonacoTokens {
  return {
    background: cssToken(styles, "--background"),
    foreground: cssToken(styles, "--foreground"),
    muted: cssToken(styles, "--muted"),
    mutedForeground: cssToken(styles, "--muted-foreground"),
    border: cssToken(styles, "--border"),
    primary: cssToken(styles, "--primary"),
    destructive: cssToken(styles, "--destructive"),
  };
}
