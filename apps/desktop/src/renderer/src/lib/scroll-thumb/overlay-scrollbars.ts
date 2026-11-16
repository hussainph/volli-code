/**
 * The app's one scroll thumb (VC-1217): native scrollbars are off everywhere
 * (`scrollbar-width: none` in `globals.css`) and this draws overlay thumbs that
 * take no layout width, on the scrollers the pointer is over or that are
 * scrolling.
 *
 * WHY NOT THE NATIVE BAR. A styled `::-webkit-scrollbar` is a classic bar: it
 * took 10px out of every scroller the moment it overflowed, so content sat 5px
 * off centre and content-sized menus grew 10px wider. The standard
 * `scrollbar-width`/`scrollbar-color` keep macOS's overlay bars only while the
 * system shows scroll bars "when scrolling"; under "Always", or Automatic with a
 * mouse, they are classic again (measured: 11px).
 *
 * TWO LANES. A vertical thumb and a horizontal one, each with its own target:
 * the innermost eligible scroller under the pointer that overflows on that
 * axis. Over a code block that scrolls sideways inside a transcript that scrolls
 * down, both show — as both native bars used to.
 *
 * NO FORCED LAYOUT, AND NOTHING IN A SCROLL HANDLER. Event handlers only record
 * what happened and request an update. An update runs as the callback of a
 * ResizeObserver created for that request and observing `<html>`:
 *
 *   - it runs after layout, so its reads find layout clean;
 *   - its observer is the newest, and callbacks run in creation order, so it is
 *     the last callback of the frame's first delivery: its writes land after
 *     the post-layout reads of every observer that already existed and cannot
 *     force them. An observer some component creates LATER in the same frame
 *     runs after it, and a read there pays a small forced pass over the two
 *     track elements. The writes are transforms, sizes and a clip on two
 *     fixed elements; the browser lays them out again before paint, so a
 *     scroll is drawn in the same frame.
 *
 * A request can never be made from INSIDE a ResizeObserver delivery: a new
 * observation of `<html>` there is shallower than what was just delivered, so
 * Chromium skips it and raises "ResizeObserver loop completed with undelivered
 * notifications". So the observer that watches the targets for size changes,
 * and the MutationObserver that watches their children, only schedule a request
 * for the next animation frame; the content-driven update lands one frame
 * later. Observations are only added from an update (whose own observation is
 * `<html>`, the shallowest there is) or from that next frame, so they never
 * trip that rule either. They cost little: each target, its first 64
 * children and its current last one — at most 65 children, kept up to date as
 * children arrive (a new last child replaces the old) and never rebuilt for a
 * child-list change; and none at all while every thumb is hidden.
 *
 * CSS scroll-driven animation and anchor positioning would have needed no
 * script for position, and were measured and rejected (a Chrome trace of the
 * chat transcript streaming a reply while scrolled hard): merely NAMING a
 * scroll timeline on the transcript made four times as many of
 * `use-stick-to-bottom`'s own `scrollTop` reads force a layout (7 → 31), and an
 * anchored track doubled the layout time of the whole run.
 *
 * LAYERING AND CLIPPING. A track sits right after the body child its target is
 * painted in, at the z-index of the target's outermost stacking layer: above
 * the target, below anything stacked over it (a dialog's scrim) and below any
 * layer at the same level portalled later (a tooltip, a hover card). It is
 * clipped to what of the target its clipping ancestors leave visible — less
 * their scroll-padding, which is where they keep fixed chrome such as the
 * transcript's composer — and hidden when that leaves nothing of it. A
 * scroller under a modal — inside an `aria-hidden` or `inert` subtree, or one
 * that cannot take the pointer, as Radix leaves the page behind one — or one
 * that is not visible, is never a target.
 *
 * The thumbs are presentational: `aria-hidden`, never focusable, and
 * `pointer-events: none`. Wheel, trackpad, keyboard, find-in-page, focus
 * scrolling and `scrollIntoView` all reach the native scroller untouched. A
 * drag is recognised by hit-testing the press against a thumb's lane in a
 * capturing listener — the one synchronous read, once per press — and
 * swallowed there so the press never reaches the content (or a Radix menu's
 * outside-press handler) underneath. A drag ends on release, cancel, blur, a
 * move with no button down, or the scroller unmounting; Escape cancels it and
 * puts the scroll back.
 *
 * Not handled: scrollers inside shadow roots, right-to-left layouts (the
 * vertical thumb stays on the right), forced-colours styling, and an
 * always-visible mode. While a thumb shows, a press on it — within 8px of the
 * scroller's far edge — is the thumb's, not the content's.
 */
import { NATIVE_PLANE_IGNORE_ATTR } from "@renderer/lib/native-plane-ignore";

import {
  EDGE_INSET_PROPERTY,
  THUMB_EDGE_INSET,
  THUMB_THICKNESS,
  TRACK_INSET,
  hitsThumb,
  inThumbLane,
  laneMetrics,
  laneWidth,
  scrollForOffset,
  type Box,
  type LaneMetrics,
} from "./geometry";

/** On each target: the axes it is the target for, `"y"`, `"x"` or `"x y"`. A marker for tests and devtools; no style keys on it. */
export const TARGET_ATTR = "data-scroll-thumb-target";
/**
 * `data-scroll-thumb="none"` on a scroller: it keeps no thumb, and the pointer
 * over it looks further out for one. For strips whose content already says
 * where it is (the tab strip, the board's columns, the checkpoint rail).
 */
