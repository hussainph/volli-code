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
 * The reveal is latched to the TEXT, not to the render that first saw it. This
 * is the whole reason {@link nextRevealState} exists rather than a ref
 * advanced in an effect: a tab strip re-renders constantly while the chat
 * underneath it streams, and a flag derived from "did this render see a
 * change" is false again by the very next one. React would then reuse the same
 * word nodes (their keys are data-derived and unchanged) minus the animation
 * class, cancelling the reveal mid-flight and snapping the words in. Latching
 * on the text means every later render with the same text agrees the reveal is
 * still on, and the CSS one-shot runs to its end.
 */
import * as React from "react";

/** The stagger between two words, in milliseconds. */
export const TITLE_REVEAL_STAGGER_MS = 25;

/**
 * What this component remembers between renders: the text it has accounted
 * for, and the text it is currently revealing (`null` for none).
 */
export interface TitleRevealState {
  seen: string | null;
  revealing: string | null;
}

/** A component that has never rendered has seen nothing and reveals nothing. */
export const INITIAL_REVEAL_STATE: TitleRevealState = { seen: null, revealing: null };

/**
 * The state this component should hold for `text`, given what it holds now.
 *
 * Three cases, and the whole behaviour of the reveal is in them:
 * - the text is unchanged → the state stands, so an unrelated re-render can
 *   never cancel a reveal already under way;
 * - the first text a component ever sees → recorded, never revealed;
 * - a genuine replacement → latched as the text being revealed.
 */
export function nextRevealState(state: TitleRevealState, text: string): TitleRevealState {
  if (state.seen === text) return state;
  return { seen: text, revealing: state.seen === null ? null : text };
}

/** Whether `text` is the text currently being revealed. */
export function isRevealing(state: TitleRevealState, text: string): boolean {
  return state.revealing === text;
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

export interface TitleRevealProps {
  text: string;
  className?: string;
}

export function TitleReveal({ text, className }: TitleRevealProps) {
  const [state, setState] = React.useState<TitleRevealState>(INITIAL_REVEAL_STATE);
  // Adjusting state during render, the documented React pattern for deriving
  // from changed props: React re-runs this component immediately, before any
  // DOM is touched, so no frame ever paints the stale answer.
  const settled = nextRevealState(state, text);
  if (settled !== state) setState(settled);

  const reveal = isRevealing(settled, text);
  const words = text.split(" ");
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
