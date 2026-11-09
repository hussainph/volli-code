import type { ThemeRegistration } from "shiki/types";
import { compositeHex, DEFAULT_CANVAS, deriveCanvasTokens, wcagContrast } from "@volli/shared";

/** Keep Vitesse syntax intact; solve opaque comment ink against the app's source plane.
 * A 5:1 floor leaves room for the current-line wash above the 4.5:1 reading floor.
 * The default canvas is the fixed editor pair's reference, not a new syntax palette.
 */
export function readableCommentTheme(theme: ThemeRegistration): ThemeRegistration {
  if (theme.tokenColors === undefined) return theme;
  const tokens = deriveCanvasTokens(DEFAULT_CANVAS, theme.type === "light" ? "light" : "dark");
  const background = tokens["--background"];
  let foreground = tokens["--muted-foreground"];
  for (let step = 0; wcagContrast(foreground, background) < 5 && step <= 20; step++) {
    foreground = compositeHex(tokens["--foreground"], step / 20, tokens["--muted-foreground"]);
  }
  return {
    ...theme,
    tokenColors: theme.tokenColors.map((rule) => {
      const scopes = Array.isArray(rule.scope) ? rule.scope : [rule.scope];
      if (!scopes.includes("comment")) return rule;
      return { ...rule, settings: { ...rule.settings, foreground } };
    }),
  };
}
