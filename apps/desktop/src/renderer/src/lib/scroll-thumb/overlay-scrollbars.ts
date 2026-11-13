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
 * NO FORCED LAYOUT, AND NOTHING IN A SCROLL HANDLER. Event handlers only
 * record what happened and ask for an update. The update runs as a
 * ResizeObserver callback — after layout, so its reads find layout clean — from
 * an observer created for that request, which makes it the LAST callback of the
 * frame's post-layout pass: its writes land after every other component's own
 * post-layout reads, so they cannot force any of them, and the browser lays the
 * two small fixed elements out again before paint. A scroll is read once per
 * frame and drawn in the same frame.
 *
 * CSS scroll-driven animation and anchor positioning would have needed no
 * script for position, and were measured and rejected (a Chrome trace of the
 * chat transcript streaming a reply while scrolled hard): merely NAMING a
 * scroll timeline on the transcript made four times as many of
 * `use-stick-to-bottom`'s own `scrollTop` reads force a layout (7 → 31), and an
 * anchored track doubled the layout time of the whole run.
 *
 * What script decides:
 *
 *   - WHICH scrollers are targets: those under the pointer, or, when the
 *     pointer is over none, the one that scrolled;
 *   - where each track sits and how long its thumb is, from the target's box
 *     and sizes, and where the thumb sits, from its scroll position;
 *   - visibility (hover, a scroll burst, a drag), and the drag itself.
 *
 * The thumbs are presentational: `aria-hidden`, never focusable, and
 * `pointer-events: none`. Wheel, trackpad, keyboard, find-in-page, focus
 * scrolling and `scrollIntoView` all reach the native scroller untouched. A
 * drag is recognised by hit-testing the press against a thumb's lane in a
 * capturing listener — the one synchronous read, once per press — and
 * swallowed there so the press never reaches the content (or a Radix menu's
 * outside-press handler) underneath.
 */
import {
  THUMB_EDGE_INSET,
  THUMB_THICKNESS,
  TRACK_INSET,
  dragScrollPosition,
  hitsThumb,
  inThumbLane,
  overflows,
  thumbOffset,
  thumbRatio,
  trackLength,
  type DragStart,
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
/** How long a thumb stays up after the last scroll event. */
export const HIDE_AFTER_MS = 700;
/** Geometry changes smaller than this are not worth a style write. */
const PX_EPSILON = 0.1;
/** Children observed for content growth; past this the target's own re-observe covers it. */
const MAX_OBSERVED_CHILDREN = 64;

type Axis = "x" | "y";

interface Lane {
  axis: Axis;
  track: HTMLDivElement;
  thumb: HTMLDivElement;
  target: HTMLElement | null;
  /** The target's box at its last measure; the lane highlight and the press pre-check read it. */
  box: DOMRect | null;
  overflow: boolean;
  /** Where the track sits and how big it is, the thumb's length and offset: viewport px. */
  geometry: LaneGeometry;
  /** What {@link flush} last wrote, to skip writes that would change nothing. */
  written: LaneGeometry;
  /** Pointer in this lane: the thumb brightens. */
  aimed: boolean;
}

interface LaneGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  length: number;
  offset: number;
}

const NO_GEOMETRY: LaneGeometry = { x: 0, y: 0, width: 0, height: 0, length: 0, offset: 0 };

interface Drag extends DragStart {
  lane: Lane;
  target: HTMLElement;
  pointerId: number;
  next: number;
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
  const thumb = doc.createElement("div");
  thumb.setAttribute("data-slot", "scroll-thumb");
  track.append(thumb);
  return {
    axis,
    track,
    thumb,
    target: null,
    box: null,
    overflow: false,
    geometry: { ...NO_GEOMETRY },
    written: { ...NO_GEOMETRY },
    aimed: false,
  };
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
  /** The scroll container whose targets the pointer last resolved to. */
  let hoverContainer: HTMLElement | null = null;
  /** The element of the current scroll burst; lanes targeting it show while it lasts. */
  let scrolled: HTMLElement | null = null;
  let hideTimer: number | undefined;
  let drag: Drag | null = null;
  let swallowClick = false;
  /** Recorded by handlers, resolved after the next layout. */
  let pendingHover: Element | null = null;
  let pendingScroll: HTMLElement | null = null;
  /** A `pointerover` that arrived mid-scroll, resolved when the burst ends. */
  let deferredHover: Element | null = null;
  /** The elements that carry {@link TARGET_ATTR} in the DOM right now, and with what. */
  const applied = new Map<HTMLElement, string>();
  /** Computed overflow per element: style only, and overflow classes do not toggle in practice. */
  const axesCache = new WeakMap<Element, ScrollAxes | null>();
  /** Which scrollers a pointer inside a given scroll container resolves to. */
  let probeCache = new WeakMap<Element, Targets>();