export const OPT_OUT_ATTR = "data-scroll-thumb";
/** On `<html>` while a drag is live: stops text selection under the pointer. */
export const DRAGGING_ATTR = "data-scroll-thumb-dragging";
/**
 * Surfaces that draw their own scrollbars out of elements and are never
 * targets: xterm (its `.xterm-scrollable-element` bar) and Monaco. Neither uses
 * a native bar, so turning native bars off leaves neither without one.
 */
export const EXCLUDED_SELECTOR = ".xterm, .monaco-editor";
/**
 * The page behind a modal. Radix's `hideOthers` marks it `aria-hidden` — but
 * skips a subtree holding a live region, which the app root does — and its
 * layer sets `pointer-events: none` on `<body>` with `auto` on the modal
 * itself, which every Radix modal does. So: either marker, or a scroller that
 * cannot take the pointer.
 */
export const BLOCKED_SELECTOR = '[aria-hidden="true"], [inert]';
/** How long a thumb stays up after the last scroll event. */
export const HIDE_AFTER_MS = 700;
/** The one diagnostic an update failure logs, once per window. */
export const UPDATE_FAILED_CODE = "SCROLL_THUMB_UPDATE_FAILED";
/** Geometry changes smaller than this are not worth a style write. */
const PX_EPSILON = 0.1;
/**
 * Children observed for content growth: the first this many, plus the last.
 * Content that grows by adding children is caught by the child-list mutation
 * itself, so a long flat list never needs thousands of observations; a child
 * past these that changes height in place is re-measured on the next scroll or
 * hover.
 */
const OBSERVED_CHILDREN = 64;
/**
 * Dispatched (not bubbling) on a scroller when a drag of its thumb begins. The
 * press itself is swallowed before it reaches the scroller, so anything that
 * gives the reader back control on a press there — "Scroll to latest"'s trip —
 * listens for this too.
 */
export const SCROLL_THUMB_GRAB_EVENT = "scroll-thumb-grab";

type Axis = "x" | "y";

interface LaneGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  length: number;
  offset: number;
  layer: number;
}

const NO_GEOMETRY: LaneGeometry = {
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  length: 0,
  offset: 0,
  layer: 0,
};

interface Lane {
  axis: Axis;
  track: HTMLDivElement;
  thumb: HTMLDivElement;
  target: HTMLElement | null;
  /** The target's drawn box at its last measure; the lane highlight and the press pre-check read it. */
  box: DOMRect | null;
  metrics: LaneMetrics | null;
  /** The z-index of the target's outermost stacking layer, read when the target is taken. */
  layer: number | null;
  /** How far in from the edge the pill is drawn, in the target's CSS px; read with the layer. */
  edgeInset: number;
  /** The grab lane's width in viewport px, at the last measure. */
  lane: number;
  /** Ancestors that clip the target (overflow or paint containment), found when the target is taken. */
  clippers: HTMLElement[] | null;
  /** The body child the target is painted in: the track goes right after it. */
  host: Element | null;
  /** The track's part that is visible, as a `clip-path` inset; `null` when it is wholly clipped away. */
  clip: string | null;
  /** What of the target its clipping ancestors leave visible: a press outside it is not the thumb's. */
  visible: Box | null;
  /** Where the track sits and how big it is, the thumb's length and offset: viewport px. */
  geometry: LaneGeometry;
  /** What {@link flush} last wrote, to skip writes that would change nothing. */
  written: LaneGeometry;
  /** Pointer in this lane: the thumb brightens. */
  aimed: boolean;
}

interface Drag {
  lane: Lane;
  target: HTMLElement;
  pointerId: number;
  /** Pointer coordinate on the axis at the press, and the thumb offset then. */
  startPointer: number;
  startOffset: number;
  /** The scroll at the press, which Escape restores. */
  startScroll: number;
  /** The latest pointer coordinate on the axis. */
  pointer: number;
  frame: number | null;
}

interface ScrollAxes {
  x: boolean;
  y: boolean;
}

/** A pointer's scrollers, one per axis. */
interface Targets {
  y: HTMLElement | null;
  x: HTMLElement | null;
}

const SCROLLABLE = /^(auto|scroll)$/;

function createLane(doc: Document, axis: Axis): Lane {
  const track = doc.createElement("div");
  track.setAttribute("data-slot", "scroll-thumb-track");
  track.setAttribute("data-axis", axis);
  track.setAttribute("data-state", "hidden");
  track.setAttribute("aria-hidden", "true");
  // Presentational, on a scroller's own edge: a Browser Tab's native plane
  // neither yields to it nor re-checks on its every frame.
  track.setAttribute(NATIVE_PLANE_IGNORE_ATTR, "");
  const thumb = doc.createElement("div");
  thumb.setAttribute("data-slot", "scroll-thumb");
  track.append(thumb);
  return {
    axis,
    track,
    thumb,
    target: null,
    box: null,
    metrics: null,
    layer: null,
    edgeInset: THUMB_EDGE_INSET,
    lane: laneWidth(THUMB_EDGE_INSET),
    clippers: null,
    host: null,
    clip: "none",
    visible: null,
    geometry: { ...NO_GEOMETRY },
    written: { ...NO_GEOMETRY },
    aimed: false,
  };
}

function axisPointer(lane: Lane, event: { clientX: number; clientY: number }): number {
  return lane.axis === "y" ? event.clientY : event.clientX;
}

