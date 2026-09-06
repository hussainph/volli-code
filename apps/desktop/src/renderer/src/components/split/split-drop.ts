/**
 * WHAT A DROP ON THE PLANE MEANS — no DOM, no dnd-kit (VC-202 §4).
 *
 * The same division `ui/tab-reorder.ts` makes one scope down, for the same
 * reason: dnd-kit owns the gesture, this owns the decision the gesture
 * produces. Three decisions, in fact, and every one of them is arithmetic or a
 * lookup that a screenshot could not tell you was wrong —
 *
 *  1. **Which zone the pointer is in.** A pane's content box is tiled by three
 *     targets: an outer band down its right edge, an outer band across its
 *     bottom, and the centre that is left. An off-by-one here is a split that
 *     opens on the wrong edge from where the person let go.
 *  2. **Whether a payload may land here at all.** The sidebars drag NATIVELY
 *     (HTML5 `dataTransfer`), and their rows outlive the surface they were
 *     dragged from: a ticket-A Session must not land on ticket B or on Home,
 *     and a project Session must not land in a ticket workspace. Tabs never
 *     move between surfaces (§ "Deliberate constraints").
 *  3. **Which store write a drop is.** Reorder inside one pane, move to another
 *     pane, or split a pane open — one function, so the two surfaces cannot
 *     answer it differently.
 *
 * It also holds the one piece of MODULE STATE this feature needs, and the
 * reason is a browser rule rather than a preference: `dataTransfer.getData()`
 * is unreadable during `dragover` (only `types` is), so a zone cannot inspect
 * a payload while deciding whether to light up for it. Every source is in this
 * window, so the drag announces itself here on `dragstart` and withdraws on
 * `dragend`, and the zones read THAT while the drag is live. The `dataTransfer`
 * is still the authority at drop time — the slot is a preview, not a channel.
 * (Same shape and same justification as `editor/reveal-line.ts`.)
 */
import type { SplitViewEdge } from "@volli/shared";

import { tabDropOrder } from "@renderer/components/ui/tab-reorder";

// ---------------------------------------------------------------------------
// Zones

/**
 * The three targets a pane's content box is tiled by. `right`/`bottom` are the
 * two edges a split may open on (the in-app terminal grammar: right and down
 * only); `center` is "put it in this pane".
 */
export type SplitDropZone = "center" | "right" | "bottom";

/**
 * How much of a pane its edge bands claim. A quarter is VS Code's own
 * proportion for `editorDropTarget`, and it is the number that makes the
 * gesture readable without a pointer-perfect approach to the border.
 */
export const SPLIT_DROP_EDGE_FRACTION = 0.25;

/**
 * …but never less than this, because a quarter of a narrow pane is a target
 * nobody can hit. 48px is the house's own coarse-pointer floor.
 */
export const SPLIT_DROP_MIN_EDGE_PX = 48;

/** The pane's content box, in px. */
export interface SplitDropBox {
  width: number;
  height: number;
}

/** A pointer, in the box's own coordinates. */
export interface SplitDropPoint {
  x: number;
  y: number;
}

/**
 * How deep one edge band reaches into a box of `size`.
 *
 * Clamped to half the box so the two bands can never overlap: at 96px and
 * below the minimum would otherwise eat the centre, and a pane with no centre
 * is a pane you cannot drop a tab INTO.
 */
function edgeBand(size: number): number {
  return Math.min(Math.max(size * SPLIT_DROP_EDGE_FRACTION, SPLIT_DROP_MIN_EDGE_PX), size / 2);
}

/**
 * The band as CSS, derived from the same two constants.
 *
 * It exists because the zones are hit-tested TWICE and by two different
 * mechanics: dnd-kit measures the DOM boxes of the regions, and a native HTML5
 * drag is hit-tested by this arithmetic. Two numbers written out twice would
 * eventually be two different numbers, and the symptom — a highlight that
 * disagrees with where the tab lands — would be blamed on the drop.
 */
export const SPLIT_DROP_EDGE_BAND_CSS = `min(max(${SPLIT_DROP_EDGE_FRACTION * 100}%, ${SPLIT_DROP_MIN_EDGE_PX}px), 50%)`;

