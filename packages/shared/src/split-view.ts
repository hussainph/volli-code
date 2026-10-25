/**
 * A surface owns one ordinary tab strip and any number of bounded tab pairs.
 * `pairs` is additive persisted metadata; `root` remains a valid legacy tree
 * containing only the selected pair (or a single full-width tab). Older builds
 * ignore the metadata and recover every other tab from the surface's live strip.
 * No operation closes a tab: removing a pair only relinquishes its membership.
 * Missing live IDs are reconciled at render time, never pruned at rest.
 */

/** `row` = side-by-side (a vertical divider); `column` = stacked. */
export type SplitViewDirection = "row" | "column";

/**
 * Where a split opens the new pane. `right`/`down` are what ⌘\ and ⇧⌘\ open;
 * a drop may also open `left`/`up` (VC-614), which puts the new pane FIRST.
 */
export type SplitViewEdge = "left" | "right" | "up" | "down";

/** The branch direction an edge opens. */
export function splitEdgeDirection(edge: SplitViewEdge): SplitViewDirection {
  return edge === "left" || edge === "right" ? "row" : "column";
}

/** Whether the pane an edge opens comes before the pane it was opened beside. */
export function splitEdgeLeads(edge: SplitViewEdge): edge is "left" | "up" {
  return edge === "left" || edge === "up";
}

/** The trailing edge on a leading edge's axis: a leading split is a trailing one, mirrored. */
function trailingEdge(edge: "left" | "up"): SplitViewEdge {
  return edge === "left" ? "right" : "down";
}

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

export interface SplitViewPair extends SplitViewBranch {
  first: SplitViewPane;
  second: SplitViewPane;
}

export interface SplitViewState {
  /** Absent only on legacy state; each member belongs to at most one pair. */
  pairs?: readonly SplitViewPair[];
  /** The selected ordinary tab or focused member; null for an empty menu. */
  selectedTabId?: string | null;
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
  return state.root.kind === "pane" && (state.pairs?.length ?? 0) === 0;
}

