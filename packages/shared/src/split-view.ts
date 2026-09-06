/**
 * SPLIT VIEW — how one tabbed surface's tabs are spread over several panes
 * (VC-202, `docs/plans/split-view.md` §1).
 *
 * Both tabbed surfaces (Home, and a ticket workspace) already own one ordered
 * strip of tabs and one active tab. A split view sits BESIDE that, exactly as
 * an arrangement does (`tab-order.ts`): a binary tree whose leaves are panes,
 * each pane naming a subset of the surface's tab ids and its own front tab. The
 * surface keeps composing and arranging its tabs the way it always did; this
 * model only says which pane each of them is drawn in.
 *
 * THE MODEL NAMES IDS, AND IDS ONLY, and — like an arrangement — it never has
 * to be true. A pane may name a tab that does not exist yet (a Session that has
 * not hydrated), and a tab may exist that no pane names (it was opened by a
 * path that predates this feature, or restored at boot). Neither is repaired at
 * rest. {@link sanitizeSplitView} checks SHAPE and nothing else, and
 * {@link resolveSplitView} does the reconciling at RENDER time, against the
 * live strip, without writing anything back. That is the same discipline
 * `tab-order.ts` states and for the same reason: a Session that has not
 * hydrated yet looks exactly like a Session that is gone, and only one of those
 * may lose its place.
 *
 * TWO RULES CARRY THE WHOLE COMPATIBILITY STORY:
 *
 *  1. **A single pane is not a split.** The store holds `SplitViewState | null`
 *     per surface and collapses back to `null` the moment only one pane is
 *     left, so "no split" has exactly one representation and every pre-existing
 *     code path keeps running untouched. {@link isSinglePane} is what the store
 *     asks after each operation; {@link sanitizeSplitView} refuses a persisted
 *     single-pane tree for the same reason.
 *  2. **The primary pane is the first leaf, and it is where everything
 *     unclaimed lives.** Splits only ever open a pane to the RIGHT or BELOW
 *     (the vocabulary the in-app terminal split already uses), so the top-left
 *     leaf is stable — which is what lets the surface's existing full-width tab
 *     strip go on being the primary pane's strip, and what makes "the permanent
 *     tab (Board / Body) never leaves the primary pane" a property of the model
 *     rather than a rule every caller has to remember.
 *
 * Every operation is IDENTITY-STABLE: it returns its input when nothing
 * changed, so a store `set` for a no-op never notifies a subscriber, and
 * unchanged subtrees keep their references across a change so a memoized pane
 * does not re-render because its neighbour resized.
 *
 * No DOM, no React, no clock, no randomness: `splitPane` takes an injected
 * `mintId` (the renderer passes `() => crypto.randomUUID()`), which is also
 * what makes the tests here deterministic.
 */

/** `row` = side-by-side (a vertical divider); `column` = stacked. */
export type SplitViewDirection = "row" | "column";

/**
 * Where a split opens the new pane. Right/down only — the constraint the
 * terminal split already lives under, and what keeps the primary pane top-left.
 */
export type SplitViewEdge = "right" | "down";

/** Pane-to-pane focus movement, resolved geometrically. */
export type SplitViewFocusDirection = "left" | "right" | "up" | "down";

export interface SplitViewPane {
  kind: "pane";
  id: string;
  /** Tab ids assigned to this pane, in strip order. Ids may name nothing. */
  tabIds: readonly string[];
  /** The pane's front tab, or null (an empty pane draws the surface menu). */
  activeTabId: string | null;
}

export interface SplitViewBranch {
  kind: "split";
  id: string;
  direction: SplitViewDirection;
  /** `first`'s share of the branch, clamped to [0.15, 0.85]. */
  ratio: number;
  first: SplitViewNode;
  second: SplitViewNode;
}

export type SplitViewNode = SplitViewPane | SplitViewBranch;

export interface SplitViewState {
  root: SplitViewNode;
  /** A pane id; the pane whose active tab is the surface's active tab. */
  focusedPaneId: string;
}

