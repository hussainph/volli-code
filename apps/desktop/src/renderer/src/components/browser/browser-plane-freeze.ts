import type { BrowserTabCaptureFrame } from "../../../../ipc/contract";

/**
 * The decision behind freezing a Browser Tab's native plane, kept as a pure
 * module beside the view for the same reason as `tab-focus.ts` and
 * `slider-squiggle.ts`: what the view RENDERS is glue, but WHEN the native
 * plane may detach is a rule about a surface the renderer does not own, and
 * getting it wrong strands a person under a black rectangle or an invisible
 * menu. It is enrolled in the coverage gate so every transition below has a
 * test rather than a screenshot.
 */

/** Where the React app mounts. Everything Radix portals lands outside it. */
export const APP_ROOT_ID = "root";

/**
 * Overlays that live in the portal layer. Matching these ANYWHERE was the
 * VC-251 bug: `[role="listbox"]` also describes a permanent list, and the
 * Ticket Change Set renders one (`ticket-changes-panel.tsx`), so a Browser Tab
 * beside it detached its plane forever and never came back. A floating overlay
 * is distinguished by WHERE it renders, not by its role alone — Radix portals
 * to `document.body`, outside the app root — so the role list only decides
 * what counts once the element is already outside the tree.
 *
 * `[role="tooltip"]` is deliberately ABSENT. Taking the plane down costs a
 * capture and a native detach/reattach, and a tooltip follows the pointer:
 * brushing along a toolbar would tear the plane down and rebuild it once per
 * button. A tooltip that overlaps a Browser Tab loses to it, and that is the
 * cheaper trade — the Ticket asked about dialogs and menus, not hints.
 */
const FLOATING_OVERLAY_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-sonner-toast]';

/**
 * The opt-in for floating chrome the app draws INSIDE its own root, where the
 * portal test cannot see it: the split drop zones, the floating navigation
 * sidebar, the armed-run countdown.
 */
const EXPLICIT_OVERLAY_SELECTOR = "[data-native-plane-overlay]";

/** Whether renderer chrome currently needs to paint above every native child view. */
export function hasNativePlaneOverlay(doc: Document, appRoot?: Element | null): boolean {
  if (doc.querySelector(EXPLICIT_OVERLAY_SELECTOR) !== null) return true;
  const root = appRoot === undefined ? doc.getElementById(APP_ROOT_ID) : appRoot;
  for (const element of doc.querySelectorAll(FLOATING_OVERLAY_SELECTOR)) {
    if (root === null || !root.contains(element)) return true;
  }
  return false;
}

/**
 * How long an overlay waits for pixels before it gives up and shows itself.
 *
 * A WebContentsView composites above the window, so the plane cannot detach
 * until something is ready to stand in its place — which means the overlay is
 * INVISIBLE for exactly this long. Frozen pixels are the nicety; an operable
 * menu is the contract, so the wait is bounded and the themed background is
 * the fallback. Roughly two frames: long enough that a warm capture always
 * wins, short enough that nobody perceives a late menu.
 */
export const PLANE_FREEZE_CAPTURE_TIMEOUT_MS = 120;

/**
 * What a capture attempt has produced so far. `unavailable` is the honest
 * state for both a refusal and a timeout: no pixels are coming, but the
 * overlay must stop waiting either way.
 */
export type PlaneCaptureOutcome =
  | { kind: "pending" }
  | { kind: "frames"; frames: readonly BrowserTabCaptureFrame[] }
  | { kind: "unavailable" };

/** What the pane draws, and whether main's native view may stay attached. */
export interface PlaneFreezeDecision {
  planeVisible: boolean;
  frames: readonly BrowserTabCaptureFrame[];
}

const NO_FRAMES: readonly BrowserTabCaptureFrame[] = [];

function framesOf(outcome: PlaneCaptureOutcome | null): readonly BrowserTabCaptureFrame[] {
  return outcome !== null && outcome.kind === "frames" ? outcome.frames : NO_FRAMES;
}

/**
 * The whole freeze rule, in one place.
 *
 * The ordering that matters: while an overlay is open and pixels have not
 * arrived, the plane stays VISIBLE. Detaching first is what exposed the black
 * hole; detaching only once there is a replacement is what fixes it. The
 * timeout is what stops that wait from becoming an invisible menu.
 */
export function planeFreezeDecision(input: {
  visible: boolean;
  overlayActive: boolean;
  outcome: PlaneCaptureOutcome | null;
}): PlaneFreezeDecision {
  if (!input.visible) return { planeVisible: false, frames: NO_FRAMES };
  if (!input.overlayActive) {
    // The overlay has gone, so the plane may come back — but the frozen pixels
    // KEEP PAINTING until the caller confirms the native view actually
    // reattached. Dropping them the moment React changes its mind exposes the
    // themed background for the length of an IPC round trip, which reads as a
    // flash on every single overlay. Behind a live native view they cost
    // nothing; the caller clears them once main has answered.
    return { planeVisible: true, frames: framesOf(input.outcome) };
  }
  const outcome = input.outcome;
  if (outcome === null || outcome.kind === "pending") {
    return { planeVisible: true, frames: NO_FRAMES };
  }
  if (outcome.kind === "unavailable") return { planeVisible: false, frames: NO_FRAMES };
  return { planeVisible: false, frames: outcome.frames };
}
