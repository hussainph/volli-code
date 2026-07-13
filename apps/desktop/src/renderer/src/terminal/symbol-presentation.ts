const TEXT_VARIATION_SELECTOR = "\uFE0E";

const DEFAULT_EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;

/** Cheap probe for the fast path: is there any pictograph at all? */
const HAS_PICTOGRAPH = /\p{Extended_Pictographic}/u;

/** A pictograph whose presentation is still ambiguous: not already followed by
 *  a text selector (U+FE0E), an emoji selector (U+FE0F), or a ZWJ (U+200D)
 *  that would make it explicit or part of an emoji sequence. Global + Unicode
 *  so `replace` walks whole code points (surrogate pairs included). */
const AMBIGUOUS_PICTOGRAPH = /\p{Extended_Pictographic}(?![\uFE0E\uFE0F\u200D])/gu;

/**
 * restty 0.2.0 treats broad Unicode symbol ranges as emoji-preferred. That
 * makes text-default terminal UI glyphs such as U+23FA render through Apple
 * Color Emoji even when the configured monospace face contains the glyph.
 *
 * Preserve explicit emoji/text selectors and genuine emoji-default codepoints,
 * but make Unicode's ambiguous, text-default pictographs explicit for the
 * renderer. The PTY byte stream and transcript stay untouched; this only
 * adapts the string handed to restty's canvas renderer.
 *
 * Runs on every chunk of PTY output, so the common case — output with no
 * pictographs at all — bails after a single native scan and returns the
 * original string untouched.
 */
export function preferTextPresentationForAmbiguousSymbols(text: string): string {
  if (!HAS_PICTOGRAPH.test(text)) return text;

  return text.replace(AMBIGUOUS_PICTOGRAPH, (symbol) =>
    DEFAULT_EMOJI_PRESENTATION.test(symbol) ? symbol : symbol + TEXT_VARIATION_SELECTOR,
  );
}