/**
 * The pane id a surface's one-and-only pane carries before it has ever split.
 *
 * A constant rather than a minted id because it is also the id a renderer draws
 * an UNSPLIT surface under (`resolveSplitView` over
 * {@link singlePaneSplitView}), so `⌘\` can name the pane it is splitting
 * before any split state exists.
 */
export const SPLIT_VIEW_ROOT_PANE_ID = "root";

/** A fresh split divides its pane down the middle. */
export const SPLIT_VIEW_DEFAULT_RATIO = 0.5;

/** Neither pane of a branch may be squeezed below this share of it. */
export const SPLIT_VIEW_MIN_RATIO = 0.15;
export const SPLIT_VIEW_MAX_RATIO = 0.85;

/**
 * Beyond these a rehydrated tree is refused outright (see
 * {@link sanitizeSplitView}): a surface of nine panes or seven levels is not a
 * layout anybody arranged, and drawing it is worse than opening unsplit.
 */
export const SPLIT_VIEW_MAX_PANES = 8;
export const SPLIT_VIEW_MAX_DEPTH = 6;

/**
 * One pane holding `tabIds` — what a surface looks like before it splits, and
 * what the store materializes the moment it does.
 *
 * Also the shape a renderer hands {@link resolveSplitView} for an UNSPLIT
 * surface, so one grid draws both cases and the split path is never a second
 * rendering path.
 */
export function singlePaneSplitView(
  tabIds: readonly string[],
  activeTabId: string | null,
  paneId: string = SPLIT_VIEW_ROOT_PANE_ID,
): SplitViewState {
  return {
    root: { kind: "pane", id: paneId, tabIds: [...tabIds], activeTabId },
    focusedPaneId: paneId,
  };
}

/**
 * Rewrite a tree bottom-up, keeping every subtree that did not change BY
 * IDENTITY.
 *
 * The single walker behind every operation below, which is where their identity
 * stability comes from: a change deep in one branch rebuilds the spine down to
 * it and leaves the other side alone, so a resize of one divider cannot
 * invalidate a memoized pane on the far side of the tree.
 */
function rewrite(node: SplitViewNode, map: (node: SplitViewNode) => SplitViewNode): SplitViewNode {
  if (node.kind === "pane") return map(node);
  const first = rewrite(node.first, map);
  const second = rewrite(node.second, map);
  return map(first === node.first && second === node.second ? node : { ...node, first, second });
}

/** Replace one pane's node — with a pane, or with the branch that splits it. */
function replacePane(
  state: SplitViewState,
  paneId: string,
  replace: (pane: SplitViewPane) => SplitViewNode,
): SplitViewState {
  const root = rewrite(state.root, (node) =>
    node.kind === "pane" && node.id === paneId ? replace(node) : node,
  );
  return root === state.root ? state : { ...state, root };
}

function collectPanes(node: SplitViewNode, out: SplitViewPane[]): void {
  if (node.kind === "pane") {
    out.push(node);
    return;
  }
  collectPanes(node.first, out);
  collectPanes(node.second, out);
}

/** Every pane, in tree order — which is reading order: top-left first. */
export function splitViewPanes(state: SplitViewState): readonly SplitViewPane[] {
  const panes: SplitViewPane[] = [];
  collectPanes(state.root, panes);
  return panes;
}

/**
 * The pane that holds the surface's permanent tab and everything no pane
 * claims. Always the first leaf, because splits only open right/down.
 */
export function primaryPaneId(state: SplitViewState): string {
  // A tree always has at least one leaf: the only way to build one is from a
  // pane, and no operation here removes the primary.
  return splitViewPanes(state)[0]!.id;
}

function findPane(state: SplitViewState, paneId: string): SplitViewPane | null {
  return splitViewPanes(state).find((pane) => pane.id === paneId) ?? null;
}

