/**
 * The Session cursor (VC-239): the one component that draws "this Session is
 * acting here" over a Browser Tab, in the Session's own colour.
 *
 * It is one component on purpose, and a self-contained one. The page a
 * Session drives is a native `WebContentsView` composited ABOVE the app's
 * React tree, so nothing drawn here can appear over it from the app; and it
 * must never be injected INTO the page, which could read, hide or fake it.
 * The overlay that actually paints it is a small app-owned view main places
 * over the page, loading a second renderer entry that bundles exactly this
 * file and its stylesheet. The lab scratch renders the same component over a
 * fixture page. If offscreen rendering (VC-253) ever makes the page ordinary
 * DOM, the cursor becomes ordinary DOM by importing this file somewhere else,
 * and the drawing does not change.
 *
 * The contract with whoever drives it:
 *
 *   • `x`/`y` is the tip's target in the plane's pixels. Changing it starts a
 *     glide; `onSettled` fires when the glide LANDS (or at once when there is
 *     nothing to glide), and that is the moment the driver may dispatch the
 *     click. The cursor never lies about where a click went.
 *   • `gesture` names what the Session is doing at the tip: `click` draws the
 *     press ring, `type` parks the label in its typing state, `scroll` nudges.
 *     `pressKey` distinguishes two clicks on one spot.
 *   • `present: false` is the exit — release, turn end, tab hidden. With
 *     `handoff` it exits by draining to a plain arrow first, so a takeover is
 *     seen as the cursor changing hands.
 *   • `reducedMotion` mirrors `prefers-reduced-motion` for a host that cannot
 *     rely on the media query reaching this view (the overlay is told by main;
 *     the lab flips it with a switch).
 *
 * Colour is identity, never state: `@volli/shared`'s `sessionColor` decides
 * the hue and `sessionColorInk` the chip's text, so main, the chrome pill,
 * the tab strip and this cursor agree on which Session is which with nothing
 * but its id in common.
 */
import * as React from "react";
import { pointDistance, sessionColorInk, sessionCursorGlideMs } from "@volli/shared";

import type { SessionCursorGesture } from "../../../../ipc/cursor-contract";
import "./session-cursor.css";

export type { SessionCursorGesture };

export interface SessionCursorProps {
  /** The Session's identity colour, a hex from `sessionColor`. */
  color: string;
  /** The Session's name, for the label chip. */
  name: string;
  /** The tip's target in the plane's own pixels. */
  x: number;
  y: number;
  /** On screen, or fading out. */
  present: boolean;
  /** What the Session is doing at the tip right now. */
  gesture?: SessionCursorGesture;
  /** Bumped per press so a second click on the same spot draws a second ring. */
  pressKey?: number;
  /** Show the label regardless of hover — the moment a hold starts. */
  labelPinned?: boolean;
  /** Exiting because the person took the tab: hand off rather than vanish. */
  handoff?: boolean;
  /** No glides, rings or nudges; positions jump and only opacity eases. */
  reducedMotion?: boolean;
  /** The glide to the current `x`/`y` has landed (or there was none). */
  onSettled?: (target: { x: number; y: number }) => void;
  /** The person's two controls on the hover label. Absent hides them. */
  onTakeOver?: () => void;
  onAskToLeave?: () => void;
}

/**
 * The arrow, tip at the origin: the four-point tilted arrowhead every
 * multiplayer canvas draws its collaborators with — tip, a straight left edge,
 * an inward corner, a right point. No notched tail: the tail is what makes the
 * OS pointer read as the OS pointer, and this cursor has to say "someone else,
 * here" before it says "click". Rounded joins and a hairline white edge come
 * from the stroke, so the geometry stays four lines.
 */
const ARROW_PATH = "M1.5 1.5 L1.5 16.2 L5.9 12.4 L12.6 12.1 Z";

export function SessionCursor({
  color,
  name,
  x,
  y,
  present,
  gesture = null,
  pressKey = 0,
  labelPinned = false,
  handoff = false,
  reducedMotion = false,
  onSettled,
  onTakeOver,
  onAskToLeave,
}: SessionCursorProps) {
  const ink = React.useMemo(() => sessionColorInk(color), [color]);
  // Where the cursor last was, for the distance the glide scales on. A ref
  // rather than state: it is bookkeeping about the previous render, and it
  // must not itself cause one.
  const lastRef = React.useRef<{ x: number; y: number } | null>(null);
  const settledRef = React.useRef(onSettled);
  settledRef.current = onSettled;

  const from = lastRef.current;
  const distance = from === null ? 0 : pointDistance(from, { x, y });
  const glideMs = present ? sessionCursorGlideMs(distance, reducedMotion) : 0;

  // Settle-reporting. Two ways to land: the transform transition ends, or
  // there was no transition to wait for. Both go through one timer-backed
  // path so a transition the compositor skipped (a hidden view, a tab with
  // no frames) still reports within the glide's own bound.
  React.useEffect(() => {
    lastRef.current = { x, y };
    if (!present) return;
    const target = { x, y };
    const timer = window.setTimeout(() => settledRef.current?.(target), glideMs);
    return () => window.clearTimeout(timer);
  }, [x, y, present, glideMs]);

  // Hover is tracked here rather than left to `:hover` alone because the
  // ACTIONS ride only the hover label — a pinned or typing chip says who and
  // what, and a person who wants the controls comes to the cursor for them.
  // Rendering the buttons on every chip made the typing state twice as wide
  // as its message.
  const [hovered, setHovered] = React.useState(false);
  const pinned = labelPinned && present;
  const typing = gesture === "type";
  const showActions = hovered && (onTakeOver !== undefined || onAskToLeave !== undefined);

  return (
    <div
      className="session-cursor"
      data-slot="session-cursor"
      data-present={present ? "true" : "false"}
      data-handoff={handoff ? "true" : "false"}
      data-reduced-motion={reducedMotion ? "true" : "false"}
      style={
        {
          "--session-cursor-x": `${x}px`,
          "--session-cursor-y": `${y}px`,
          "--session-cursor-glide-ms": `${glideMs}ms`,
          "--session-cursor-color": color,
          "--session-cursor-ink": ink,
        } as React.CSSProperties
      }
    >
      <div
        className="session-cursor-body"
        data-gesture={gesture ?? undefined}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
      >
        {/* Keyed on the press so React remounts the ring and the keyframe
            restarts, which is the one case a restart is right. */}
        <span
          key={pressKey}
          aria-hidden
          className="session-cursor-press"
          data-live={gesture === "click" && pressKey > 0 ? "true" : "false"}
        />
        <svg className="session-cursor-arrow" viewBox="0 0 16 20" aria-hidden>
          <path className="line" d={ARROW_PATH} />
        </svg>
        {/* The hover target, a little larger than the arrow so the label can
            be reached without pixel-hunting the tip. */}
        <span className="session-cursor-hit" aria-hidden />
        <div
          className="session-cursor-label"
          data-visible={pinned || typing || hovered ? "true" : "false"}
          role="status"
          aria-live="off"
        >
          <span className="session-cursor-name" title={name}>
            {name}
          </span>
          {typing ? (
            <>
              <span className="session-cursor-state">typing</span>
              <span aria-hidden className="session-cursor-caret" />
            </>
          ) : null}
          {showActions ? (
            <span className="session-cursor-actions">
              {onTakeOver !== undefined ? (
                <button type="button" className="session-cursor-action" onClick={onTakeOver}>
                  Take over
                </button>
              ) : null}
              {onAskToLeave !== undefined ? (
                <button type="button" className="session-cursor-action" onClick={onAskToLeave}>
                  Ask to leave
                </button>
              ) : null}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
