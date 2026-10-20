// @ts-check
/*
 * Code blocks, in Volli's palette rather than Starlight's night-owl.
 *
 * The docs' code is almost all shell: a `volli` command and a few flags. So the
 * two themes below are small on purpose — ink for the text, one warm colour
 * for the command, a quieter one for strings, and the page's own greys for
 * everything else — and the blocks sit on a panel one step off the page
 * behind the site's single hairline (apps/website/brand/BRAND.md §6).
 *
 * It lives here, not in astro.config.mjs, because the themes are class
 * instances, and Expressive Code only reads non-serialisable options from
 * this file.
 */
import { ExpressiveCodeTheme, defineEcConfig } from "@astrojs/starlight/expressive-code";

/**
 * @param {{ name: string; type: "dark" | "light"; bg: string; fg: string; muted: string;
 *   comment: string; command: string; string: string; }} palette
 */
function volliTheme({ name, type, bg, fg, muted, comment, command, string }) {
  return new ExpressiveCodeTheme({
    name,
    type,
    colors: {
      "editor.background": bg,
      "editor.foreground": fg,
      "terminal.background": bg,
      "editorGroupHeader.tabsBackground": bg,
      "tab.activeBackground": bg,
      "titleBar.activeBackground": bg,
      "titleBar.activeForeground": muted,
      "tab.activeForeground": fg,
      "tab.activeBorderTop": "#00000000",
      "editor.selectionBackground": type === "dark" ? "#f5f2ee26" : "#17150f1f",
    },
    tokenColors: [
      { settings: { foreground: fg } },
      {
        scope: ["comment", "punctuation.definition.comment"],
        settings: { foreground: comment },
      },
      {
        scope: [
          "entity.name.function",
          "entity.name.command",
          "support.function",
          "support.function.builtin",
        ],
        settings: { foreground: command },
      },
      {
        scope: ["string", "punctuation.definition.string", "markup.inline.raw"],
        settings: { foreground: string },
      },
      {
        scope: [
          "keyword",
          "storage",
          "keyword.operator",
          "punctuation",
          "constant.other.option",
          "variable.parameter",
        ],
        settings: { foreground: muted },
      },
      {
        scope: ["constant.numeric", "constant.language", "variable.other"],
        settings: { foreground: string },
      },
      // A command's arguments are words the reader types, in the text's ink.
      {
        scope: ["string.unquoted.argument"],
        settings: { foreground: fg },
      },
    ],
  });
}

export default defineEcConfig({
  themes: [
    volliTheme({
      name: "volli-night",
      type: "dark",
      bg: "#0e0e12",
      fg: "#f5f2ee",
      muted: "#a9a7a4",
      comment: "#7e7d7c",
      command: "#ffc799",
      string: "#e3c7ad",
    }),
    volliTheme({
      name: "volli-paper",
      type: "light",
      bg: "#f2f0eb",
      fg: "#17150f",
      muted: "#5e5c57",
      comment: "#6f6d68",
      command: "#9e3d15",
      string: "#7a4a24",
    }),
  ],
  // Shell commands read as plain text on the page, not as a mock terminal
  // window: no title bar, no traffic lights. The copy button stays.
  defaultProps: {
    overridesByLang: {
      "sh,bash,shell,zsh,text,txt": { frame: "none" },
    },
  },
  styleOverrides: {
    borderRadius: "12px",
    borderWidth: "1px",
    borderColor: "var(--volli-hairline)",
    codeFontFamily: "var(--volli-mono)",
    codeFontSize: "0.8125rem",
    codeLineHeight: "1.7",
    codePaddingBlock: "0.875rem",
    codePaddingInline: "1.125rem",
    uiFontFamily: "var(--sl-font)",
    uiFontSize: "0.8125rem",
    frames: {
      shadowColor: "transparent",
      frameBoxShadowCssValue: "none",
      editorTabBarBorderBottomColor: "var(--volli-hairline)",
      terminalTitlebarBorderBottomColor: "var(--volli-hairline)",
      terminalTitlebarDotsOpacity: "0.28",
      inlineButtonBorderOpacity: "0.2",
    },
  },
});