function findPaneWithTab(state: SplitViewState, tabId: string): SplitViewPane | null {
  return splitViewPanes(state).find((pane) => pane.tabIds.includes(tabId)) ?? null;
}

/** Which pane claims `tabId`, or null when none does (see the module doc). */
export function paneForTab(state: SplitViewState, tabId: string): string | null {
  return findPaneWithTab(state, tabId)?.id ?? null;
}

/**
 * The focused pane's front tab — THE surface's active tab while split, and so
 * the context the right rail reads. `null` while the focused pane is empty.
 */
export function activeTabInSplitView(state: SplitViewState): string | null {
  return findPane(state, state.focusedPaneId)?.activeTabId ?? null;
}

/** Whether this is one pane, i.e. no longer a split — see the module doc. */
export function isSinglePane(
  state: SplitViewState,
): state is SplitViewState & { root: SplitViewPane } {
  return state.root.kind === "pane";
}

/** Focus a pane. Ignores an id that names none — focus is never left dangling. */
export function focusPane(state: SplitViewState, paneId: string): SplitViewState {
  if (state.focusedPaneId === paneId) return state;
  if (findPane(state, paneId) === null) return state;
  return { ...state, focusedPaneId: paneId };
}

/**
 * Make `tabId` the front tab of the pane that holds it, and focus that pane —
 * THE write-through primitive behind every existing "make this tab active"
 * store action.
 *
 * A tab no pane claims is one that was just OPENED, and it belongs to the pane
 * the person is working in: it joins the focused pane's strip. That is what
 * makes an empty pane's menu work without any pane plumbing — `⌘P` opens a
 * file, the surface activates it, and it lands here because here is where the
 * focus is.
 */
export function activateTab(state: SplitViewState, tabId: string): SplitViewState {
  const holder = findPaneWithTab(state, tabId);
  if (holder === null) {
    return replacePane(state, state.focusedPaneId, (pane) => ({
      ...pane,
      tabIds: [...pane.tabIds, tabId],
      activeTabId: tabId,
    }));
  }
  return replacePane(focusPane(state, holder.id), holder.id, (pane) =>
    pane.activeTabId === tabId ? pane : { ...pane, activeTabId: tabId },
  );
}

/**
 * Drop `tabId` from a pane, handing the front tab to its successor — the next
 * tab in the pane, else the previous one.
 */
function paneWithoutTab(pane: SplitViewPane, tabId: string): SplitViewPane {
  const index = pane.tabIds.indexOf(tabId);
  const tabIds = pane.tabIds.filter((id) => id !== tabId);
  if (pane.activeTabId !== tabId) return { ...pane, tabIds };
  return { ...pane, tabIds, activeTabId: tabIds[index] ?? tabIds.at(-1) ?? null };
}

/** The other child of the branch that holds `paneId`, or null at the root. */
function siblingOf(node: SplitViewNode, paneId: string): SplitViewNode | null {
  if (node.kind === "pane") return null;
  if (node.first.kind === "pane" && node.first.id === paneId) return node.second;
  if (node.second.kind === "pane" && node.second.id === paneId) return node.first;
  return siblingOf(node.first, paneId) ?? siblingOf(node.second, paneId);
}

/** The tree with `paneId`'s branch replaced by that branch's other child. */
function dropPane(node: SplitViewNode, paneId: string): SplitViewNode {
  if (node.kind === "pane") return node;
  if (node.first.kind === "pane" && node.first.id === paneId) return node.second;
  if (node.second.kind === "pane" && node.second.id === paneId) return node.first;
  const first = dropPane(node.first, paneId);
  if (first !== node.first) return { ...node, first };
  const second = dropPane(node.second, paneId);
  return second === node.second ? node : { ...node, second };
}