  /** Re-reads the targets after any layout that resized them or their content. */
  const resizes = new win.ResizeObserver(requestUpdate);
  /**
   * The pending post-layout update. A NEW observer per request, on purpose:
   * ResizeObserver callbacks run in the order their observers were created, so
   * the newest runs last — after every other component's own post-layout reads
   * in that frame, which our writes therefore cannot force. Observing an
   * element queues its first notification for the next layout.
   */
  let update: ResizeObserver | null = null;
  /** Inside {@link runUpdate}: whatever changes now is written by its own flush. */
  let updating = false;
  const mutations = new win.MutationObserver(observeContent);

  function requestUpdate(): void {
    if (update !== null || updating) return;
    update = new win.ResizeObserver(runUpdate);
    update.observe(doc.documentElement);
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

  function eligible(element: HTMLElement): boolean {
    return (
      element.getAttribute(OPT_OUT_ATTR) !== "none" && element.closest(EXCLUDED_SELECTOR) === null
    );
  }

  /** The innermost eligible scroller overflowing on each axis, at or above `from`. */
  function findScrollers(from: Element): Targets {
    const found: Targets = { y: null, x: null };
    if (from.closest(EXCLUDED_SELECTOR) !== null) return found;
    for (let node = containerOf(from); node !== null; node = containerOf(node.parentElement)) {
      if (!eligible(node)) continue;
      const axes = scrollAxes(node);
      if (axes === null) continue;
      if (found.y === null && axes.y && overflows(node.clientHeight, node.scrollHeight)) {
        found.y = node;
      }
      if (found.x === null && axes.x && overflows(node.clientWidth, node.scrollWidth)) {
        found.x = node;
      }
      if (found.y !== null && found.x !== null) break;
    }
    return found;
  }

  /** Points the lanes at `next`. Model only: {@link flush} writes the DOM. */
  function retarget(next: Targets): void {
    if (next.y === lanes.y.target && next.x === lanes.x.target) return;
    for (const lane of laneList) {
      const element = next[lane.axis];
      if (lane.target === element) continue;
      lane.target = element;
      lane.box = null;
      lane.overflow = false;
      lane.aimed = false;
      lane.geometry = { ...NO_GEOMETRY };
    }
    resizes.disconnect();
    mutations.disconnect();
    observeContent();
    for (const element of new Set([next.y, next.x])) {
      if (element !== null) mutations.observe(element, { childList: true });
    }
    requestUpdate();
  }

  /**
   * Content growth does not resize a scroller's own box, so its children are
   * observed too. Re-observing a target queues a fresh measure for a child list
   * that changed beyond the observed ones.
   */
  function observeContent(): void {
    for (const element of new Set([lanes.y.target, lanes.x.target])) {
      if (element === null) continue;
      resizes.observe(element);
      const children = element.children;
      for (let index = 0; index < children.length && index < MAX_OBSERVED_CHILDREN; index += 1) {
        resizes.observe(children[index]!);
      }
    }
  }

  /** Reads each target's box, sizes and scroll position. Called only from ResizeObserver callbacks, after layout. */
  function measureLanes(): void {
    let lost = false;
    for (const lane of laneList) {
      const element = lane.target;
      if (element === null) continue;
      if (!element.isConnected) {
        lost = true;
        continue;
      }
      const box = element.getBoundingClientRect();
      lane.box = box;
      if (lane.axis === "y") {
        const { clientHeight, scrollHeight, scrollTop } = element;
        lane.overflow = overflows(clientHeight, scrollHeight);
        const track = trackLength(clientHeight);
        lane.geometry = {
          x: box.right - THUMB_EDGE_INSET - THUMB_THICKNESS,
          y: box.top + TRACK_INSET,
          width: THUMB_THICKNESS,
          height: track,
          length: track * thumbRatio(clientHeight, scrollHeight),
          offset: thumbOffset(scrollTop, clientHeight, scrollHeight),
        };
      } else {
        const { clientWidth, scrollWidth, scrollLeft } = element;
        lane.overflow = overflows(clientWidth, scrollWidth);
        const track = trackLength(clientWidth);
        lane.geometry = {
          x: box.left + TRACK_INSET,
          y: box.bottom - THUMB_EDGE_INSET - THUMB_THICKNESS,
          width: track,
          height: THUMB_THICKNESS,
          length: track * thumbRatio(clientWidth, scrollWidth),
          offset: thumbOffset(Math.abs(scrollLeft), clientWidth, scrollWidth),
        };
      }
    }
    if (lost) {
      retarget({
        y: lanes.y.target?.isConnected ? lanes.y.target : null,
        x: lanes.x.target?.isConnected ? lanes.x.target : null,
      });
    }
  }

  /** Resolves what the handlers recorded, reads the targets, then writes: all after layout. */
  function runUpdate(): void {
    update?.disconnect();
    update = null;
    updating = true;
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
    updating = false;
  }

  function resolveHover(from: Element): void {
    if (!from.isConnected) return;
    const container = containerOf(from);
    if (container === null) {
      setHovered(false);
      return;
    }
    // Rows, spans and links inside the same scroller resolve the same way:
    // only entering a different scroll container can change the targets.
    if (container === hoverContainer) {
      setHovered(lanes.y.target !== null || lanes.x.target !== null);
      return;
    }
    let targets = probeCache.get(container);
    if (targets === undefined) {
      targets = findScrollers(from);
      probeCache.set(container, targets);
    }
    hoverContainer = container;
    if (targets.y === null && targets.x === null) {
      setHovered(false);
      return;
    }
    retarget(targets);
    setHovered(true);
  }

  function resolveScroll(element: HTMLElement): void {
    if (!element.isConnected || !eligible(element)) return;
    const axes = scrollAxes(element);
    if (axes === null) return;
    retarget({ y: axes.y ? element : lanes.y.target, x: axes.x ? element : lanes.x.target });
    // A pointer resting over it since before the scroll crossed no boundary,
    // so no `pointerover` said so.
    setHovered(element.matches(":hover"));
    probeCache = new WeakMap();
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

  /** Keeps the tracks last in `<body>`, after any portal opened since: an anchor must precede what it positions. */
  function mountTracks(): void {
    const body = doc.body;
    if (body === null) return;
    if (
      body.lastElementChild === lanes.x.track &&
      lanes.x.track.previousElementSibling === lanes.y.track
    ) {
      return;
    }
    body.append(lanes.y.track, lanes.x.track);
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
    if (wanted.size > 0) mountTracks();
    for (const lane of laneList) {
      const show =
        drag !== null
          ? drag.lane === lane
          : hovered || (scrolled !== null && scrolled === lane.target);
      const state = lane.target !== null && lane.overflow && show ? "visible" : "hidden";
      const track = lane.track;
      if (state === "visible") writeGeometry(lane);
      if (track.getAttribute("data-state") !== state) track.setAttribute("data-state", state);
      if (track.hasAttribute("data-lane") !== lane.aimed)
        track.toggleAttribute("data-lane", lane.aimed);
      const dragging = drag !== null && drag.lane === lane;
      if (track.hasAttribute("data-dragging") !== dragging) {
        track.toggleAttribute("data-dragging", dragging);
      }
    }
    const dragging = drag !== null;
    if (doc.documentElement.hasAttribute(DRAGGING_ATTR) !== dragging) {
      doc.documentElement.toggleAttribute(DRAGGING_ATTR, dragging);
    }
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

  function handlePointerOver(event: PointerEvent): void {
    if (drag !== null || !(event.target instanceof win.Element)) return;
    if (scrolled !== null) {
      // Mid-scroll, what passes under a still pointer is the content moving,
      // not the reader choosing: the scrolling element keeps its thumb, and the
      // pointer is resolved when the burst ends.
      deferredHover = event.target;
      return;
    }
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
    if (drag !== null || !hovered) return;
    for (const lane of laneList) {
      const aimed =
        lane.overflow &&
        lane.box !== null &&
        inThumbLane(lane.box, lane.axis, event.clientX, event.clientY);
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

  function containsTarget(element: Element): boolean {
    return laneList.some((lane) => lane.target !== null && element.contains(lane.target));
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
      if (target === null || !lane.overflow || lane.box === null) continue;
      if (lane.track.getAttribute("data-state") !== "visible") continue;
      // Only a press on the scroller's own content can be a grab: whatever lies
      // over its edge (a resize grip, a floating control) keeps its presses.
      if (!target.contains(pressed)) continue;
      if (!inThumbLane(lane.box, lane.axis, event.clientX, event.clientY)) continue;
      const scroller = target.getBoundingClientRect();
      const thumb = lane.thumb.getBoundingClientRect();
      if (!hitsThumb(scroller, thumb, lane.axis, event.clientX, event.clientY)) continue;
      // Ours: no text selection, no focus move, and no outside-press for a menu.
      event.preventDefault();
      event.stopImmediatePropagation();
      const vertical = lane.axis === "y";
      const scroll = vertical ? target.scrollTop : target.scrollLeft;
      drag = {
        lane,
        target,
        pointerId: event.pointerId,
        pointer: vertical ? event.clientY : event.clientX,
        scroll,
        clientSize: vertical ? target.clientHeight : target.clientWidth,
        scrollSize: vertical ? target.scrollHeight : target.scrollWidth,
        next: scroll,
        frame: null,
      };
      try {
        lane.thumb.setPointerCapture(event.pointerId);
      } catch {
        // A pointer that is already gone ends the drag on its own `pointerup`.
      }
      requestUpdate();
      return;
    }
  }

  /** Writes the scroll a drag asked for, and moves the thumb with it in the same frame. */
  function applyDrag(): void {
    if (drag === null) return;
    drag.frame = null;
    const lane = drag.lane;
    if (lane.axis === "y") drag.target.scrollTop = drag.next;
    else drag.target.scrollLeft = drag.next;
    lane.geometry = {
      ...lane.geometry,
      offset: thumbOffset(drag.next, drag.clientSize, drag.scrollSize),
    };
    writeGeometry(lane);
  }

  function handleDragMove(event: PointerEvent): void {
    if (drag === null || event.pointerId !== drag.pointerId) return;
    event.stopImmediatePropagation();
    drag.next = dragScrollPosition(drag, drag.lane.axis === "y" ? event.clientY : event.clientX);
    // One write per frame: the pointer cannot be in two places within one.
    if (drag.frame === null) drag.frame = win.requestAnimationFrame(applyDrag);
  }

  function endDrag(event: PointerEvent): void {
    if (drag === null || event.pointerId !== drag.pointerId) return;
    event.stopImmediatePropagation();
    if (drag.frame !== null) win.cancelAnimationFrame(drag.frame);
    applyDrag();
    // The press was ours, so the click it would complete is ours too.
    swallowClick = event.type === "pointerup";
    drag = null;
    requestUpdate();
  }

  function handleLostCapture(): void {
    if (drag === null) return;
    if (drag.frame !== null) win.cancelAnimationFrame(drag.frame);
    drag = null;
    requestUpdate();
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
  win.addEventListener("pointerup", endDrag, active);
  win.addEventListener("pointercancel", endDrag, active);
  win.addEventListener("click", handleClick, active);
  win.addEventListener("resize", handleResize, passive);
  doc.addEventListener("transitionend", handleSettled, passive);
  doc.addEventListener("animationend", handleSettled, passive);
  for (const lane of laneList) lane.thumb.addEventListener("lostpointercapture", handleLostCapture);

  return () => {
    doc.removeEventListener("scroll", handleScroll, passive);
    win.removeEventListener("pointerover", handlePointerOver, passive);
    win.removeEventListener("pointerout", handlePointerOut, passive);
    win.removeEventListener("pointermove", handlePointerMove, passive);
    win.removeEventListener("pointerdown", handlePointerDown, active);
    win.removeEventListener("pointermove", handleDragMove, active);
    win.removeEventListener("pointerup", endDrag, active);
    win.removeEventListener("pointercancel", endDrag, active);
    win.removeEventListener("click", handleClick, active);
    win.removeEventListener("resize", handleResize, passive);
    doc.removeEventListener("transitionend", handleSettled, passive);
    doc.removeEventListener("animationend", handleSettled, passive);
    win.clearTimeout(hideTimer);
    if (drag !== null && drag.frame !== null) win.cancelAnimationFrame(drag.frame);
    drag = null;
    resizes.disconnect();
    update?.disconnect();
    update = null;
    mutations.disconnect();
    for (const element of applied.keys()) element.removeAttribute(TARGET_ATTR);
    applied.clear();
    doc.documentElement.removeAttribute(DRAGGING_ATTR);
    for (const lane of laneList) lane.track.remove();
  };
}
