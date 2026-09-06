/**
 * The Session cursor overlay page (VC-239): one `SessionCursor`, drawn at a
 * fixed inset, in a page main moves.
 *
 * The cursor's own glide is not used here. Main animates the VIEW's bounds
 * (`View.setBounds` with `animate`) and this page keeps the tip at one inset
 * from its origin, so the component's `x`/`y` never change and its glide is
 * always zero. What main waits on is the ACKNOWLEDGEMENT: every state it
 * pushes carries a `seq`, and the page answers each one — the component's
 * `settleKey` is that `seq`, so a push that moved nothing is still answered
 * at once rather than left to time out at main's bound. Everything else the
 * component does (enter, press ring, typing tag, nudge, exit, handoff,
 * reduced motion) it does here exactly as it does in the lab, because it is
 * the same component.
 *
 * Keeping the view small (Electron has no click-through for child views) is
 * a shared job: this page measures its drawing and reports the size, and main
 * sizes the view to it, so the person's clicks are blocked only where the
 * cursor and its label actually are.
 *
 * The component, apart from its mount (`./main.tsx`), so the ack contract can
 * be tested against a fake bridge.
 */
import * as React from "react";

import { SessionCursor } from "@renderer/components/browser/session-cursor";
import {
  CURSOR_TIP_INSET,
  type CursorOverlayBridge,
  type CursorOverlayState,
} from "../../ipc/cursor-contract";

function useBridgeState(bridge: CursorOverlayBridge): CursorOverlayState | null {
  const [state, setState] = React.useState<CursorOverlayState | null>(null);
  React.useEffect(() => bridge.onState(setState), [bridge]);
  return state;
}

/** The view when only the arrow shows: the tip inset on every side, plus the arrow. */
export const ARROW_ONLY_SIZE = {
  width: CURSOR_TIP_INSET * 2 + 20,
  height: CURSOR_TIP_INSET * 2 + 22,
};

/**
 * Reports the drawing's size to main whenever what is VISIBLE changes.
 *
 * The label is always laid out (it fades, so it cannot be `display: none`),
 * which means the document's scroll size always includes it. Reporting that
 * would keep the view label-sized while the label is invisible — an area the
 * person could not click the page through, for nothing. So the size is the
 * arrow alone unless the label says it is visible, and the label's
 * `data-visible` flip (pin, typing, hover) is what triggers a new report.
 */
function useReportedSize(
  bridge: CursorOverlayBridge,
  ref: React.RefObject<HTMLElement | null>,
  state: CursorOverlayState | null,
) {
  React.useEffect(() => {
    const root = ref.current;
    if (root === null) return;
    const report = (): void => {
      const label = root.querySelector<HTMLElement>(".session-cursor-label");
      const labelVisible = label?.dataset["visible"] === "true";
      bridge.resized(
        labelVisible
          ? {
              width: Math.ceil(document.documentElement.scrollWidth),
              height: Math.ceil(document.documentElement.scrollHeight),
            }
          : ARROW_ONLY_SIZE,
      );
    };
    report();
    const mutations = new MutationObserver(report);
    mutations.observe(root, { attributes: true, subtree: true, attributeFilter: ["data-visible"] });
    const label = root.querySelector(".session-cursor-label");
    const sizes = new ResizeObserver(report);
    if (label !== null) sizes.observe(label);
    return () => {
      mutations.disconnect();
      sizes.disconnect();
    };
    // `state` is the render this measures; each push may change the label.
  }, [bridge, ref, state]);
}

export function CursorOverlayPage({ bridge }: { bridge: CursorOverlayBridge }) {
  const state = useBridgeState(bridge);
  const rootRef = React.useRef<HTMLDivElement>(null);
  useReportedSize(bridge, rootRef, state);
  if (state === null) return <div ref={rootRef} />;
  return (
    <div ref={rootRef} style={{ position: "relative", width: 1, height: 1 }}>
      <SessionCursor
        color={state.color}
        name={state.name}
        x={CURSOR_TIP_INSET}
        y={CURSOR_TIP_INSET}
        present={state.present}
        gesture={state.gesture}
        pressKey={state.pressKey}
        labelPinned={state.labelPinned}
        handoff={state.handoff}
        reducedMotion={state.reducedMotion}
        settleKey={state.seq}
        onSettled={() => bridge.settled(state.seq)}
        onTakeOver={() => bridge.takeOver()}
        onAskToLeave={() => bridge.askToLeave()}
      />
    </div>
  );
}