/**
 * Close a pane outright — the empty pane's own menu row, and the collapse a
 * pane emptied by {@link removeTab} performs on itself.
 *
 * THE PRIMARY PANE NEVER CLOSES: it holds the permanent tab, and a surface with
 * no primary pane has nowhere to draw the Board.
 *
 * Tabs the pane still held are RELINQUISHED to the primary pane rather than
 * closed — closing a pane is a layout act, and nothing here may close a tab.
 * The primary pane is where they go because it is already where
 * {@link resolveSplitView} sends any id no pane claims, so the model has one
 * rule about orphaned tabs and not two.
 *
 * Focus follows the space: the sibling that expands into the closed pane's
 * area takes it, which is where the eye already went.
 */
export function closePane(state: SplitViewState, paneId: string): SplitViewState {
  const closing = findPane(state, paneId);
  if (closing === null) return state;
  if (paneId === primaryPaneId(state)) return state;
  // A non-primary pane is by definition below a branch, so it has a sibling.
  const sibling = siblingOf(state.root, paneId)!;
  const survivor: SplitViewState = {
    root: dropPane(state.root, paneId),
    focusedPaneId: state.focusedPaneId === paneId ? firstPaneOf(sibling).id : state.focusedPaneId,
  };
  if (closing.tabIds.length === 0) return survivor;
  const primary = primaryPaneId(survivor);
  return replacePane(survivor, primary, (pane) => ({
    ...pane,
    tabIds: [...pane.tabIds, ...closing.tabIds.filter((id) => !pane.tabIds.includes(id))],
  }));
}

function firstPaneOf(node: SplitViewNode): SplitViewPane {
  const panes: SplitViewPane[] = [];
  collectPanes(node, panes);
  return panes[0]!;
}

/**
 * Drop `tabId` from whichever pane holds it — the write-through behind every
 * tab CLOSE. A non-primary pane emptied by it collapses, because an empty pane
 * nobody asked for is just a hole in the layout.
 */
export function removeTab(state: SplitViewState, tabId: string): SplitViewState {
  const holder = findPaneWithTab(state, tabId);
  if (holder === null) return state;
  const stripped = paneWithoutTab(holder, tabId);
  const next = replacePane(state, holder.id, () => stripped);
  // Collapse the STRIPPED pane, so the close relinquishes nothing: the tab is
  // gone, not moved.
  if (stripped.tabIds.length === 0 && holder.id !== primaryPaneId(state)) {
    return closePane(next, holder.id);
  }
  return next;
}

/**
 * Move `tabId` into `paneId` — a tab dropped on a pane's centre zone, or on
 * another pane's strip.
 *
 * The moved tab is activated and its new pane focused, because a dropped tab is
 * the one you meant to look at. Its old pane collapses if the move emptied it.
 */
export function moveTabToPane(
  state: SplitViewState,
  tabId: string,
  paneId: string,
): SplitViewState {
  const target = findPane(state, paneId);
  if (target === null) return state;
  const source = findPaneWithTab(state, tabId);
  // Already this pane's last tab: the assignment cannot change, and only focus
  // and the front tab are left to say.
  const assigned =
    source?.id === paneId && target.tabIds.at(-1) === tabId
      ? state
      : replacePane(source === null ? state : removeTab(state, tabId), paneId, (pane) => ({
          ...pane,
          tabIds: [...pane.tabIds, tabId],
        }));
  return activateTab(focusPane(assigned, paneId), tabId);
}

/**
 * Rewrite one pane's strip order after a drag inside it — {@link
 * movedTabOrder}'s job one scope down, and rewritten wholesale for the same
 * reason: `ids` is the pane's strip as the drop left it, so the claim it
 * records names every tab that pane is currently drawing and nothing else,
 * which is also what keeps a pane's claim from growing without bound as tabs
 * come and go.
 *
 * The permanent tab is never among `ids` (it does not drag), and a pane's front
 * tab that the drop did not draw gives way rather than being kept as a claim
 * the strip disagrees with.
 */
