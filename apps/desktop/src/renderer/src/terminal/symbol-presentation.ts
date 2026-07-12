const TEXT_VARIATION_SELECTOR = "\uFE0E";
const EMOJI_VARIATION_SELECTOR = "\uFE0F";
const ZERO_WIDTH_JOINER = "\u200D";

const EXTENDED_PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const DEFAULT_EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;

/**
 * restty 0.2.0 treats broad Unicode symbol ranges as emoji-preferred. That
 * makes text-default terminal UI glyphs such as U+23FA render through Apple
 * Color Emoji even when the configured monospace face contains the glyph.
 *
 * Preserve explicit emoji/text selectors and genuine emoji-default codepoints,
 * but make Unicode's ambiguous, text-default pictographs explicit for the
 * renderer. The PTY byte stream and transcript stay untouched; this only
 * adapts the string handed to restty's canvas renderer.
 */
export function preferTextPresentationForAmbiguousSymbols(text: string): string {
  const codepoints = Array.from(text);
  let result = "";

  for (let index = 0; index < codepoints.length; index += 1) {
    const current = codepoints[index];
    const next = codepoints[index + 1];
    result += current;

    if (
      EXTENDED_PICTOGRAPHIC.test(current) &&
      !DEFAULT_EMOJI_PRESENTATION.test(current) &&
      next !== TEXT_VARIATION_SELECTOR &&
      next !== EMOJI_VARIATION_SELECTOR &&
      next !== ZERO_WIDTH_JOINER
    ) {
      result += TEXT_VARIATION_SELECTOR;
    }
  }

  return result;
}