/**
 * Which zone `point` is in.
 *
 * THE RIGHT BAND IS A FULL-HEIGHT COLUMN and the bottom band is what is left of
 * the width, so the corner belongs to `right` — the split `⌘\` opens, and the
 * one this app treats as the default. Tiling them this way rather than by
 * whichever edge is nearer is what lets the DOM regions and this arithmetic
 * describe the same three rectangles; a corner shared between two bands can be
 * split by proximity in arithmetic but not in CSS, and a highlight that
 * disagreed with the drop would be worse than a corner that has one owner.
 *
 * A box with no area answers `center`: there is no edge to be near, and
 * refusing outright would make a pane that has not been measured yet swallow
 * the gesture.
 */
export function splitDropZoneAt(box: SplitDropBox, point: SplitDropPoint): SplitDropZone {
  if (box.width <= 0 || box.height <= 0) return "center";
  if (point.x >= box.width - edgeBand(box.width)) return "right";
  if (point.y >= box.height - edgeBand(box.height)) return "bottom";
  return "center";
}

/** The rectangle a zone's highlight draws, as CSS percentages of the pane. */
export interface SplitDropPreviewRect {
  left: string;
  top: string;
  width: string;
  height: string;
}

/**
 * WHAT THE DROP WOULD LEAVE BEHIND, drawn as a rectangle.
 *
 * The highlight is a result preview, not a target outline: an edge zone paints
 * the HALF a split would open (which is where the tab would end up), and the
 * centre paints the whole pane (which is what it would fill). Drawing the
 * band itself would be the app describing its own hit-testing.
 */
export function splitDropPreview(zone: SplitDropZone): SplitDropPreviewRect {
  if (zone === "right") return { left: "50%", top: "0%", width: "50%", height: "100%" };
  if (zone === "bottom") return { left: "0%", top: "50%", width: "100%", height: "50%" };
  return { left: "0%", top: "0%", width: "100%", height: "100%" };
}

/** The edge a zone splits on, or `null` for the centre, which splits nothing. */
export function splitDropEdge(zone: SplitDropZone): SplitViewEdge | null {
  if (zone === "right") return "right";
  if (zone === "bottom") return "down";
  return null;
}

/**
 * A zone's accessible name — the ACT, not the region ("Split right", never
 * "right edge drop target"). The centre says "Move here" because moving is what
 * it does: it opens nothing.
 */
export function splitDropZoneLabel(zone: SplitDropZone): string {
  if (zone === "right") return "Split right";
  if (zone === "bottom") return "Split down";
  return "Move here";
}

const ZONE_ID_PREFIX = "split-zone:";

/**
 * A zone's dnd-kit droppable id. Pane ids are minted (`crypto.randomUUID`) and
 * tab ids are file paths and session ids, so the prefix is what keeps the two
 * kinds of droppable apart in one context — the collision resolver reads it.
 */
export function splitZoneId(paneId: string, zone: SplitDropZone): string {
  return `${ZONE_ID_PREFIX}${zone}:${paneId}`;
}

/** The pane and zone a droppable id names, or `null` for anything else. */
export function parseSplitZoneId(id: string): { paneId: string; zone: SplitDropZone } | null {
  if (!id.startsWith(ZONE_ID_PREFIX)) return null;
  const rest = id.slice(ZONE_ID_PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator === -1) return null;
  const zone = rest.slice(0, separator);
  const paneId = rest.slice(separator + 1);
  if (paneId.length === 0) return null;
  if (zone !== "center" && zone !== "right" && zone !== "bottom") return null;
  return { paneId, zone };
}

/** Whether a droppable id is a zone rather than a tab. */
export function isSplitZoneId(id: string): boolean {
  return parseSplitZoneId(id) !== null;
}

// ---------------------------------------------------------------------------
// What a drop writes

/** One pane's strip: its id, and the MOVABLE tab ids it draws, in order. */
export interface SplitPaneTabs {
  paneId: string;
  tabIds: readonly string[];
}

