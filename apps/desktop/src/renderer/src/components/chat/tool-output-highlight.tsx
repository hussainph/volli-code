/**
 * Syntax colour for tool output under an expanded Read / Edit / Write row (VC-125).
 *
 * Same highlighter as the assistant's code fences — Streamdown's
 * `@streamdown/code` plugin, its themes, its on-demand grammar loading — so a
 * file read in a tool row and the same file quoted in a fence look identical,
 * and the Monaco/editor bundle stays out of chat. The plugin answers
 * synchronously once a snippet is cached and by callback the first time; the
 * hook mirrors Streamdown's own code-block body, which renders plain text
 * first and swaps in the tokens when they land.
 *
 * NOTHING HERE RUNS FOR A ROW NOBODY IS LOOKING AT, and that is two separate
 * facts. A CLOSED row never reaches this module at all — the disclosure
 * unmounts its body, so there is no hook to run — and the detail is capped at
 * 400 lines besides. An OPEN row that is off screen is the case VC-338 added:
 * a bundle the live turn opened by itself, or one the reader left open fifty
 * turns ago, used to tokenize its payload and mint a span per token the moment
 * it mounted. {@link useOnScreen} is the gate, and it latches: once a payload
 * has been coloured, scrolling past it does not take the colour away.
 */
import { code, type HighlightResult } from "@streamdown/code";
import * as React from "react";

/** One rendered line: the plugin's tokens for it, light and dark colour aboard. */
export type TokenLine = HighlightResult["tokens"][number];
type Token = TokenLine[number];
type HighlightLanguage = Parameters<typeof code.highlight>[0]["language"];

/**
 * The plugin's own language union, entered through its own support check.
 * `plaintext` is not a bundled language and comes back `null`, which is also
 * the answer for anything the editor catalog knows that the plugin does not.
 */
function highlightLanguage(languageId: string | null): HighlightLanguage | null {
  if (languageId === null || languageId === "plaintext") return null;
  const supported: readonly string[] = code.getSupportedLanguages();
  return supported.includes(languageId) ? (languageId as HighlightLanguage) : null;
}

/**
 * Whether an element has been on screen, and the ref that watches it.
 *
 * ONE WAY on purpose. The question this answers is "has anyone looked at this
 * payload", not "is it visible now": tokenization is cached by text, so giving
 * the colour back when the row scrolls away would buy nothing and cost a
 * re-render plus a visible flicker on the way back. The margin is generous for
 * the same reason the transcript's earlier-rows sentinel has one — arriving at a
 * payload should not mean watching it colour itself.
 *
 * No IntersectionObserver (jsdom, server render) means "on screen": the gate
 * exists to skip work nobody asked for, never to withhold colour from a surface
 * that cannot tell us what it is showing.
 */
export function useOnScreen<T extends Element>(): {
  ref: React.RefObject<T | null>;
  onScreen: boolean;
} {
  const ref = React.useRef<T | null>(null);
  const [onScreen, setOnScreen] = React.useState(() => typeof IntersectionObserver === "undefined");

  React.useEffect(() => {
    if (onScreen) return;
    const node = ref.current;
    if (node === null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setOnScreen(true);
      },
      { rootMargin: "300px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [onScreen]);

  return { ref, onScreen };
}

/**
 * Tokens for `text` in `languageId`, or `null` while they are not available —
 * before the grammar has loaded, for a language with no grammar, or while the
 * payload has not been looked at. The result is keyed to the exact `text` +
 * language it was asked for, so a row whose content changes never shows tokens
 * for the previous content.
 */
export function useHighlightedLines(
  text: string,
  languageId: string | null,
  /** Pass what {@link useOnScreen} answered; the default is "colour it now". */
  onScreen = true,
): TokenLine[] | null {
  const language = highlightLanguage(languageId);
  const [result, setResult] = React.useState<{
    text: string;
    language: HighlightLanguage;
    tokens: TokenLine[];
  } | null>(null);

  React.useEffect(() => {
    if (language === null || !onScreen) return;
    let live = true;
    const adopt = (highlighted: HighlightResult) => {
      if (live) setResult({ text, language, tokens: highlighted.tokens });
    };
    const cached = code.highlight({ code: text, language, themes: code.getThemes() }, adopt);
    if (cached !== null) adopt(cached);
    return () => {
      live = false;
    };
  }, [language, onScreen, text]);

  if (language === null || result === null) return null;
  return result.text === text && result.language === language ? result.tokens : null;
}

/*
 * Streamdown's own token recipe, class for class: the light colour rides on
 * `--sdm-c`, the dark one on `--shiki-dark` (which the plugin already puts in
 * `htmlStyle` under dual themes), and the `dark:` variant picks between them.
 * Reusing the exact strings means Tailwind emits no new CSS for this — the
 * `@source` line for streamdown in globals.css already produced these rules.
 */
const TOKEN_CLASS =
  "text-[var(--sdm-c,inherit)] dark:text-[var(--shiki-dark,var(--sdm-c,inherit))]";

function tokenStyle(token: Token): React.CSSProperties {
  const style: Record<string, string> = {};
  if (token.color) style["--sdm-c"] = token.color;
  for (const [property, value] of Object.entries(token.htmlStyle ?? {})) {
    if (property === "color") style["--sdm-c"] = value;
    else style[property] = value;
  }
  return style as React.CSSProperties;
}

/**
 * One line of tokens, or the plain text when tokens are not there yet. Both
 * render the same characters, so the swap moves nothing; an empty line keeps
 * a space so the row holds its height either way.
 */
export function TokenText({ text, tokens }: { text: string; tokens: TokenLine | undefined }) {
  // A blank line comes back as no tokens or one empty token; either way the
  // plain branch's space is what keeps the row from collapsing.
  if (tokens === undefined || tokens.every((token) => token.content === "")) {
    return <>{text || " "}</>;
  }
  return (
    <>
      {tokens.map((token) => (
        <span key={token.offset} className={TOKEN_CLASS} style={tokenStyle(token)}>
          {token.content}
        </span>
      ))}
    </>
  );
}
