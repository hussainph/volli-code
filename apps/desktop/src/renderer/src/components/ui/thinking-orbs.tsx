/**
 * The running mark — three orbs, pulsing in sequence.
 *
 * It answers exactly one question, the one a reader asks of a chat pane over
 * and over: is the agent still going? A transcript is a feed of settled rows,
 * and a settled row looks identical whether the turn ended a second ago or is
 * two tool calls from finishing — which is what made a live Session hard to
 * parse at a glance. So the mark is not a status word and not a second copy of
 * what the rows already say; it is a sign of life, and it exists only while
 * there is life to sign for.
 *
 * ORBS RATHER THAN A SPINNER, and the difference is what each one claims. A
 * spinner says "you are waiting on this" — it is what a row wears while one
 * call is in flight, and it belongs to that call. The turn is not a call: it is
 * the whole reply, most of which the reader can already read. Three orbs
 * breathing is the idiom every messaging surface converged on for exactly this
 * (iMessage, Slack, ChatGPT), and it carries no urgency at all, which is right
 * for something that may be on screen for ten minutes.
 *
 * CSS ANIMATION, NEVER A JS TIMELINE. This mark's whole life is spent beside a
 * transcript that is streaming tokens, which is to say beside a busy main
 * thread — and a `requestAnimationFrame` loop drops exactly the frames the
 * answer is competing for. Keyframes on `transform` and `opacity` run on the
 * compositor: the shape is declared once in `globals.css` and the main thread
 * is never asked about it again, however hard the turn is working.
 *
 * `aria-hidden`, always, and for the reason {@link StatusDot} gives: the mark
 * is never the only place its state is said. The caller owns the words —
 * visibly, or `sr-only` inside a live region — so an announcement here would
 * read the same fact twice.
 */
import { cn } from "@renderer/lib/utils";

export interface ThinkingOrbsProps {
  className?: string;
}

/**
 * The orbs take their colour from the caller (`bg-current`), so a call site
 * decides whether this is an ember in-flight mark or a muted one. The
 * transcript's other live glyphs are ember, and the tail follows them.
 */
export function ThinkingOrbs({ className }: ThinkingOrbsProps) {
  return (
    <span
      aria-hidden
      data-slot="thinking-orbs"
      // 16px across against the transcript's 14px glyph column, which is the
      // one place a group is allowed to outgrow that column: it is a cluster
      // rather than a glyph, and squeezing three orbs plus their gaps into 14px
      // costs a whole pixel of orb — at 3px they stop reading as objects and
      // start reading as an ellipsis.
      className={cn("flex shrink-0 items-center gap-0.5", className)}
    >
      {/* Three spans rather than a loop: the stagger is `:nth-child` in CSS, so
          the markup is the timeline and there is nothing to key. */}
      <span className="thinking-orb size-1 rounded-full bg-current" />
      <span className="thinking-orb size-1 rounded-full bg-current" />
      <span className="thinking-orb size-1 rounded-full bg-current" />
    </span>
  );
}
