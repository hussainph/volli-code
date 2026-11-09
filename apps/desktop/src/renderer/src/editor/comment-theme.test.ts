import { describe, expect, it } from "vite-plus/test";
import vitesseLight from "@shikijs/themes/vitesse-light";
import vitesseDark from "@shikijs/themes/vitesse-dark";
import { compositeHex, DEFAULT_CANVAS, deriveCanvasTokens, wcagContrast } from "@volli/shared";
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import typescript from "@shikijs/langs/typescript";
import { readableCommentTheme } from "./comment-theme";

for (const original of [vitesseLight, vitesseDark]) {
  describe(original.name!, () => {
    it("changes only comment ink, without mutating the shipped theme", () => {
      const theme = readableCommentTheme(original);
      expect(theme.colors).toBe(original.colors);
      expect(theme.semanticTokenColors).toBe(original.semanticTokenColors);
      original.tokenColors?.forEach((rule, index) => {
        const scopes = Array.isArray(rule.scope) ? rule.scope : [rule.scope];
        if (scopes.includes("comment")) {
          expect(theme.tokenColors?.[index]?.settings.foreground).not.toBe(
            rule.settings.foreground,
          );
          expect(theme.tokenColors?.[index]?.scope).toBe(rule.scope);
        } else {
          expect(theme.tokenColors?.[index]).toBe(rule);
        }
      });
    });

    it("tokenizes line and block comments at ≥4.5:1 on the source plane and current-line wash", async () => {
      const theme = readableCommentTheme(original);
      const tokens = deriveCanvasTokens(
        DEFAULT_CANVAS,
        original.type === "light" ? "light" : "dark",
      );
      const backgrounds = [
        tokens["--background"],
        compositeHex(tokens["--foreground"], 0.05, tokens["--background"]),
        original.colors!["editor.background"],
      ];
      const highlighter = await createHighlighterCore({
        themes: [theme],
        langs: [typescript],
        engine: createJavaScriptRegexEngine(),
      });
      try {
        for (const code of ["// Read-only source preview", "/* Comment */"]) {
          const result = highlighter.codeToTokens(code, {
            lang: "typescript",
            theme: original.name!,
          });
          for (const token of result.tokens.flat()) {
            expect(token.color).toMatch(/^#[\da-f]{6}$/i);
            for (const background of backgrounds)
              expect(wcagContrast(token.color!, background)).toBeGreaterThanOrEqual(4.5);
          }
        }
      } finally {
        highlighter.dispose();
      }
    });
  });
}
