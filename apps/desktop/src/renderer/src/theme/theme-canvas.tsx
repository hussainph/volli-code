import * as React from "react";

import { nextCanvasLayers, type CanvasLayers } from "@renderer/theme/canvas-layer";
import {
  SCOPE_REPAINT_HOLD_MS,
  SCOPE_TRANSITION_ATTRIBUTE,
  SCOPE_TRANSITION_VALUE,
} from "@renderer/theme/scope-transition";

/**
 * The layer the whole app floats on (#74, docs/plans/theming-engine.md
 * § Canvas + shaders) — Arc's arrangement: one root-level surface beneath the
 * chrome band, the project rail and the sidebar, with only the framed content
 * card (#31) staying opaque over it.
 *
 * Its contract is grain's, one level up, and every rule is defensive:
 *
 *  - `z-index: -1` — it paints after the host's own fill and before every
 *    in-flow sibling, so it is *structurally* incapable of landing above the
 *    nav text drawn on it. `SidebarProvider` carries `isolate` to make that
 *    stacking context exist.
 *  - `contain: strict` — a window-sized gradient stays out of every layout and
 *    paint invalidation above it. (`contain: size` is safe: an inset-0
 *    absolutely positioned box takes its size from its insets.)
 *  - `pointer-events: none` + `aria-hidden` — a full-window element that
 *    swallowed a click or announced itself would be a bug in every direction.
 *
 * It must also mount OUTSIDE the `zoom: uiScale` row, exactly like ChromeBar:
 * a zoomed canvas would rescale its own gradient every time ⌘+ is pressed.
 *
 * **Grain does not move here.** In this arrangement the canvas is precisely the
 * surface sidebar nav labels are drawn on, which makes it the worst place for
 * texture rather than the best — see `@volli/shared`'s `DEFAULT_THEME`.
 */
export function ThemeCanvas({ background }: { background: string }) {
  const [layers, setLayers] = React.useState<CanvasLayers>(() => ({
    current: background,
    outgoing: null,
  }));

  // Layout, not passive: the attribute `beginScopeRepaint()` sets is already on
  // the root by the time this runs (the store arms it before it moves the
  // tokens), and reading it here is what decides whether this repaint is the
  // kind that eases. Nothing else in the app can arm the canvas.
  React.useLayoutEffect(() => {
    const eased =
      document.documentElement.getAttribute(SCOPE_TRANSITION_ATTRIBUTE) === SCOPE_TRANSITION_VALUE;
    setLayers((current) => nextCanvasLayers(current, background, eased));
  }, [background]);

  const fading = layers.outgoing !== null;
  React.useEffect(() => {
    if (!fading) return;
    // The fade itself is a CSS animation on `--theme-scope-crossfade`, so this
    // only has to drop the spent layer afterwards. Same hold as the token
    // crossfade, tail included, so the last frame lands before it goes.
    const timer = setTimeout(
      () => setLayers((current) => ({ ...current, outgoing: null })),
      SCOPE_REPAINT_HOLD_MS,
    );
    return () => clearTimeout(timer);
  }, [fading]);

  return (
    <div
      aria-hidden="true"
      data-volli-canvas=""
      style={{
        position: "absolute",
        inset: 0,
        zIndex: -1,
        pointerEvents: "none",
        contain: "strict",
      }}
    >
      <div style={{ position: "absolute", inset: 0, background: layers.current }} />
      {/* The outgoing canvas, on top and fading out over the new one. Two
          layers rather than one whose `background` moves, because
          `background-image` does not interpolate — a solid and a mesh have no
          value in between, so a project switch would hard-cut the canvas while
          every other token eased. */}
      {layers.outgoing === null ? null : (
        <div
          data-volli-canvas-outgoing=""
          style={{ position: "absolute", inset: 0, background: layers.outgoing }}
        />
      )}
    </div>
  );
}
