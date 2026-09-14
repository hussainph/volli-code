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
 * Ticket Change Set rendered one until VC-311 gave it a plain `list`, so a
 * Browser Tab beside it detached its plane forever and never came back. The
 * rule outlived that particular list — a composer's completion menu is a real
 * listbox, and Settings draws permanent ones. A floating overlay
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

/** The anchor a Browser Tab's `WebContentsView` is positioned over. */
const PLANE_ANCHOR_SELECTOR = "[data-browser-plane]";

/**
 * Whether a native plane is on screen RIGHT NOW — the question the shell asks
 * before it decides to move the whole content surface on a transform.
 *
 * A live `WebContentsView` is the window's own child, not a DOM node: it cannot
 * inherit a renderer transform, so a surface that slides while a plane is up
 * detaches page pixels from the Browser chrome around them for the whole
 * journey. The freeze path above can stand pixels in for a plane, but only
 * after an asynchronous capture settles, so the shell takes its instant
 * endpoint instead of hiding that dependency inside an animation.
 *
 * It lives here rather than in the shell because `[data-browser-plane]` is
 * `browser-pane.tsx`'s marker and this module already owns every rule about
 * when that plane may hold the top of the window. `offsetParent` catches an
 * unmounted or `display:none` pane; the size test catches a pane that is in the
 * tree with nothing to show, which is what a collapsed split leaves behind.
 */
export function hasVisibleNativePlane(doc: Document): boolean {
  for (const plane of doc.querySelectorAll<HTMLElement>(PLANE_ANCHOR_SELECTOR)) {
    if (plane.offsetParent !== null && plane.clientWidth > 0 && plane.clientHeight > 0) return true;
  }
  return false;
}

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
 * How long an overlay will wait for the true last frame before giving up.
 *
 * The pixels are captured PER OVERLAY, at the moment one opens, because that
 * is the only way the stand-in matches what the person was looking at. A frame
 * captured ahead of time is stale by however long ago it was taken, and on an
 * animating page — or after a scroll the renderer cannot even observe, since
 * the wheel goes to the native view — it visibly jumps backwards.
 *
 * That fidelity is affordable because the capture is cheap: JPEG encoding
 * measured 11-17ms on the smoke fixture, about one frame. This deadline exists
 * only so a pathological page cannot hide a menu; in the normal case the
 * pixels arrive long before it.
 */
export const PLANE_CAPTURE_DEADLINE_MS = 80;

/**
 * Whether the native plane may hold the top of the window right now.
 *
 * It keeps the tier until the stand-in pixels are settled, so the page is never
 * replaced by a hole: detaching first is what showed a black rectangle. Once
 * settled — by pixels arriving or by the deadline passing — it yields.
 */
export function planeVisibility(input: {
  visible: boolean;
  overlayActive: boolean;
  captureSettled: boolean;
}): boolean {
  return input.visible && !(input.overlayActive && input.captureSettled);
}

/**
 * Whether the captured frames should be in the tree.
 *
 * Whenever the pane is visible and it has any — not only while an overlay is
 * open. While the plane holds the tier the native view covers them completely,
 * so they cost nothing to leave painted, and leaving them painted is what makes
 * the hand-off seamless in BOTH directions: there is no frame in which neither
 * the page nor its stand-in is on screen. Clearing them as the plane came back
 * is what made every overlay end in a flash of themed background.
 */
export function shouldPaintPlanePixels(input: { visible: boolean; frameCount: number }): boolean {
  return input.visible && input.frameCount > 0;
}