/** Focus a pane. Ignores an id that names none — focus is never left dangling. */
export function focusPane(state: SplitViewState, paneId: string): SplitViewState {
  if (state.pairs !== undefined) return focusPairPane(state, paneId);
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
  if (state.pairs !== undefined) return activatePairTab(state, tabId);
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
 * Assign an unclaimed tab to a pane without moving focus. A draft's first
 * content may arrive after focus has moved elsewhere; its placement still
 * belongs to the pane where it was composed. Only `activate` changes that
 * pane's front tab. Already-claimed tabs and missing panes are left alone.
 */
export function claimTabInPane(
  state: SplitViewState,
  tabId: string,
  paneId: string,
  activate: boolean,
): SplitViewState {
  if (state.pairs !== undefined) {
    // A background draft is ordinary until explicitly fronted. A bounded
    // partner has no hidden per-pane tab stack to claim an inactive tab into.
    if (!activate || pairForTab(state, tabId) !== null) return state;
    const pair = state.pairs.find((candidate) =>
      [candidate.first, candidate.second].some(
        (pane) => pane.id === paneId && pane.activeTabId === null,
      ),
    );
    if (pair === undefined) return state;
    const next = fillPairPane(state, pair, paneId, tabId);
    return projectPairs(
      next,
      next.pairs!,
      state.focusedPaneId === paneId ? tabId : (state.selectedTabId ?? null),
      state.focusedPaneId,
    );
  }
  if (findPaneWithTab(state, tabId) !== null) return state;
  return replacePane(state, paneId, (pane) => ({
    ...pane,
    tabIds: [...pane.tabIds, tabId],
    activeTabId: activate ? tabId : pane.activeTabId,
  }));
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
  if (state.pairs !== undefined) {
    const pair = state.pairs.find(
      (candidate) => candidate.first.id === paneId || candidate.second.id === paneId,
    );
    if (pair === undefined) return state;
    const other = pair.first.id === paneId ? pair.second : pair.first;
    const selected = state.root.id === pair.id ? other.activeTabId : state.selectedTabId;
    return projectPairs(
      state,
      state.pairs.filter((item) => item !== pair),
      selected ?? null,
    );
  }
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
  if (state.pairs !== undefined) {
    if (pairForTab(state, tabId) !== null) return unpairTab(state, tabId);
    return state.selectedTabId === tabId ? projectPairs(state, state.pairs, null) : state;
  }
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
  if (state.pairs !== undefined) {
    const pair = state.pairs.find(
      (candidate) => candidate.first.id === paneId || candidate.second.id === paneId,
    );
    if (pair === undefined) return state;
    const target = pair.first.id === paneId ? pair.first : pair.second;
    if (target.activeTabId === tabId) return focusPane(state, paneId);
    // A full pair cannot absorb a third member, even through a centre drop.
    if (target.activeTabId !== null) return state;
    return fillPairPane(state, pair, paneId, tabId);
  }
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
  if (state.pairs !== undefined) return state; // One member per pane; ordering belongs to the strip.
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
  if (state.pairs !== undefined) {
    const target = findPane(state, paneId);
    if (target?.activeTabId == null || pairForTab(state, target.activeTabId) !== null) return state;
    if (!splitEdgeLeads(edge))
      return pairTabs(state, target.activeTabId, opts.tabId ?? null, edge, mintId, paneId);
    // The incoming tab leads, and it is the one the person is now working in.
    const paired = pairTabs(
      state,
      opts.tabId ?? null,
      target.activeTabId,
      trailingEdge(edge),
      mintId,
    );
    const pair = pairForTab(paired, target.activeTabId);
    return pair === null ? paired : focusPane(paired, pair.first.id);
  }
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
  const leads = splitEdgeLeads(edge);
  const split = replacePane(detached, paneId, (pane) => ({
    kind: "split",
    id: mintId(),
    direction: splitEdgeDirection(edge),
    ratio: SPLIT_VIEW_DEFAULT_RATIO,
    first: leads ? opened : pane,
    second: leads ? pane : opened,
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
  if (state.pairs !== undefined) {
    const pair = state.pairs.find((candidate) => candidate.id === splitId);
    const clamped = clampRatio(ratio);
    if (pair === undefined || pair.ratio === clamped) return state;
    return projectPairs(
      state,
      state.pairs.map((item) => (item === pair ? { ...item, ratio: clamped } : item)),
      state.selectedTabId ?? null,
      state.focusedPaneId,
    );
  }
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
  if (state.pairs !== undefined) {
    const pair = pairForTab(state, fromId);
    if (pair === null) return state;
    const stripped = unpairTab(state, toId);
    const rename = (pane: SplitViewPane): SplitViewPane =>
      pane.activeTabId === fromId ? { ...pane, activeTabId: toId, tabIds: [toId] } : pane;
    const renamedPair = { ...pair, first: rename(pair.first), second: rename(pair.second) };
    const pairs = stripped.pairs!.map((item) => (item.id === pair.id ? renamedPair : item));
    return projectPairs(
      stripped,
      pairs,
      state.selectedTabId === fromId || state.selectedTabId === toId
        ? toId
        : (state.selectedTabId ?? null),
      state.focusedPaneId,
    );
  }
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
function sanitizeLegacySplitView(raw: object): SplitViewState | null {
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
  /** The primary pane holds the permanent tab, at the start of the main tab bar. */
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
  if (state.pairs !== undefined) return resolvePairView(state, orderedTabIds, permanentTabId);
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

/** Pair membership for the combined strip chip; never depends on selection. */
export function pairForTab(state: SplitViewState | null, tabId: string): SplitViewPair | null {
  return (
    state?.pairs?.find(
      (pair) => pair.first.activeTabId === tabId || pair.second.activeTabId === tabId,
    ) ?? null
  );
}

/** Enter the additive model without creating a split. */
export function groupedSplitView(
  tabIds: readonly string[],
  selectedTabId: string | null,
): SplitViewState {
  return { ...singlePaneSplitView(tabIds, selectedTabId), pairs: [], selectedTabId };
}

function member(id: string, tabId: string | null): SplitViewPane {
  return { kind: "pane", id, tabIds: tabId === null ? [] : [tabId], activeTabId: tabId };
}

/**
 * A pair member may never be called {@link SPLIT_VIEW_ROOT_PANE_ID}: that id
 * already names the full-width pane every unpaired tab is drawn in, so a member
 * wearing it would answer "focus root" — any click in a full-width tab — by
 * selecting its pair (VC-614). Splitting the full-width pane, a legacy split's
 * primary pane and pairs an earlier build of this branch persisted all arrive
 * with it; each is renamed under its own pair here.
 */
function memberPaneId(pairId: string, paneId: string, slot: "first" | "second"): string {
  return paneId === SPLIT_VIEW_ROOT_PANE_ID ? `${pairId}:${slot}` : paneId;
}

function pairMember(pairId: string, pane: SplitViewPane, slot: "first" | "second"): SplitViewPane {
  const id = memberPaneId(pairId, pane.id, slot);
  return id === pane.id ? pane : { ...pane, id };
}

function projectPairs(
  state: SplitViewState,
  pairs: readonly SplitViewPair[],
  selectedTabId: string | null,
  focusId?: string,
): SplitViewState {
  const pair =
    selectedTabId === null
      ? undefined
      : pairs.find(
          (candidate) =>
            candidate.first.activeTabId === selectedTabId ||
            candidate.second.activeTabId === selectedTabId,
        );
  const root = pair ?? member(SPLIT_VIEW_ROOT_PANE_ID, selectedTabId);
  const focusedPaneId =
    pair === undefined
      ? SPLIT_VIEW_ROOT_PANE_ID
      : [pair.first.id, pair.second.id].includes(focusId ?? "")
        ? focusId!
        : pair.first.activeTabId === selectedTabId
          ? pair.first.id
          : pair.second.id;
  if (
    state.pairs === pairs &&
    state.root === root &&
    state.selectedTabId === selectedTabId &&
    state.focusedPaneId === focusedPaneId
  )
    return state;
  return { root, focusedPaneId, pairs, selectedTabId };
}

/** Explicit pairing intent (chip edge drop / browser beside its owning chat).
 * A null member is a temporary partner menu; at least one member must be real.
 * Re-pairing releases former partners as ordinary tabs; no tab is ever closed.
 */
export function pairTabs(
  state: SplitViewState,
  firstTabId: string | null,
  secondTabId: string | null,
  edge: SplitViewEdge,
  mintId: () => string,
  firstPaneId?: string,
): SplitViewState {
  if (firstTabId === "" || secondTabId === "" || firstTabId === secondTabId) return state;
  const existing = pairForTab(state, (firstTabId ?? secondTabId)!);
  if (
    existing?.first.activeTabId === firstTabId &&
    existing.second.activeTabId === secondTabId &&
    existing.direction === splitEdgeDirection(edge)
  ) {
    return projectPairs(
      state,
      state.pairs!,
      secondTabId ?? firstTabId,
      firstTabId === null ? existing.first.id : existing.second.id,
    );
  }
  const pairs = (state.pairs ?? []).filter(
    (pair) =>
      ![pair.first.activeTabId, pair.second.activeTabId].some(
        (id) => id !== null && (id === firstTabId || id === secondTabId),
      ),
  );
  // Pane ids are globally unique across pairs, including hidden ones.
  const used = new Set(pairs.flatMap((pair) => [pair.first.id, pair.second.id]));
  const secondId = mintId();
  const id = mintId();
  const firstId =
    firstPaneId !== undefined && !used.has(firstPaneId)
      ? memberPaneId(id, firstPaneId, "first")
      : `${id}:first`;
  const pair: SplitViewPair = {
    kind: "split",
    id,
    direction: splitEdgeDirection(edge),
    ratio: SPLIT_VIEW_DEFAULT_RATIO,
    first: member(firstId, firstTabId),
    second: member(secondId, secondTabId),
  };
  return projectPairs(
    state,
    [...pairs, pair],
    secondTabId ?? firstTabId,
    firstTabId === null ? firstId : secondId,
  );
}

/** Drag-out and close both dissolve membership; the caller owns tab lifetime. */
export function unpairTab(state: SplitViewState, tabId: string): SplitViewState {
  const pair = pairForTab(state, tabId);
  if (pair === null) return state;
  const other = pair.first.activeTabId === tabId ? pair.second.activeTabId : pair.first.activeTabId;
  return projectPairs(
    state,
    state.pairs!.filter((item) => item !== pair),
    state.selectedTabId === tabId ? other : (state.selectedTabId ?? null),
  );
}

function fillPairPane(
  state: SplitViewState,
  pair: SplitViewPair,
  paneId: string,
  tabId: string,
): SplitViewState {
  const detached = unpairTab(state, tabId);
  const next =
    pair.first.id === paneId
      ? { ...pair, first: member(paneId, tabId) }
      : { ...pair, second: member(paneId, tabId) };
  return projectPairs(
    detached,
    detached.pairs!.map((item) => (item.id === pair.id ? next : item)),
    tabId,
    paneId,
  );
}

function activatePairTab(state: SplitViewState, tabId: string): SplitViewState {
  const pair = pairForTab(state, tabId);
  if (pair !== null) return projectPairs(state, state.pairs!, tabId);
  // Only an explicitly focused empty partner accepts activation. Ordinary
  // selections never replace a member of a completed pair.
  const pending = state.pairs!.find((candidate) =>
    [candidate.first, candidate.second].some(
      (pane) => pane.id === state.focusedPaneId && pane.activeTabId === null,
    ),
  );
  if (pending !== undefined) return fillPairPane(state, pending, state.focusedPaneId, tabId);
  if (state.root.kind === "pane" && state.selectedTabId === tabId) return state;
  return projectPairs(state, state.pairs!, tabId);
}

function focusPairPane(state: SplitViewState, paneId: string): SplitViewState {
  if (state.focusedPaneId === paneId) return state;
  const pair = state.pairs!.find(
    (candidate) => candidate.first.id === paneId || candidate.second.id === paneId,
  );
  if (pair === undefined) return state;
  const pane = pair.first.id === paneId ? pair.first : pair.second;
  // Keep the owner's selection while the partner menu is empty.
  return projectPairs(
    state,
    state.pairs!,
    pane.activeTabId ?? pair.first.activeTabId ?? pair.second.activeTabId,
    paneId,
  );
}

/** Tolerant migration: only the front tabs of the first two old panes pair.
 * All other tabs remain in the surface's authoritative strip, not pane claims.
 */
export function sanitizeSplitView(raw: unknown): SplitViewState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as { pairs?: unknown; selectedTabId?: unknown; focusedPaneId?: unknown };
  if (record.pairs === undefined) {
    const legacy = sanitizeLegacySplitView(raw);
    if (legacy === null) return null;
    const [first, second] = splitViewPanes(legacy);
    if (first!.activeTabId === null || second!.activeTabId === null) return null;
    const branch = legacy.root as SplitViewBranch;
    const pair: SplitViewPair = {
      ...branch,
      first: member(memberPaneId(branch.id, first!.id, "first"), first!.activeTabId),
      second: member(memberPaneId(branch.id, second!.id, "second"), second!.activeTabId),
    };
    const selected = activeTabInSplitView(legacy) ?? first!.activeTabId;
    return projectPairs(groupedSplitView([], selected), [pair], selected);
  }
  if (!Array.isArray(record.pairs)) return null;
  const pairs: SplitViewPair[] = [];
  const usedNodes = new Set<string>();
  const usedTabs = new Set<string>();
  for (const rawPair of record.pairs) {
    const node = sanitizeNode(rawPair, new Set(), new Set(), 1);
    if (node?.kind !== "split" || node.first.kind !== "pane" || node.second.kind !== "pane")
      continue;
    const first = pairMember(node.id, node.first, "first");
    const second = pairMember(node.id, node.second, "second");
    if (
      (first.activeTabId === null && second.activeTabId === null) ||
      [first, second].some(
        (pane) => pane.tabIds.length > 1 || (pane.tabIds.length === 1 && pane.activeTabId === null),
      )
    )
      continue;
    const ids = [node.id, first.id, second.id];
    const tabs = [...first.tabIds, ...second.tabIds];
    if (ids.some((id) => usedNodes.has(id)) || tabs.some((id) => usedTabs.has(id))) continue;
    ids.forEach((id) => usedNodes.add(id));
    tabs.forEach((id) => usedTabs.add(id));
    pairs.push({ ...node, first, second });
  }
  if (pairs.length === 0) return null;
  const selected =
    typeof record.selectedTabId === "string" || record.selectedTabId === null
      ? record.selectedTabId
      : (pairs[0]!.first.activeTabId ?? pairs[0]!.second.activeTabId);
  return projectPairs(
    groupedSplitView([], selected),
    pairs,
    selected,
    typeof record.focusedPaneId === "string" ? record.focusedPaneId : undefined,
  );
}

/** Selected-pair render projection. Unrelated selections are full width;
 * absent pair members degrade to the selected live tab until hydration arrives.
 */
export function projectSplitView(
  state: SplitViewState | null,
  orderedTabIds: readonly string[],
  selectedTabId: string | null,
  permanentTabId: string,
): ResolvedSplitView {
  if (state === null)
    return resolvePairView(groupedSplitView([], selectedTabId), orderedTabIds, permanentTabId);
  if (state.pairs === undefined) return resolveSplitView(state, orderedTabIds, permanentTabId);
  // Renderer-local draft overlays may replace a pane's front without writing
  // empty Draft IDs to pair metadata. Retain that root only for its own pair.
  const next =
    state.selectedTabId === selectedTabId
      ? state
      : renderedPair(state, selectedTabId) !== null
        ? { ...state, selectedTabId }
        : projectPairs(state, state.pairs, selectedTabId);
  return resolvePairView(next, orderedTabIds, permanentTabId);
}

function renderedPair(state: SplitViewState, selectedTabId: string | null): SplitViewPair | null {
  const pair = pairForTab(state, selectedTabId ?? "");
  const { root } = state;
  const saved = state.pairs!.find((item) => item.id === root.id);
  if (
    root.kind === "split" &&
    root.first.kind === "pane" &&
    root.second.kind === "pane" &&
    saved !== undefined &&
    (saved.first.activeTabId === null || saved.first.activeTabId === root.first.activeTabId) &&
    (saved.second.activeTabId === null || saved.second.activeTabId === root.second.activeTabId) &&
    (root.id === pair?.id ||
      root.first.activeTabId === selectedTabId ||
      root.second.activeTabId === selectedTabId)
  ) {
    return { ...root, first: root.first, second: root.second };
  }
  return pair;
}

function resolvePairView(
  state: SplitViewState,
  orderedTabIds: readonly string[],
  permanentTabId: string,
): ResolvedSplitView {
  const live = new Set([permanentTabId, ...orderedTabIds]);
  const pair = renderedPair(state, state.selectedTabId ?? null);
  const selected =
    state.selectedTabId !== null &&
    state.selectedTabId !== undefined &&
    live.has(state.selectedTabId)
      ? state.selectedTabId
      : permanentTabId;
  const root =
    pair !== null &&
    (pair.first.activeTabId === null || live.has(pair.first.activeTabId)) &&
    (pair.second.activeTabId === null || live.has(pair.second.activeTabId))
      ? pair
      : member(SPLIT_VIEW_ROOT_PANE_ID, selected);
  const panes: ResolvedSplitViewPane[] = [];
  const visit = (pane: SplitViewPane): ResolvedSplitViewPane => {
    const resolved = { ...pane, index: panes.length, isPrimary: panes.length === 0 };
    panes.push(resolved);
    return resolved;
  };
  const resolvedRoot: ResolvedSplitViewNode =
    root.kind === "pane"
      ? visit(root)
      : { ...root, first: visit(root.first), second: visit(root.second) };
  const focused = panes.find((pane) => pane.id === state.focusedPaneId) ?? panes[0]!;
  return {
    root: resolvedRoot,
    panes,
    focusedPaneId: focused.id,
    primaryPaneId: panes[0]!.id,
    activeTabId: focused.activeTabId,
  };
}