function dragOffset(current: Drag, metrics: LaneMetrics): number {
  const offset = current.startOffset + (current.pointer - current.startPointer);
  return Math.min(metrics.travel, Math.max(0, offset));
}

/**
 * The scroll for a drag's thumb offset. At either end it asks for the end
 * itself rather than a number measured a frame ago, so a drag held at the
 * bottom of a growing transcript is at the true bottom — where
 * `use-stick-to-bottom` takes over again on release.
 */
function writeDragScroll(current: Drag, offset: number, metrics: LaneMetrics): void {
  const scroll =
    metrics.travel > 0 && offset >= metrics.travel
      ? Number.MAX_SAFE_INTEGER
      : scrollForOffset(offset, metrics.travel, metrics.range);
  if (current.lane.axis === "y") current.target.scrollTop = scroll;
  else current.target.scrollLeft = scroll;
}

/** The track's visible part as a `clip-path` inset, `none` when whole, `null` when clipped away. */
function clipFor(geometry: LaneGeometry, visible: Box): string | null {
  const top = Math.max(0, visible.top - geometry.y);
  const left = Math.max(0, visible.left - geometry.x);
  const bottom = Math.max(0, geometry.y + geometry.height - visible.bottom);
  const right = Math.max(0, geometry.x + geometry.width - visible.right);
  if (top + bottom >= geometry.height || left + right >= geometry.width) return null;
  if (top + bottom + left + right < 0.5) return "none";
  return `inset(${top}px ${right}px ${bottom}px ${left}px)`;
}

/**
 * Installs the thumbs on `doc` and returns their teardown. One per document: the
 * main window and the Settings window each run their own.
 */
