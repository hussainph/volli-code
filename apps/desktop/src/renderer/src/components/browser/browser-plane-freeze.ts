/**
 * When a Browser Tab's native plane may hold the top of the window, and which
 * pixels stand in for it when it may not.
 *
 * Kept as a pure module beside the view for the same reason as `tab-focus.ts`
 * and `slider-squiggle.ts`: what the view RENDERS is glue, but this rule
 * decides whether a person gets an operable overlay or stares at a black
 * rectangle, and none of its transitions is visible in a screenshot. Enrolled
 * in the coverage gate so each one has a test.
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
 * `[role="tooltip"]` is deliberately ABSENT. A tooltip follows the pointer, so
 * brushing along a toolbar would swap the plane once per button. A tooltip that
 * overlaps a Browser Tab loses to it: the Ticket asked about dialogs and menus.
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
 * The shortest interval between two refreshes of the stand-in pixels.
 *
 * The refresh rides on `pointerdown`/`keydown` — the gestures that precede
 * essentially every overlay — so this only has to stop a drag or a held key
 * from asking main for a screenshot per event. A person cannot open two
 * overlays inside this window, so the frames are never meaningfully stale.
 */
export const PLANE_REFRESH_MIN_INTERVAL_MS = 200;

/**
 * Whether the native plane may hold the top of the window right now.
 *
 * There is no asynchronous term in this. An earlier pass asked main for a
 * screenshot AT THE MOMENT an overlay opened and detached only once it
 * answered, which put an IPC round trip on the critical path: the overlay
 * opened behind the web page and jumped in front when the pixels landed. The
 * stand-in pixels are captured ahead of time instead, so yielding the tier is
 * a synchronous decision and the swap is seamless in both directions.
 */
export function planeVisibility(input: { visible: boolean; overlayActive: boolean }): boolean {
  return input.visible && !input.overlayActive;
}

/**
 * Whether a fresh capture is worth taking now.
 *
 * Only while the plane actually holds the window: a detached view has nothing
 * current to photograph, and the frames it would answer with are the ones
 * already on screen. `sinceLastMs` of `null` means nothing has been captured
 * yet, which is always worth one.
 */
export function shouldRefreshPlanePixels(input: {
  visible: boolean;
  overlayActive: boolean;
  captureInFlight: boolean;
  sinceLastMs: number | null;
}): boolean {
  if (!input.visible || input.overlayActive || input.captureInFlight) return false;
  return input.sinceLastMs === null || input.sinceLastMs >= PLANE_REFRESH_MIN_INTERVAL_MS;
}
