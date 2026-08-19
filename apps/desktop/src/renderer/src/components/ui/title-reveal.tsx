/**
 * A tab label that reveals word by word when its text CHANGES — the one motion
 * a landing auto-title earns (VC-81).
 *
 * What this is not: an entrance animation. On first mount the label renders
 * static, because a boot or a tab strip remount is not a title landing and a
 * strip of flying labels would read as the app stuttering. The reveal fires
 * only when an already-visible label is replaced — the heuristic title
 * sharpening into the model's, or a rename committing — and it is the
 * gentlest bridge a label swap can get: words fade up 2px in sequence, under
 * 300ms for the longest real title, on the compositor (opacity + transform
 * only, CSS keyframes, no JS timeline beside a busy chat).
 *
 * Reduced motion drops the motion outright rather than parking it mid-word,
 * which is the repo's own sweep rule: a frozen half-revealed word reads as a
 * rendering bug, a static label reads as a label.
 *
 * `previous` lives in a ref rather than state on purpose: the change is
 * detected during the render that replaces the text, and the ref is then
 * advanced in an effect. Reading it from state would re-render with the
 * animation classes gone the instant the effect settled — the reveal would
 * commit and then be stripped before a frame drew.
 */
import * as React from "react";

/** One label, as words — the unit the stagger animates. */
export function titleWords(text: string): readonly string[] {
  return text.split(" ");
}

/**
 * A data-dependent key per word: the word itself, disambiguated by its
 * occurrence count so a repeated word cannot collide, and never by the array
 * index (react/no-array-index-key). Changing the text changes the keys, which
 * is exactly what re-arms the one-shot reveal.
 */
export function titleWordKeys(words: readonly string[]): readonly string[] {
  const seen = new Map<string, number>();
  return words.map((word) => {
    const count = (seen.get(word) ?? 0) + 1;
    seen.set(word, count);
    return `${word}:${count}`;
  });
}

/**
 * Whether a label change is a reveal: any real change on an already-painted
 * label. `null` is a component's first paint, which stays still.
 */
export function shouldRevealTitle(previous: string | null, next: string): boolean {
  return previous !== null && previous !== next;
}

/** The stagger between two words, in milliseconds. */
export const TITLE_REVEAL_STAGGER_MS = 25;

export interface TitleRevealProps {
  text: string;
  className?: string;
}

export function TitleReveal({ text, className }: TitleRevealProps) {
  const previous = React.useRef<string | null>(null);
  const reveal = shouldRevealTitle(previous.current, text);
  React.useEffect(() => {
    previous.current = text;
  }, [text]);

  const words = titleWords(text);
  const keys = titleWordKeys(words);

  return (
    <span className={className}>
      {words.map((word, index) => (
        <React.Fragment key={keys[index]}>
          {index > 0 ? " " : null}
          <span
            className={reveal ? "title-reveal-word inline-block" : undefined}
            style={reveal ? { animationDelay: `${index * TITLE_REVEAL_STAGGER_MS}ms` } : undefined}
          >
            {word}
          </span>
        </React.Fragment>
      ))}
    </span>
  );
}