export function installOverlayScrollbars(doc: Document): () => void {
  const view = doc.defaultView;
  if (view === null) return () => {};
  const win = view;
  const lanes: Record<Axis, Lane> = { y: createLane(doc, "y"), x: createLane(doc, "x") };
  const laneList = [lanes.y, lanes.x];

  let hovered = false;
  /** The scroll container whose targets the pointer last resolved to. `null` when it resolved to none. */
  let hoverContainer: HTMLElement | null = null;
  /** The element of the current scroll burst; lanes targeting it show while it lasts. */
  let scrolled: HTMLElement | null = null;
  let hideTimer: number | undefined;
  let drag: Drag | null = null;
  let swallowClick = false;
  /** Recorded by handlers, resolved in the next update. */
  let pendingHover: Element | null = null;
  let pendingScroll: HTMLElement | null = null;
  /** Where the pointer last moved: a `pointerover` at the same place is content moving under it. */
  let lastPointer: { x: number; y: number } | null = null;
  /** A `pointerover` inside the scrolling element, mid-burst: content moving, resolved when the burst ends. */
  let deferredHover: Element | null = null;
  /** The targets' observations need rebuilding (targets changed, or a child list did). */
  let observationsStale = false;
  /** The elements that carry {@link TARGET_ATTR} in the DOM right now, and with what. */
  const applied = new Map<HTMLElement, string>();
  /** Computed overflow per element: style only, and overflow classes do not toggle in practice. */
  const axesCache = new WeakMap<Element, ScrollAxes | null>();
  let loggedFailure = false;

  /** The pending update's observer. See the header: a new one per request, never inside a delivery. */
  let update: ResizeObserver | null = null;
  /** Inside {@link runUpdate}: whatever changes now is written by its own flush. */
  let updating = false;
  let nextFrameRequest: number | null = null;

  /** Size changes of the targets and their children. Runs inside a delivery: only schedules. */
  const resizes = new win.ResizeObserver(requestUpdateNextFrame);
  /** Child lists of the targets. May run inside a delivery: only schedules. */
  const mutations = new win.MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) if (node instanceof win.Element) pendingAdded.add(node);
      for (const node of record.removedNodes) {
        if (!(node instanceof win.Element)) continue;
        for (const watched of observedChildren.values()) {
          if (watched.delete(node)) resizes.unobserve(node);
        }
      }
    }
    requestUpdateNextFrame();
  });
  /**
   * Per target, the children being observed: its first {@link OBSERVED_CHILDREN}
   * and its last, never more. Children added since are taken in from the next
   * frame, outside any ResizeObserver delivery.
   */
  const observedChildren = new Map<HTMLElement, Set<Element>>();
  const pendingAdded = new Set<Element>();
  /** Whether the targets are being observed at all: released while every thumb is hidden. */
  let observing = false;

  function requestUpdate(): void {
    if (update !== null || updating) return;
    update = new win.ResizeObserver(runUpdate);
    update.observe(doc.documentElement);
  }

  /** For callers that may be inside a ResizeObserver delivery: the request is made from the next frame. */
  function requestUpdateNextFrame(): void {
    if (nextFrameRequest !== null) return;
    nextFrameRequest = win.requestAnimationFrame(() => {
      nextFrameRequest = null;
      // Outside any ResizeObserver delivery: safe to add observations.
      observeAdded();
      requestUpdate();
    });
  }

  function scrollAxes(element: Element): ScrollAxes | null {
    const cached = axesCache.get(element);
    if (cached !== undefined) return cached;
    const style = win.getComputedStyle(element);
    const x = SCROLLABLE.test(style.overflowX);
    const y = SCROLLABLE.test(style.overflowY);
    const axes = x || y ? { x, y } : null;
    axesCache.set(element, axes);
    return axes;
  }

  /** The nearest scroll container at or above `from`, by computed style alone. */
  function containerOf(from: Element | null): HTMLElement | null {
    for (let node = from; node !== null; node = node.parentElement) {
      if (node === doc.body || node === doc.documentElement) return null;
      if (node instanceof win.HTMLElement && scrollAxes(node) !== null) return node;
    }
    return null;
  }

  function blocked(element: Element): boolean {
    if (element.closest(BLOCKED_SELECTOR) !== null) return true;
    const style = win.getComputedStyle(element);
    return style.pointerEvents === "none" || style.visibility !== "visible";
  }

  function eligible(element: HTMLElement): boolean {
    return (
      element.getAttribute(OPT_OUT_ATTR) !== "none" &&
      element.closest(EXCLUDED_SELECTOR) === null &&
      !blocked(element)
    );
  }

  /** The innermost eligible scroller overflowing on each axis, at or above `from`. Reads layout: updates only. */
  function findScrollers(from: Element): Targets {
    const found: Targets = { y: null, x: null };
    if (from.closest(EXCLUDED_SELECTOR) !== null || blocked(from)) return found;
    for (let node = containerOf(from); node !== null; node = containerOf(node.parentElement)) {
      if (!eligible(node)) continue;
      const axes = scrollAxes(node);
      if (axes === null) continue;
      if (found.y === null && axes.y && node.scrollHeight > node.clientHeight + 1) found.y = node;
      if (found.x === null && axes.x && node.scrollWidth > node.clientWidth + 1) found.x = node;
      if (found.y !== null && found.x !== null) break;
    }
    return found;
  }

  function targets(): Set<HTMLElement> {
    const set = new Set<HTMLElement>();
    for (const lane of laneList) if (lane.target !== null) set.add(lane.target);
    return set;
  }

  function containsTarget(element: Element): boolean {
    return laneList.some((lane) => lane.target !== null && element.contains(lane.target));
  }

  /** Points the lanes at `next`. Model only: {@link flush} writes the DOM. */
  function retarget(next: Targets): void {
    if (next.y === lanes.y.target && next.x === lanes.x.target) return;
    for (const lane of laneList) {
      const element = next[lane.axis];
      if (lane.target === element) continue;
      lane.target = element;
      lane.box = null;
      lane.metrics = null;
      lane.layer = null;
      lane.edgeInset = THUMB_EDGE_INSET;
      lane.clippers = null;
      lane.host = null;
      lane.clip = "none";
      lane.visible = null;
      lane.aimed = false;
      lane.geometry = { ...NO_GEOMETRY };
      if (drag !== null && drag.lane === lane) endDrag();
    }
    observationsStale = true;
  }

  /**
   * Rebuilds what the observers watch, for new targets only. Called from an
   * update, whose own observation (`<html>`) is the shallowest possible, so
   * these deeper ones are delivered in the same frame rather than skipped.
   */
  function syncObservations(): void {
    observationsStale = false;
    resizes.disconnect();
    mutations.disconnect();
    observedChildren.clear();
    pendingAdded.clear();
    observing = false;
    for (const element of targets()) {
      observing = true;
      resizes.observe(element);
      observeChildren(element);
      mutations.observe(element, { childList: true });
    }
  }

  /**
   * Brings a target's observed children to its first {@link OBSERVED_CHILDREN}
   * plus its current last child: a new tail replaces the old one (unless that
   * is among the first), so a list that grows by appending stays at 65.
   */
  function observeChildren(element: HTMLElement): void {
    const wanted = new Set<Element>();
    const children = element.children;
    for (let index = 0; index < children.length && index < OBSERVED_CHILDREN; index += 1) {
      wanted.add(children[index]!);
    }
    if (element.lastElementChild !== null) wanted.add(element.lastElementChild);
    const watched = observedChildren.get(element) ?? new Set<Element>();
    for (const child of watched) {
      if (!wanted.has(child)) {
        resizes.unobserve(child);
        watched.delete(child);
      }
    }
    for (const child of wanted) {
      if (!watched.has(child)) {
        resizes.observe(child);
        watched.add(child);
      }
    }
    observedChildren.set(element, watched);
  }

  /** Children added since: the first few of a short list, and each target's new last child. */
  function observeAdded(): void {
    if (pendingAdded.size === 0) return;
    pendingAdded.clear();
    if (!observing) return;
    for (const element of targets()) observeChildren(element);
  }

  /** Stops watching targets whose thumbs are all hidden: a stream there costs nothing until shown again. */
  function releaseObservations(): void {
    if (!observing) return;
    resizes.disconnect();
    mutations.disconnect();
    observedChildren.clear();
    pendingAdded.clear();
    observing = false;
    observationsStale = true;
  }

  /**
   * The z-index of the outermost z-indexed stacking context above the target —
   * a positioned element, or a flex or grid item, with a z-index — which is
   * the layer it is painted in. Read once per newly taken target.
   */
  function layerOf(element: HTMLElement): number {
    let layer = 0;
    for (let node: HTMLElement | null = element; node !== null; node = node.parentElement) {
      if (node === doc.body) break;
      const style = win.getComputedStyle(node);
      if (style.zIndex === "auto") continue;
      const parent = node.parentElement;
      const itemOfFlexOrGrid =
        parent !== null && /(flex|grid)$/.test(win.getComputedStyle(parent).display);
      if (style.position !== "static" || itemOfFlexOrGrid) {
        const z = Number.parseInt(style.zIndex, 10);
        if (Number.isFinite(z)) layer = z;
      }
    }
    return layer;
  }

  /**
   * The ancestors that can clip the target: an overflow other than `visible`,
   * or paint containment. A fixed-position ancestor escapes everything above
   * it, so the walk stops there. Read once per newly taken target.
   */
  function clippersOf(element: HTMLElement): HTMLElement[] {
    const found: HTMLElement[] = [];
    for (let node = element.parentElement; node !== null; node = node.parentElement) {
      if (node === doc.body || node === doc.documentElement) break;
      const style = win.getComputedStyle(node);
      const contain = style.contain;
      if (
        style.overflowX !== "visible" ||
        style.overflowY !== "visible" ||
        /paint|strict|content/.test(contain)
      ) {
        found.push(node);
      }
      if (style.position === "fixed") break;
    }
    return found;
  }

  /**
   * What of `box` is visible through its clipping ancestors. A scrolling
   * ancestor's scroll-padding counts as clipped: it is what that ancestor
   * declares hidden behind its own fixed chrome (the transcript's composer).
   */
  function visibleRect(box: DOMRect, clippers: HTMLElement[]): Box {
    let top = Math.max(box.top, 0);
    let left = Math.max(box.left, 0);
    let bottom = Math.min(box.bottom, win.innerHeight);
    let right = Math.min(box.right, win.innerWidth);
    for (const clipper of clippers) {
      const r = clipper.getBoundingClientRect();
      let padTop = 0;
      let padBottom = 0;
      let padLeft = 0;
      let padRight = 0;
      const axes = scrollAxes(clipper);
      if (axes !== null) {
        const style = win.getComputedStyle(clipper);
        padTop = Number.parseFloat(style.scrollPaddingTop) || 0;
        padBottom = Number.parseFloat(style.scrollPaddingBottom) || 0;
        padLeft = Number.parseFloat(style.scrollPaddingLeft) || 0;
        padRight = Number.parseFloat(style.scrollPaddingRight) || 0;
      }
      top = Math.max(top, r.top + padTop);
      left = Math.max(left, r.left + padLeft);
      bottom = Math.min(bottom, r.bottom - padBottom);
      right = Math.min(right, r.right - padRight);
    }
    return { top, left, bottom, right };
  }

  /** The body child the target is painted in. */
  function hostOf(element: Element): Element | null {
    let node: Element | null = element;
    while (node !== null && node.parentElement !== doc.body) node = node.parentElement;
    return node;
  }

  /** Reads each target's box, sizes and scroll position. Updates only: layout is clean. */
  function measureLanes(): void {
    for (const lane of laneList) {
      const element = lane.target;
      if (element === null) continue;
      if (!element.isConnected || blocked(element)) {
        retarget({
          y: lane.axis === "y" ? null : lanes.y.target,
          x: lane.axis === "x" ? null : lanes.x.target,
        });
        continue;
      }
      const box = element.getBoundingClientRect();
      lane.box = box;
      if (lane.layer === null) {
        lane.layer = layerOf(element);
        lane.clippers = clippersOf(element);
        lane.host = hostOf(element);
        const inset = Number.parseFloat(
          win.getComputedStyle(element).getPropertyValue(EDGE_INSET_PROPERTY),
        );
        lane.edgeInset = Number.isFinite(inset) && inset >= 0 ? inset : THUMB_EDGE_INSET;
      }
      const vertical = lane.axis === "y";
      const layoutSize = vertical ? element.offsetHeight : element.offsetWidth;
      const drawnSize = vertical ? box.height : box.width;
      const scale = layoutSize > 0 ? drawnSize / layoutSize : 1;
      const edgeInset = lane.edgeInset * scale;
      lane.lane = laneWidth(edgeInset);
      const metrics = laneMetrics({
        clientSize: vertical ? element.clientHeight : element.clientWidth,
        scrollSize: vertical ? element.scrollHeight : element.scrollWidth,
        scrollPos: vertical ? element.scrollTop : Math.abs(element.scrollLeft),
        scale,
      });
      lane.metrics = metrics;
      const offset =
        drag !== null && drag.lane === lane ? dragOffset(drag, metrics) : metrics.offset;
      lane.geometry = vertical
        ? {
            x: box.right - edgeInset - THUMB_THICKNESS,
            y: box.top + TRACK_INSET,
            width: THUMB_THICKNESS,
            height: metrics.track,
            length: metrics.length,
            offset,
            layer: lane.layer,
          }
        : {
            x: box.left + TRACK_INSET,
            y: box.bottom - edgeInset - THUMB_THICKNESS,
            width: metrics.track,
            height: THUMB_THICKNESS,
            length: metrics.length,
            offset,
            layer: lane.layer,
          };
      lane.visible = visibleRect(box, lane.clippers ?? []);
      lane.clip = clipFor(lane.geometry, lane.visible);
      // Content grew or shrank under a held drag: keep the content where the
      // thumb is — at the end, if the thumb was taken to the end. Written here,
      // in the update, where layout is already clean.
      if (drag !== null && drag.lane === lane) writeDragScroll(drag, offset, metrics);
    }
  }

  /** Resolves what the handlers recorded, reads the targets, then writes: all after layout. */
  function runUpdate(): void {
    update?.disconnect();
    update = null;
    updating = true;
    try {
      const hover = pendingHover;
      const scroll = pendingScroll;
      pendingHover = null;
      pendingScroll = null;
      if (hover !== null && drag === null) resolveHover(hover);
      else if (scroll !== null && drag === null && (!hovered || containsTarget(scroll))) {
        resolveScroll(scroll);
      }
      measureLanes();
      flush();
      // Watch the targets only while a thumb shows (flush releases them when
      // none does), so hidden updates never churn the observations.
      if (
        observationsStale &&
        laneList.some((lane) => lane.track.getAttribute("data-state") === "visible")
      ) {
        syncObservations();
      }
    } catch (error) {
      // One bad scroller must not freeze every thumb in the window: drop the
      // targets, so the next hover or scroll starts clean.
      if (!loggedFailure) {
        loggedFailure = true;
        console.error(`[scroll-thumb] ${UPDATE_FAILED_CODE}`, error);
      }
      try {
        retarget({ y: null, x: null });
        hovered = false;
        hoverContainer = null;
        flush();
      } catch {
        // Already logged once; the next update tries again.
      }
    } finally {
      updating = false;
    }
  }

  function resolveHover(from: Element): void {
    if (!from.isConnected) return;
    const container = containerOf(from);
    if (container === null) {
      hovered = false;
      hoverContainer = null;
      return;
    }
    // Rows inside the scroller the pointer already resolved to need nothing.
    if (container === hoverContainer) {
      hovered = true;
      return;
    }
    const found = findScrollers(from);
    if (found.y === null && found.x === null) {
      // Nothing here scrolls: no thumb, and no memory of this container, so a
      // list that fills later resolves afresh on the next crossing.
      hovered = false;
      hoverContainer = null;
      return;
    }
    hoverContainer = container;
    retarget(found);
    hovered = true;
  }

  function resolveScroll(element: HTMLElement): void {
    if (!element.isConnected || !eligible(element)) return;
    const axes = scrollAxes(element);
    if (axes === null) return;
    retarget({ y: axes.y ? element : lanes.y.target, x: axes.x ? element : lanes.x.target });
    hoverContainer = null;
    // A pointer resting over it since before the scroll crossed no boundary,
    // so no `pointerover` said so.
    hovered = element.matches(":hover");
  }

  /**
   * Puts a lane's track right after the body child its target is painted in.
   * At the same z-index it then paints above the target's layer, and below any
   * layer portalled later (a tooltip or popover opened over it).
   */
  function placeTrack(lane: Lane): void {
    const host = lane.host;
    if (host === null || !host.isConnected) {
      if (lane.track.parentElement !== doc.body) doc.body.append(lane.track);
      return;
    }
    if (lane.track.previousElementSibling !== host) host.after(lane.track);
  }

  /** Moves and sizes a lane's track and thumb, touching only what changed. Transforms for position. */
  function writeGeometry(lane: Lane): void {
    const next = lane.geometry;
    const last = lane.written;
    const moved = (a: number, b: number) => Math.abs(a - b) >= PX_EPSILON;
    if (moved(next.x, last.x) || moved(next.y, last.y)) {
      lane.track.style.transform = `translate(${next.x}px, ${next.y}px)`;
    }
    if (moved(next.width, last.width)) lane.track.style.width = `${next.width}px`;
    if (moved(next.height, last.height)) lane.track.style.height = `${next.height}px`;
    if (next.layer !== last.layer || lane.track.style.zIndex === "") {
      lane.track.style.zIndex = String(next.layer);
    }
    const vertical = lane.axis === "y";
    if (moved(next.length, last.length)) {
      if (vertical) lane.thumb.style.height = `${next.length}px`;
      else lane.thumb.style.width = `${next.length}px`;
    }
    if (moved(next.offset, last.offset)) {
      lane.thumb.style.transform = vertical
        ? `translateY(${next.offset}px)`
        : `translateX(${next.offset}px)`;
    }
    lane.written = { ...next };
  }

  /** Every DOM write, at the end of the update, after every read. */
  function flush(): void {
    const wanted = new Map<HTMLElement, string>();
    if (lanes.y.target !== null) wanted.set(lanes.y.target, "y");
    if (lanes.x.target !== null) {
      wanted.set(lanes.x.target, wanted.has(lanes.x.target) ? "x y" : "x");
    }
    for (const element of applied.keys()) {
      if (!wanted.has(element)) {
        element.removeAttribute(TARGET_ATTR);
        applied.delete(element);
      }
    }
    for (const [element, value] of wanted) {
      if (applied.get(element) !== value) {
        element.setAttribute(TARGET_ATTR, value);
        applied.set(element, value);
      }
    }
    for (const lane of laneList) {
      const show =
        drag !== null
          ? drag.lane === lane
          : hovered || (scrolled !== null && scrolled === lane.target);
      const state =
        lane.target !== null && lane.metrics?.overflow === true && lane.clip !== null && show
          ? "visible"
          : "hidden";
      const track = lane.track;
      if (state === "visible") {
        placeTrack(lane);
        writeGeometry(lane);
        if (track.style.clipPath !== (lane.clip === "none" ? "" : lane.clip)) {
          track.style.clipPath = lane.clip === "none" ? "" : (lane.clip ?? "");
        }
      }
      if (track.getAttribute("data-state") !== state) track.setAttribute("data-state", state);
      if (track.hasAttribute("data-lane") !== lane.aimed) {
        track.toggleAttribute("data-lane", lane.aimed);
      }
      const dragging = drag !== null && drag.lane === lane;
      if (track.hasAttribute("data-dragging") !== dragging) {
        track.toggleAttribute("data-dragging", dragging);
      }
    }
    const dragging = drag !== null;
    if (doc.documentElement.hasAttribute(DRAGGING_ATTR) !== dragging) {
      doc.documentElement.toggleAttribute(DRAGGING_ATTR, dragging);
    }
    // Nothing shown and nothing held: stop watching, so a target that keeps
    // growing out of sight (a stream the pointer left) runs no updates.
    if (
      !dragging &&
      laneList.every((lane) => lane.track.getAttribute("data-state") !== "visible")
    ) {
      releaseObservations();
    }
  }

  function setHovered(next: boolean): void {
    if (hovered === next) return;
    hovered = next;
    if (!next) {
      hoverContainer = null;
      for (const lane of laneList) lane.aimed = false;
    }
    requestUpdate();
  }

  function handlePointerOver(event: PointerEvent): void {
    if (drag !== null || !(event.target instanceof win.Element)) return;
    const still =
      lastPointer !== null && event.clientX === lastPointer.x && event.clientY === lastPointer.y;
    if (still && scrolled !== null && scrolled.contains(event.target)) {
      // Mid-scroll, what passes under a STILL pointer inside the scrolling
      // element is the content moving, not the reader choosing: it keeps its
      // thumb, and the pointer is resolved when the burst ends. A pointer that
      // moved — into a transcript that is streaming, or elsewhere — is
      // resolved now.
      deferredHover = event.target;
      return;
    }
    deferredHover = null;
    pendingHover = event.target;
    requestUpdate();
  }

  function handlePointerOut(event: PointerEvent): void {
    if (drag !== null || !hovered) return;
    const to = event.relatedTarget;
    if (to instanceof win.Node) {
      for (const lane of laneList) if (lane.target?.contains(to)) return;
    }
    setHovered(false);
  }

  /** Aims a thumb while the pointer is in its lane, from the box cached at the last measure. */
  function handlePointerMove(event: PointerEvent): void {
    lastPointer = { x: event.clientX, y: event.clientY };
    if (drag !== null || !hovered) return;
    for (const lane of laneList) {
      const aimed =
        lane.metrics?.overflow === true &&
        lane.box !== null &&
        inThumbLane(lane.box, lane.axis, event.clientX, event.clientY, lane.lane);
      if (lane.aimed !== aimed) {
        lane.aimed = aimed;
        requestUpdate();
      }
    }
  }

  function handleScroll(event: Event): void {
    const element = event.target;
    if (!(element instanceof win.HTMLElement)) return;
    const isTarget = element === lanes.y.target || element === lanes.x.target;
    if (isTarget || containsTarget(element)) {
      // The target scrolled, or something holding it did: re-read after layout.
      requestUpdate();
    }
    if (!isTarget) {
      // The pointer's scrollers win: a stream autoscrolling elsewhere must not
      // pull a thumb off the list being read. A scroller that HOLDS the target
      // is no stranger: the wheel chained out to it from the hovered one.
      if (drag !== null || (hovered && !containsTarget(element))) return;
      pendingScroll = element;
      requestUpdate();
    }
    if (scrolled !== element) {
      scrolled = element;
      requestUpdate();
    }
    win.clearTimeout(hideTimer);
    hideTimer = win.setTimeout(() => {
      scrolled = null;
      if (deferredHover !== null) {
        pendingHover = deferredHover;
        deferredHover = null;
      }
      requestUpdate();
    }, HIDE_AFTER_MS);
  }

  /** A menu sliding in, a pane resizing: the target moved without scrolling. */
  function handleSettled(event: Event): void {
    const element = event.target;
    if (element instanceof win.Element && containsTarget(element)) requestUpdate();
  }

  function handleResize(): void {
    if (lanes.y.target !== null || lanes.x.target !== null) requestUpdate();
  }

  function handlePointerDown(event: PointerEvent): void {
    swallowClick = false;
    if (event.button !== 0 || drag !== null) return;
    const pressed = event.target;
    if (!(pressed instanceof win.Node)) return;
    for (const lane of laneList) {
      const target = lane.target;
      if (target === null || lane.metrics?.overflow !== true || lane.box === null) continue;
      if (lane.track.getAttribute("data-state") !== "visible") continue;
      // Only a press on the scroller's own content can be a grab: whatever lies
      // over its edge (a resize grip, a floating control) keeps its presses.
      if (!target.contains(pressed)) continue;
      if (!inThumbLane(lane.box, lane.axis, event.clientX, event.clientY, lane.lane)) continue;
      // Only what is drawn can be grabbed: not a part of the thumb its
      // ancestors clip (the transcript's bands under its header and composer).
      const visible = lane.visible;
      if (
        visible === null ||
        event.clientX < visible.left ||
        event.clientX > visible.right ||
        event.clientY < visible.top ||
        event.clientY > visible.bottom
      ) {
        continue;
      }
      const scroller: Box = target.getBoundingClientRect();
      const thumbBox = lane.thumb.getBoundingClientRect();
      if (!hitsThumb(scroller, thumbBox, lane.axis, event.clientX, event.clientY, lane.lane)) {
        continue;
      }
      // Ours: no text selection, no focus move, and no outside-press for a menu.
      event.preventDefault();
      event.stopImmediatePropagation();
      const pointer = axisPointer(lane, event);
      drag = {
        lane,
        target,
        pointerId: event.pointerId,
        startPointer: pointer,
        startOffset: lane.geometry.offset,
        startScroll: lane.axis === "y" ? target.scrollTop : target.scrollLeft,
        pointer,
        frame: null,
      };
      try {
        lane.thumb.setPointerCapture(event.pointerId);
      } catch {
        // A pointer that is already gone ends the drag on its own `pointerup`.
      }
      // The press never reaches the scroller: say so, so whatever is moving it
      // (a trip to the latest message) lets go and the drag wins.
      target.dispatchEvent(new win.Event(SCROLL_THUMB_GRAB_EVENT));
      requestUpdate();
      return;
    }
  }

  function scheduleDragWrite(): void {
    if (drag !== null && drag.frame === null) drag.frame = win.requestAnimationFrame(applyDrag);
  }

  /** Writes the scroll a drag asks for, and moves the thumb with it in the same frame. */
  function applyDrag(): void {
    const current = drag;
    if (current === null) return;
    current.frame = null;
    const { lane, target } = current;
    const metrics = lane.metrics;
    if (!target.isConnected || metrics === null) {
      endDrag();
      return;
    }
    const offset = dragOffset(current, metrics);
    writeDragScroll(current, offset, metrics);
    lane.geometry = { ...lane.geometry, offset };
    writeGeometry(lane);
  }

  function handleDragMove(event: PointerEvent): void {
    const current = drag;
    if (current === null || event.pointerId !== current.pointerId) return;
    event.stopImmediatePropagation();
    if (event.buttons === 0) {
      // The release happened where we could not see it (another app, a lost
      // capture): no button, no drag.
      endDrag();
      return;
    }
    current.pointer = axisPointer(current.lane, event);
    // One write per frame: the pointer cannot be in two places within one.
    scheduleDragWrite();
  }

  function handlePointerUp(event: PointerEvent): void {
    const current = drag;
    if (current === null || event.pointerId !== current.pointerId) return;
    event.stopImmediatePropagation();
    if (current.frame !== null) win.cancelAnimationFrame(current.frame);
    current.frame = null;
    applyDrag();
    // The press was ours, so the click it would complete is ours too.
    swallowClick = event.type === "pointerup";
    endDrag();
  }

  function endDrag(): void {
    const current = drag;
    if (current === null) return;
    if (current.frame !== null) win.cancelAnimationFrame(current.frame);
    drag = null;
    try {
      if (current.lane.thumb.hasPointerCapture(current.pointerId)) {
        current.lane.thumb.releasePointerCapture(current.pointerId);
      }
    } catch {
      // Capture already gone.
    }
    requestUpdate();
  }

  function handleKeyDown(event: KeyboardEvent): void {
    const current = drag;
    if (current === null || event.key !== "Escape") return;
    // Escape cancels the drag, not the menu or dialog it is in.
    event.preventDefault();
    event.stopImmediatePropagation();
    if (current.lane.axis === "y") current.target.scrollTop = current.startScroll;
    else current.target.scrollLeft = current.startScroll;
    endDrag();
  }

  function handleClick(event: MouseEvent): void {
    if (!swallowClick) return;
    swallowClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  const passive = { capture: true, passive: true } as const;
  const active = { capture: true } as const;
  doc.addEventListener("scroll", handleScroll, passive);
  win.addEventListener("pointerover", handlePointerOver, passive);
  win.addEventListener("pointerout", handlePointerOut, passive);
  win.addEventListener("pointermove", handlePointerMove, passive);
  // Window, capturing: ahead of every document and React root listener.
  win.addEventListener("pointerdown", handlePointerDown, active);
  win.addEventListener("pointermove", handleDragMove, active);
  win.addEventListener("pointerup", handlePointerUp, active);
  win.addEventListener("pointercancel", handlePointerUp, active);
  win.addEventListener("keydown", handleKeyDown, active);
  win.addEventListener("click", handleClick, active);
  win.addEventListener("blur", endDrag);
  win.addEventListener("resize", handleResize, passive);
  doc.addEventListener("transitionend", handleSettled, passive);
  doc.addEventListener("animationend", handleSettled, passive);
  for (const lane of laneList) lane.thumb.addEventListener("lostpointercapture", endDrag);

  return () => {
    doc.removeEventListener("scroll", handleScroll, passive);
    win.removeEventListener("pointerover", handlePointerOver, passive);
    win.removeEventListener("pointerout", handlePointerOut, passive);
    win.removeEventListener("pointermove", handlePointerMove, passive);
    win.removeEventListener("pointerdown", handlePointerDown, active);
    win.removeEventListener("pointermove", handleDragMove, active);
    win.removeEventListener("pointerup", handlePointerUp, active);
    win.removeEventListener("pointercancel", handlePointerUp, active);
    win.removeEventListener("keydown", handleKeyDown, active);
    win.removeEventListener("click", handleClick, active);
    win.removeEventListener("blur", endDrag);
    win.removeEventListener("resize", handleResize, passive);
    doc.removeEventListener("transitionend", handleSettled, passive);
    doc.removeEventListener("animationend", handleSettled, passive);
    win.clearTimeout(hideTimer);
    if (nextFrameRequest !== null) win.cancelAnimationFrame(nextFrameRequest);
    if (drag !== null && drag.frame !== null) win.cancelAnimationFrame(drag.frame);
    drag = null;
    update?.disconnect();
    update = null;
    resizes.disconnect();
    mutations.disconnect();
    for (const element of applied.keys()) element.removeAttribute(TARGET_ATTR);
    applied.clear();
    doc.documentElement.removeAttribute(DRAGGING_ATTR);
    for (const lane of laneList) lane.track.remove();
  };
}
