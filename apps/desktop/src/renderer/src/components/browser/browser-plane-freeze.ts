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

/** Where the React app mounts. Portals normally land outside it. */
export const APP_ROOT_ID = "root";

/**
 * Roles alone are not enough: permanent lists use listbox too, while hover
 * peeks and link prompts need not have any of these roles. In the portal layer
 * accept semantic surfaces OR positioned boxes. Within the app, accept fixed
 * chrome (our utility/inline positioning conventions) and explicit opt-ins.
 * This also covers new portal surfaces without patching their components.
 */
const FLOATING_OVERLAY_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [role="tooltip"], [data-sonner-toast]';
const POSITIONED_OVERLAY_SELECTOR =
  '.fixed, [style*="position"], [data-radix-popper-content-wrapper], [data-sonner-toast]';

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

/** Whether renderer chrome needs the tier over THIS plane, not its neighbours. */
export function hasNativePlaneOverlay(doc: Document, plane: Element): boolean {
  const bounds = plane.getBoundingClientRect();
  const view = doc.defaultView!;
  const left = Math.max(0, bounds.left);
  const top = Math.max(0, bounds.top);
  const right = Math.min(view.innerWidth, bounds.right);
  const bottom = Math.min(view.innerHeight, bounds.bottom);
  if (right <= left || bottom <= top || view.getComputedStyle(plane).visibility === "hidden") {
    return false;
  }

  const root = doc.getElementById(APP_ROOT_ID);
  const candidates = new Set(
    doc.querySelectorAll(`${EXPLICIT_OVERLAY_SELECTOR}, ${POSITIONED_OVERLAY_SELECTOR}`),
  );
  // Only the small portal layer needs a general walk; never walk a transcript
  // and compute styles for every token on each mutation.
  for (const child of doc.body.children) {
    if (child === root) continue;
    candidates.add(child);
    for (const element of child.querySelectorAll("*")) candidates.add(element);
  }
  for (const element of candidates) {
    // Fixed layout containers and a plane's own descendants are not overlays.
    if (element.contains(plane) || plane.contains(element)) continue;
    const style = view.getComputedStyle(element);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse"
    )
      continue;
    const portaled = root === null || !root.contains(element);
    // Sonner mounts inside the app and positions its items via its stylesheet,
    // not inline styles. Measure each toast, never its empty full-width host.
    const floating =
      element.matches(`${EXPLICIT_OVERLAY_SELECTOR}, [data-sonner-toast]`) ||
      style.position === "fixed" ||
      (portaled && (style.position === "absolute" || element.matches(FLOATING_OVERLAY_SELECTOR)));
    if (!floating) continue;
    // getClientRects excludes display:none ancestors. Do not reject opacity:0:
    // entry animations must start capturing before their first opaque frame.
    for (const rect of element.getClientRects()) {
      if (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.left < right &&
        rect.right > left &&
        rect.top < bottom &&
        rect.bottom > top
      )
        return true;
    }
  }
  return false;
}

/** Keep one still across the small gaps between neighbouring hover surfaces. */
export const PLANE_OVERLAY_RELEASE_MS = 150;

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