/**
 * The store write a drop asks for. Three, and no more: everything a person can
 * do by dragging a tab is one of them.
 */
export type SplitDropOperation =
  | { kind: "reorder"; paneId: string; movedId: string; ids: readonly string[] }
  | { kind: "move"; tabId: string; paneId: string }
  | { kind: "split"; paneId: string; edge: SplitViewEdge; tabId: string };

/** Which pane draws `tabId`, or `null` while no strip claims it. */
function paneOf(panes: readonly SplitPaneTabs[], tabId: string): SplitPaneTabs | null {
  return panes.find((pane) => pane.tabIds.includes(tabId)) ?? null;
}

/**
 * What a tab dropped on `zone` of `paneId` asks for.
 *
 * The CENTRE OF ITS OWN PANE asks for nothing, and that is the identity no-op
 * the zone draws as the whole-pane preview: the tab is already here, so
 * "move it here" has nothing to write. (An edge of its own pane is NOT
 * refused here — a pane with two tabs splitting one of them out is a real act,
 * and the one case that changes nothing, a pane's only tab, is refused by the
 * model itself.)
 */
export function splitZoneDropOperation(
  panes: readonly SplitPaneTabs[],
  tabId: string,
  paneId: string,
  zone: SplitDropZone,
): SplitDropOperation | null {
  const edge = splitDropEdge(zone);
  if (edge !== null) return { kind: "split", paneId, edge, tabId };
  return paneOf(panes, tabId)?.paneId === paneId ? null : { kind: "move", tabId, paneId };
}

/**
 * What a dnd-kit drop asks for: `overId` is a zone id, another tab's id, or
 * `null` for a gesture that ended over nothing.
 *
 * Over a TAB is the strip's own vocabulary and stays exactly what it was — the
 * same tab, in the same pane, means the same reorder `tab-reorder.ts` computes
 * (VC-189). Over a tab of ANOTHER pane is the one new sentence: the tab joins
 * that pane, appended, because a strip drop names a pane and not a slot in it
 * (v1 — landing at the exact slot is a later refinement).
 */
export function splitTabDropOperation(input: {
  activeId: string;
  overId: string | null;
  panes: readonly SplitPaneTabs[];
}): SplitDropOperation | null {
  const { activeId, overId, panes } = input;
  if (overId === null) return null;
  const zone = parseSplitZoneId(overId);
  if (zone !== null) return splitZoneDropOperation(panes, activeId, zone.paneId, zone.zone);
  const source = paneOf(panes, activeId);
  const target = paneOf(panes, overId);
  if (target === null) return null;
  // A tab dropped on ITSELF has one pane on both sides, so it falls through to
  // the reorder below, which is where "a tab dropped on its own slot changes
  // nothing" is already decided (`tabDropOrder`).
  if (source === null || source.paneId !== target.paneId) {
    return { kind: "move", tabId: activeId, paneId: target.paneId };
  }
  const drop = tabDropOrder(source.tabIds, activeId, overId);
  return drop === null
    ? null
    : { kind: "reorder", paneId: source.paneId, movedId: drop.movedId, ids: drop.ids };
}

// ---------------------------------------------------------------------------
// Native payloads (the sidebars)

/** A Session row dragged out of a sidebar or a rail. */
export const SPLIT_SESSION_DRAG_TYPE = "application/x-volli-session";
/** A file row dragged out of a rail's Files navigator. */
export const SPLIT_FILE_DRAG_TYPE = "application/x-volli-file";

/**
 * WHOSE WORK A PAYLOAD IS. Carried in the payload rather than inferred at the
 * drop, because a row knows it and a zone cannot: the sidebar's bands list
 * every Session in the project, ticketed and not, and by the time one is over a
 * pane the only thing left saying which surface it belongs to is what the row
 * wrote down.
 */
export interface SplitDragOrigin {
  scope: "project" | "ticket";
  projectId: string;
  /** Null for a project-scope payload; the owning ticket otherwise. */
  ticketId: string | null;
}

