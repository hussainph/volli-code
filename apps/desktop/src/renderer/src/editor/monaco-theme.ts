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

function normalizedHex(color: string): string {
  const match = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(color);
  if (match === null) {
    throw new Error(`Monaco theme tokens must resolve to #RGB or #RRGGBB, received ${color}`);
  }
  const value = match[1];
  const expanded =
    value.length === 3
      ? value
          .split("")
          .map((digit) => `${digit}${digit}`)
          .join("")
      : value;
  return `#${expanded}`;
}

function withoutHash(color: string): string {
  return normalizedHex(color).slice(1);
}

function withAlpha(color: string, alpha: string): string {
  return `${normalizedHex(color)}${alpha}`;
}

/** Maps the canonical renderer tokens onto Monaco's supported theme surface. */
export function createVolliMonacoTheme(tokens: VolliMonacoTokens): editor.IStandaloneThemeData {
  const background = normalizedHex(tokens.background);
  const foreground = normalizedHex(tokens.foreground);
  const muted = normalizedHex(tokens.muted);
  const mutedForeground = normalizedHex(tokens.mutedForeground);
  const border = normalizedHex(tokens.border);
  const primary = normalizedHex(tokens.primary);
  const destructive = normalizedHex(tokens.destructive);

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
      "editor.background": background,
      "editor.foreground": foreground,
      "editorLineNumber.foreground": mutedForeground,
      "editorGutter.background": background,
      "editorCursor.foreground": primary,
      "editor.selectionBackground": withAlpha(primary, "40"),
      "editor.inactiveSelectionBackground": withAlpha(primary, "24"),
      "editorWidget.background": muted,
      "editorWidget.border": border,
      "editorError.foreground": destructive,
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