export function reorderPaneTabs(
  state: SplitViewState,
  paneId: string,
  ids: readonly string[],
): SplitViewState {
  const pane = findPane(state, paneId);
  if (pane === null) return state;
  const tabIds = [...new Set(ids.filter((id) => id.length > 0))];
  const activeTabId =
    pane.activeTabId !== null && tabIds.includes(pane.activeTabId) ? pane.activeTabId : null;
  if (sameIds(pane.tabIds, tabIds) && pane.activeTabId === activeTabId) return state;
  return replacePane(state, paneId, () => ({ ...pane, tabIds, activeTabId }));
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/**
 * Split `paneId`, opening a new pane to its right or below it.
 *
 * `opts.tabId` is the tab being dragged into the new pane; without one the new
 * pane opens EMPTY, which is what `⌘\` does and what the surface menu fills.
 * Either way the new pane takes focus — it is the pane the person just made.
 *
 * `mintId` is called twice, for the new pane and then for the branch that holds
 * it.
 */
export function splitPane(
  state: SplitViewState,
  paneId: string,
  edge: SplitViewEdge,
  opts: { tabId?: string },
  mintId: () => string,
): SplitViewState {
  const target = findPane(state, paneId);
  if (target === null) return state;
  const { tabId } = opts;
  // A pane's only tab dropped on that pane's own edge: the split would trade
  // one pane of one tab for an empty pane beside a pane of one tab. The drop
  // zone draws this as the centre preview, and the model answers by identity.
  if (tabId !== undefined && sameIds(target.tabIds, [tabId])) return state;
  const detached = tabId === undefined ? state : removeTab(state, tabId);
  const opened: SplitViewPane = {
    kind: "pane",
    id: mintId(),
    tabIds: tabId === undefined ? [] : [tabId],
    activeTabId: tabId ?? null,
  };
  const split = replacePane(detached, paneId, (pane) => ({
    kind: "split",
    id: mintId(),
    direction: edge === "right" ? "row" : "column",
    ratio: SPLIT_VIEW_DEFAULT_RATIO,
    first: pane,
    second: opened,
  }));
  return { root: split.root, focusedPaneId: opened.id };
}

function clampRatio(ratio: number): number {
  return Math.min(SPLIT_VIEW_MAX_RATIO, Math.max(SPLIT_VIEW_MIN_RATIO, ratio));
}

/**
 * Resize a branch. A non-finite ratio is refused rather than clamped: a divider
 * dragged inside a box that has not been measured yet computes `NaN`, and a
 * `NaN` share renders a pane with no size at all.
 */
export function setSplitRatio(
  state: SplitViewState,
  splitId: string,
  ratio: number,
): SplitViewState {
  if (!Number.isFinite(ratio)) return state;
  const clamped = clampRatio(ratio);
  const root = rewrite(state.root, (node) =>
    node.kind === "split" && node.id === splitId && node.ratio !== clamped
      ? { ...node, ratio: clamped }
      : node,
  );
  return root === state.root ? state : { ...state, root };
}

/**
 * Follow a tab whose IDENTITY changed while the tab itself stayed put — the
 * split view's twin of {@link renamedTabOrder}, and needed for the same reason:
 * a File tab's id carries its path, so a preview slot replaced in place and a
 * renamed file both hand the surface the same tab under a new name. Left alone,
 * no pane would claim the new id and the tab would teleport to the primary pane
 * the next time it was drawn.
 *
 * An existing mention of `toId` is ABSORBED, mirroring `renameFile`'s own
 * absorption of a stale tab already sitting on the destination path — and if
 * that stale tab was somebody's front tab, the tab that took its name is now
 * the tab in front, wherever it lives.
 */
export function renamedTabInSplitView(
  state: SplitViewState,
  fromId: string,
  toId: string,
): SplitViewState {
  if (fromId === toId) return state;
  const holder = findPaneWithTab(state, fromId);
  if (holder === null) return state;
  const stale = findPaneWithTab(state, toId);
  const absorbed = stale === null ? state : removeTab(state, toId);
  const renamed = replacePane(absorbed, holder.id, (pane) => ({
    ...pane,
    tabIds: pane.tabIds.map((id) => (id === fromId ? toId : id)),
    activeTabId: pane.activeTabId === fromId ? toId : pane.activeTabId,
  }));
  return stale?.activeTabId === toId ? activateTab(renamed, toId) : renamed;
}

interface PaneBox {
  readonly id: string;
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

type DirectionMetrics = readonly [primaryGap: number, crossGap: number, centreDistance: number];

/**
 * Move focus to the visually adjacent pane, or stay put at an outer edge
 * (focus never wraps).
 *
 * Geometric rather than tree-order, so an uneven or nested layout navigates the
 * way it looks: ratios are respected, ties break by overlap and then by centre
 * distance. Same algorithm as the terminal split's own `adjacentPaneId`
 * (`terminal/pane-navigation.ts`) — one splitting grammar, so also one
 * navigation grammar, but the code is copied rather than shared because
 * `@volli/shared` may not import renderer state.
 */
export function focusAdjacentPane(
  state: SplitViewState,
  direction: SplitViewFocusDirection,
): SplitViewState {
  const boxes: PaneBox[] = [];
  collectPaneBoxes(state.root, { minX: 0, minY: 0, maxX: 1, maxY: 1 }, boxes);
  const active = boxes.find((box) => box.id === state.focusedPaneId);
  if (active === undefined) return state;
  let best: { id: string; metrics: DirectionMetrics } | null = null;
  for (const candidate of boxes) {
    if (candidate.id === active.id) continue;
    const metrics = directionalMetrics(active, candidate, direction);
    if (metrics === null) continue;
    if (best === null || compareMetrics(metrics, best.metrics) < 0) {
      best = { id: candidate.id, metrics };
    }
  }
  return best === null ? state : focusPane(state, best.id);
}

function collectPaneBoxes(
  node: SplitViewNode,
  bounds: Omit<PaneBox, "id">,
  boxes: PaneBox[],
): void {
  if (node.kind === "pane") {
    boxes.push({ id: node.id, ...bounds });
    return;
  }
  if (node.direction === "row") {
    const splitX = bounds.minX + (bounds.maxX - bounds.minX) * node.ratio;
    collectPaneBoxes(node.first, { ...bounds, maxX: splitX }, boxes);
    collectPaneBoxes(node.second, { ...bounds, minX: splitX }, boxes);
    return;
  }
  const splitY = bounds.minY + (bounds.maxY - bounds.minY) * node.ratio;
  collectPaneBoxes(node.first, { ...bounds, maxY: splitY }, boxes);
  collectPaneBoxes(node.second, { ...bounds, minY: splitY }, boxes);
}

function directionalMetrics(
  active: PaneBox,
  candidate: PaneBox,
  direction: SplitViewFocusDirection,
): DirectionMetrics | null {
  if (direction === "left") {
    if (candidate.maxX > active.minX) return null;
    return [
      active.minX - candidate.maxX,
      intervalGap(active.minY, active.maxY, candidate.minY, candidate.maxY),
      Math.abs(centre(active.minY, active.maxY) - centre(candidate.minY, candidate.maxY)),
    ];
  }
  if (direction === "right") {
    if (candidate.minX < active.maxX) return null;
    return [
      candidate.minX - active.maxX,
      intervalGap(active.minY, active.maxY, candidate.minY, candidate.maxY),
      Math.abs(centre(active.minY, active.maxY) - centre(candidate.minY, candidate.maxY)),
    ];
  }
  if (direction === "up") {
    if (candidate.maxY > active.minY) return null;
    return [
      active.minY - candidate.maxY,
      intervalGap(active.minX, active.maxX, candidate.minX, candidate.maxX),
      Math.abs(centre(active.minX, active.maxX) - centre(candidate.minX, candidate.maxX)),
    ];
  }
  if (candidate.minY < active.maxY) return null;
  return [
    candidate.minY - active.maxY,
    intervalGap(active.minX, active.maxX, candidate.minX, candidate.maxX),
    Math.abs(centre(active.minX, active.maxX) - centre(candidate.minX, candidate.maxX)),
  ];
}

function intervalGap(aMin: number, aMax: number, bMin: number, bMax: number): number {
  if (aMax < bMin) return bMin - aMax;
  if (bMax < aMin) return aMin - bMax;
  return 0;
}

const centre = (min: number, max: number): number => (min + max) / 2;

function compareMetrics(a: DirectionMetrics, b: DirectionMetrics): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * Validate a rehydrated split view from a possibly-older build: a tree it can
 * draw, or `null` — which is not a failure but the ordinary unsplit surface,
 * the one degradation that is always safe.
 *
 * SHAPE ONLY, so a pane may keep naming tabs nothing on screen answers to (the
 * module doc's rule). What it does check is internal consistency, which is
 * shape: ids are unique across the tree, a tab id is claimed by one pane (first
 * mention wins, as `sanitizeTabOrder` collapses a duplicate), a front tab is
 * one of its own pane's tabs, `focusedPaneId` names a pane, and ratios are
 * numbers inside the clamp. A tree too deep or too wide, or one whose shape
 * cannot be read at all, degrades to `null` rather than being drawn.
 *
 * A single pane is refused too: it is not a split (module doc), and the only
 * way one reaches storage is a build that stopped between a collapse and its
 * write.
 */
export function sanitizeSplitView(raw: unknown): SplitViewState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { root, focusedPaneId } = raw as { root?: unknown; focusedPaneId?: unknown };
  const node = sanitizeNode(root, new Set<string>(), new Set<string>(), 1);
  if (node === null || node.kind === "pane") return null;
  const panes: SplitViewPane[] = [];
  collectPanes(node, panes);
  if (panes.length > SPLIT_VIEW_MAX_PANES) return null;
  const focused = panes.find((pane) => pane.id === focusedPaneId);
  return { root: node, focusedPaneId: focused?.id ?? panes[0]!.id };
}

function sanitizeNode(
  raw: unknown,
  nodeIds: Set<string>,
  tabIds: Set<string>,
  depth: number,
): SplitViewNode | null {
  if (depth > SPLIT_VIEW_MAX_DEPTH) return null;
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as {
    kind?: unknown;
    id?: unknown;
    tabIds?: unknown;
    activeTabId?: unknown;
    direction?: unknown;
    ratio?: unknown;
    first?: unknown;
    second?: unknown;
  };
  // A repeated id is unaddressable — focus, resize and every drop name nodes by
  // id, so two nodes answering to one name is a tree we cannot operate on.
  if (typeof record.id !== "string" || record.id.length === 0 || nodeIds.has(record.id)) {
    return null;
  }
  nodeIds.add(record.id);
  if (record.kind === "pane") {
    const claimed: string[] = [];
    for (const tabId of Array.isArray(record.tabIds) ? record.tabIds : []) {
      if (typeof tabId !== "string" || tabId.length === 0 || tabIds.has(tabId)) continue;
      tabIds.add(tabId);
      claimed.push(tabId);
    }
    const active = record.activeTabId;
    return {
      kind: "pane",
      id: record.id,
      tabIds: claimed,
      activeTabId: typeof active === "string" && claimed.includes(active) ? active : null,
    };
  }
  if (record.kind !== "split") return null;
  if (record.direction !== "row" && record.direction !== "column") return null;
  const first = sanitizeNode(record.first, nodeIds, tabIds, depth + 1);
  if (first === null) return null;
  const second = sanitizeNode(record.second, nodeIds, tabIds, depth + 1);
  if (second === null) return null;
  return {
    kind: "split",
    id: record.id,
    direction: record.direction,
    ratio:
      typeof record.ratio === "number" && Number.isFinite(record.ratio)
        ? clampRatio(record.ratio)
        : SPLIT_VIEW_DEFAULT_RATIO,
    first,
    second,
  };
}

export interface ResolvedSplitViewPane {
  kind: "pane";
  id: string;
  /** This pane's live tabs, in the order it draws them. */
  tabIds: readonly string[];
  /** The tab this pane shows, or null — an empty pane draws the surface menu. */
  activeTabId: string | null;
  /** Reading-order position, for "Pane 2 of 3" labels. */
  index: number;
  /** The primary pane draws no strip of its own: the surface's top strip is it. */
  isPrimary: boolean;
}

export interface ResolvedSplitViewBranch {
  kind: "split";
  id: string;
  direction: SplitViewDirection;
  ratio: number;
  first: ResolvedSplitViewNode;
  second: ResolvedSplitViewNode;
}

export type ResolvedSplitViewNode = ResolvedSplitViewPane | ResolvedSplitViewBranch;

export interface ResolvedSplitView {
  root: ResolvedSplitViewNode;
  /** Every pane in reading order — `panes[0]` is the primary. */
  panes: readonly ResolvedSplitViewPane[];
  focusedPaneId: string;
  primaryPaneId: string;
  /** The focused pane's tab: the surface's active tab, and the rail's context. */
  activeTabId: string | null;
}

/**
 * Project a split view onto the strip that actually exists — the render-time
 * half of the tolerant read, and the only place the model meets live tabs.
 *
 * `orderedTabIds` is the surface's composed AND arranged tab list (permanent tab
 * first): exactly what the strip would draw unsplit. Panes keep the ids they
 * claim, in their own order; ids that exist but no pane claims join the PRIMARY
 * pane, in strip order, so a tab opened by a path that never heard of panes is
 * never invisible. The permanent tab is the primary pane's first tab
 * unconditionally — "permanent" means the surface draws it whether or not the
 * live list bothered to name it, and it is what keeps the primary pane from
 * ever resolving empty.
 *
 * Nothing is written back and no pane is collapsed. An empty resolved pane
 * draws the surface menu, which is also what a pane full of dead terminal ids
 * renders after a relaunch — and if those ids come back (a Session hydrating a
 * beat later), the pane simply fills.
 */
export function resolveSplitView(
  state: SplitViewState,
  orderedTabIds: readonly string[],
  permanentTabId: string,
): ResolvedSplitView {
  const live = new Set(orderedTabIds);
  const claimed = new Set<string>([permanentTabId]);
  const panes = splitViewPanes(state);
  const kept = panes.map((pane) => {
    const ids = pane.tabIds.filter((id) => live.has(id) && !claimed.has(id));
    for (const id of ids) claimed.add(id);
    return ids;
  });
  const primary = panes[0]!;
  const resolved = new Map<string, ResolvedSplitViewPane>();
  panes.forEach((pane, index) => {
    const isPrimary = pane.id === primary.id;
    const tabIds = isPrimary
      ? [permanentTabId, ...kept[index]!, ...orderedTabIds.filter((id) => !claimed.has(id))]
      : kept[index]!;
    resolved.set(pane.id, {
      kind: "pane",
      id: pane.id,
      tabIds,
      activeTabId:
        pane.activeTabId !== null && tabIds.includes(pane.activeTabId)
          ? pane.activeTabId
          : (tabIds[0] ?? null),
      index,
      isPrimary,
    });
  });
  const focused = resolved.get(state.focusedPaneId) ?? resolved.get(primary.id)!;
  return {
    root: resolveNode(state.root, resolved),
    panes: [...resolved.values()],
    focusedPaneId: focused.id,
    primaryPaneId: primary.id,
    activeTabId: focused.activeTabId,
  };
}

function resolveNode(
  node: SplitViewNode,
  resolved: ReadonlyMap<string, ResolvedSplitViewPane>,
): ResolvedSplitViewNode {
  // Every pane of this tree was just put in the map, keyed by the same ids.
  if (node.kind === "pane") return resolved.get(node.id)!;
  return {
    kind: "split",
    id: node.id,
    direction: node.direction,
    ratio: node.ratio,
    first: resolveNode(node.first, resolved),
    second: resolveNode(node.second, resolved),
  };
}