export interface SplitSessionDragPayload extends SplitDragOrigin {
  type: "session";
  kind: "chat" | "terminal";
  /**
   * The Session. For a TERMINAL this is also its tab id, which is why only an
   * open terminal may be dragged: a closed one has no tab for a pane to hold.
   * For a CHAT it is the durable Session id — the tab is minted on the drop.
   */
  sessionId: string;
}

export interface SplitFileDragPayload extends SplitDragOrigin {
  type: "file";
  /** Relative to the surface's own checkout — which is what `scope` names. */
  relPath: string;
}

export type SplitDragPayload = SplitSessionDragPayload | SplitFileDragPayload;

/** The MIME type a payload travels under. */
export function splitDragType(payload: SplitDragPayload): string {
  return payload.type === "session" ? SPLIT_SESSION_DRAG_TYPE : SPLIT_FILE_DRAG_TYPE;
}

/** The payload as `dataTransfer` bytes. */
export function splitDragPayloadJson(payload: SplitDragPayload): string {
  return JSON.stringify(payload);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readOrigin(raw: Record<string, unknown>): SplitDragOrigin | null {
  const { scope, projectId, ticketId } = raw;
  if (scope !== "project" && scope !== "ticket") return null;
  if (typeof projectId !== "string" || projectId.length === 0) return null;
  const owner = typeof ticketId === "string" && ticketId.length > 0 ? ticketId : null;
  // A ticket payload with no ticket names nothing; a project payload with one
  // is a contradiction rather than a detail to ignore.
  if (scope === "ticket" && owner === null) return null;
  if (scope === "project" && owner !== null) return null;
  return { scope, projectId, ticketId: owner };
}

/**
 * A payload off the wire, or `null`.
 *
 * Tolerant in exactly one direction: anything malformed is refused, and nothing
 * is repaired. The bytes came from this app, so a shape that does not parse is
 * a bug or a foreign drag — and a foreign drag must be refused SILENTLY, which
 * is what `null` buys the zones (no highlight, no drop).
 */
export function parseSplitDragPayload(type: string, raw: string): SplitDragPayload | null {
  if (type !== SPLIT_SESSION_DRAG_TYPE && type !== SPLIT_FILE_DRAG_TYPE) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const origin = readOrigin(parsed);
  if (origin === null) return null;
  if (type === SPLIT_FILE_DRAG_TYPE) {
    const { relPath } = parsed;
    if (parsed.type !== "file" || typeof relPath !== "string" || relPath.length === 0) return null;
    return { ...origin, type: "file", relPath };
  }
  const { kind, sessionId } = parsed;
  if (parsed.type !== "session") return null;
  if (kind !== "chat" && kind !== "terminal") return null;
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;
  return { ...origin, type: "session", kind, sessionId };
}

/**
 * Whether `payload` may land on a surface with this origin.
 *
 * The rule is the same one that keeps tabs from crossing surfaces, said for the
 * one gesture that can reach across: a payload lands only where its own scope
 * points. Home takes the project's own Sessions and Main-checkout files; a
 * ticket workspace takes ITS ticket's Sessions and ITS worktree's files. Every
 * other combination shows no zones at all rather than a target that refuses on
 * release.
 */
export function splitDropAccepts(payload: SplitDragPayload, surface: SplitDragOrigin): boolean {
  return (
    payload.scope === surface.scope &&
    payload.projectId === surface.projectId &&
    payload.ticketId === surface.ticketId
  );
}

// ---------------------------------------------------------------------------
// The live native drag (see the file header for why this is module state)

let liveDrag: SplitDragPayload | null = null;
const listeners = new Set<() => void>();

function announce(): void {
  for (const listener of listeners) listener();
}

/** A native drag started in this window, carrying `payload`. */
export function beginSplitDrag(payload: SplitDragPayload): void {
  liveDrag = payload;
  announce();
}

/** It ended — dropped, cancelled, or dragged out of the window. */
export function endSplitDrag(): void {
  if (liveDrag === null) return;
  liveDrag = null;
  announce();
}

/** The payload of the native drag in flight, or `null`. */
export function splitDragSnapshot(): SplitDragPayload | null {
  return liveDrag;
}

/** `useSyncExternalStore`'s half of the slot. */
export function subscribeSplitDrag(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
