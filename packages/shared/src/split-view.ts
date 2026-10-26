/**
 * TAB GROUPS (VC-614): a surface — Home, or one Ticket view — owns one
 * ordinary tab strip and any number of groups.
 *
 * A GROUP is a split tree of two or more panes, each pane holding a STACK of
 * tabs (`tabIds`, with `activeTabId` in front) — the split view this app had
 * before, one per group. The surface's top strip draws a group as ONE chip.
 * Selecting any tab of a group shows the whole group with that tab in front of
 * its pane and that pane focused; selecting an ordinary tab shows that tab full
 * width and never pulls it into a group; coming back to a group restores its
 * exact layout, ratios, stacks and fronts.
 *
 * OPEN is not SELECT. A tab that is newly OPENED (a new chat or terminal, a new
 * Browser Tab, a file opened from ⌘P or a tree) while a group is shown joins
 * the focused pane's stack, in front — {@link openTab}. With no group shown it
 * is exactly a selection.
 *
 * INVARIANTS, held by every operation here and re-established on read:
 *
 *  • a tab belongs to at most one pane of at most one group;
 *  • pane ids are unique across all groups and are never
 *    {@link SPLIT_VIEW_ROOT_PANE_ID}, which names the full-width pane;
 *  • every group has at least two panes and at least one tab — an operation
 *    that leaves fewer DISSOLVES the group, and its tabs become ordinary strip
 *    tabs. No operation here ever closes a tab;
 *  • a pane that holds tabs has one of them in front; an EMPTY pane (what ⌘\
 *    opens) is allowed and draws the surface's menu;
 *  • `root` is the shown group itself (the same object as its `pairs` entry) or
 *    one full-width pane holding the selected ordinary tab;
 *  • a no-op returns its input by identity.
 *
 * PERSISTED SHAPE, additive and N−1-safe: the groups live in `pairs` (the field
 * kept the name it had while every group was a pair), and `root` is always a
 * valid legacy split tree — the shown group, or a single pane, which an older
 * build reads as "not split". Losing the grouping on downgrade is the accepted
 * degradation; every tab still comes back through the surface's own strip.
 * Missing live ids are reconciled at render time, never pruned at rest.
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

/** Pane-to-pane focus movement, resolved geometrically. */
export type SplitViewFocusDirection = "left" | "right" | "up" | "down";

export interface SplitViewPane {
  kind: "pane";
  id: string;
  /** This pane's tab stack, in its strip's order. Ids may name nothing live. */
  tabIds: readonly string[];
  /** The pane's front tab, or null — only an empty pane, which draws the menu. */
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

/** A tab group: a split tree of two or more panes. Its id is its root branch's. */
export type SplitViewGroup = SplitViewBranch;

export interface SplitViewState {
  /** Every group on the surface (persisted under its first name, `pairs`). */
  pairs: readonly SplitViewGroup[];
  /**
   * The surface's selected tab: the full-width ordinary tab, or the shown
   * group's focused front — or, while that pane is empty, the group tab that
   * was selected before. `null` selects nothing.
   */
  selectedTabId: string | null;
  /** The shown group, or the one full-width pane. Always a legacy-valid tree. */
  root: SplitViewNode;
  /** A pane of `root`; {@link SPLIT_VIEW_ROOT_PANE_ID} while nothing is grouped. */
  focusedPaneId: string;
}

/**
 * The id of the full-width pane an ordinary tab is drawn in — and, for that
 * reason, never the id of a pane inside a group: a member wearing it would
 * answer "focus root", which is every click in a full-width tab (VC-614).
 */
export const SPLIT_VIEW_ROOT_PANE_ID = "root";

/** A fresh split divides its pane down the middle. */
export const SPLIT_VIEW_DEFAULT_RATIO = 0.5;

/** Neither pane of a branch may be squeezed below this share of it. */
export const SPLIT_VIEW_MIN_RATIO = 0.15;
export const SPLIT_VIEW_MAX_RATIO = 0.85;

/**
 * Beyond these a group is not drawn: a split refuses to make one, and a
 * rehydrated one is dropped. Nine panes or seven levels is not a layout anybody
 * arranged, and drawing it is worse than showing its tabs ungrouped.
 */
export const SPLIT_VIEW_MAX_PANES = 8;
export const SPLIT_VIEW_MAX_DEPTH = 6;

// ---------------------------------------------------------------------------
// Trees

/**
 * Rewrite a tree bottom-up, keeping every subtree that did not change BY
 * IDENTITY — so a change deep in one branch rebuilds the spine down to it and
 * leaves the other side alone, and a resize cannot invalidate a memoized pane
 * on the far side of the tree.
 */
function rewrite(node: SplitViewNode, map: (node: SplitViewNode) => SplitViewNode): SplitViewNode {
  if (node.kind === "pane") return map(node);
  const first = rewrite(node.first, map);
  const second = rewrite(node.second, map);
  return map(first === node.first && second === node.second ? node : { ...node, first, second });
}

/** Replace one pane of a tree — with a pane, or with the branch that splits it. */
function replacePane(
  node: SplitViewNode,
  paneId: string,
  replace: (pane: SplitViewPane) => SplitViewNode,
): SplitViewNode {
  return rewrite(node, (child) =>
    child.kind === "pane" && child.id === paneId ? replace(child) : child,
  );
}

function collectPanes(node: SplitViewNode, out: SplitViewPane[]): void {
  if (node.kind === "pane") {
    out.push(node);
    return;
  }
  collectPanes(node.first, out);
  collectPanes(node.second, out);
}

/** A tree's panes in reading order: top-left first. */
function panesOf(node: SplitViewNode): SplitViewPane[] {
  const panes: SplitViewPane[] = [];
  collectPanes(node, panes);
  return panes;
}

function depthOf(node: SplitViewNode): number {
  return node.kind === "pane" ? 1 : 1 + Math.max(depthOf(node.first), depthOf(node.second));
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
  // Only ever asked about a pane the tree holds: if not under `first`, under `second`.
  const first = dropPane(node.first, paneId);
  if (first !== node.first) return { ...node, first };
  return { ...node, second: dropPane(node.second, paneId) };
}

/**
 * Drop `tabId` from a pane's stack, handing the front to its successor — the
 * next tab in the stack, else the previous one.
 */
function paneWithoutTab(pane: SplitViewPane, tabId: string): SplitViewPane {
  const index = pane.tabIds.indexOf(tabId);
  const tabIds = pane.tabIds.filter((id) => id !== tabId);
  if (pane.activeTabId !== tabId) return { ...pane, tabIds };
  return { ...pane, tabIds, activeTabId: tabIds[index] ?? tabIds.at(-1) ?? null };
}

/** `tabId` pushed onto a pane's stack. A pane holding tabs always has a front. */
function paneWithTab(pane: SplitViewPane, tabId: string, front: boolean): SplitViewPane {
  return {
    ...pane,
    tabIds: [...pane.tabIds, tabId],
    activeTabId: front || pane.activeTabId === null ? tabId : pane.activeTabId,
  };
}

/**
 * `tabId` taken out of the group tree that holds it. The pane it leaves
 * COLLAPSES if that emptied it — an empty pane nobody asked for is a hole —
 * while an untouched empty pane (a ⌘\ menu) stays. Focus that was on the
 * collapsed pane moves into the sibling that takes its space.
 */
function treeWithoutTab(
  tree: SplitViewGroup,
  tabId: string,
  focusId: string,
): { tree: SplitViewNode; focusId: string } {
  const holder = panesOf(tree).find((pane) => pane.tabIds.includes(tabId))!;
  const stripped = paneWithoutTab(holder, tabId);
  if (stripped.tabIds.length > 0) {
    return { tree: replacePane(tree, holder.id, () => stripped), focusId };
  }
  // A pane of a branch always has a sibling.
  const sibling = siblingOf(tree, holder.id)!;
  return {
    tree: dropPane(tree, holder.id),
    focusId: focusId === holder.id ? panesOf(sibling)[0]!.id : focusId,
  };
}

function holds(node: SplitViewNode, tabId: string): boolean {
  return panesOf(node).some((pane) => pane.tabIds.includes(tabId));
}

/** Whether a tree is still a group: two or more panes, and a tab to show. */
function viable(tree: SplitViewNode): tree is SplitViewGroup {
  return tree.kind === "split" && panesOf(tree).some((pane) => pane.tabIds.length > 0);
}

/** Only the trees that are still groups. */
function viableGroups(trees: readonly SplitViewNode[]): readonly SplitViewGroup[] {
  return trees.filter((tree) => viable(tree));
}

/**
 * Every group with `tabId` taken out (see {@link treeWithoutTab}), positions
 * kept, NOT yet checked for viability — a caller about to put the tab back into
 * the same group must see that group before a collapse dissolves it.
 */
function withoutTabEverywhere(
  pairs: readonly SplitViewGroup[],
  tabId: string,
): readonly SplitViewNode[] {
  return pairs.map((group) =>
    holds(group, tabId) ? treeWithoutTab(group, tabId, "").tree : group,
  );
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function clampRatio(ratio: number): number {
  return Math.min(SPLIT_VIEW_MAX_RATIO, Math.max(SPLIT_VIEW_MIN_RATIO, ratio));
}

// ---------------------------------------------------------------------------
// Readers

/** The shown panes, in reading order — one full-width pane while ungrouped. */
export function splitViewPanes(state: SplitViewState): readonly SplitViewPane[] {
  return panesOf(state.root);
}

/** Every pane of every group, shown or not, in group then reading order. */
export function groupedPanes(state: SplitViewState): readonly SplitViewPane[] {
  return state.pairs.flatMap((group) => panesOf(group));
}

/** Every tab a group holds, pane by pane in reading order. */
export function groupTabIds(group: SplitViewNode): readonly string[] {
  return panesOf(group).flatMap((pane) => pane.tabIds);
}

/** The group `tabId` belongs to, or null for an ordinary tab. Never depends on selection. */
export function groupForTab(state: SplitViewState | null, tabId: string): SplitViewGroup | null {
  return state?.pairs.find((group) => holds(group, tabId)) ?? null;
}

/** Which group pane holds `tabId`, or null for an ordinary tab. */
export function paneForTab(state: SplitViewState, tabId: string): string | null {
  return groupedPanes(state).find((pane) => pane.tabIds.includes(tabId))?.id ?? null;
}

/**
 * The focused pane's front tab — THE surface's active tab, and so the context
 * the right rail reads. `null` while the focused pane is empty.
 */
export function activeTabInSplitView(state: SplitViewState): string | null {
  return panesOf(state.root).find((pane) => pane.id === state.focusedPaneId)?.activeTabId ?? null;
}

/** The group on screen, or null while an ordinary tab is shown full width. */
function shownGroup(state: SplitViewState): SplitViewGroup | null {
  const { root } = state;
  return root.kind === "split" ? (state.pairs.find((group) => group.id === root.id) ?? null) : null;
}

function locatePane(
  state: SplitViewState,
  paneId: string,
): { index: number; group: SplitViewGroup; pane: SplitViewPane } | null {
  for (const [index, group] of state.pairs.entries()) {
    const pane = panesOf(group).find((candidate) => candidate.id === paneId);
    if (pane !== undefined) return { index, group, pane };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Projection: which group (or tab) is on screen

function fullWidthPane(tabId: string | null): SplitViewPane {
  return {
    kind: "pane",
    id: SPLIT_VIEW_ROOT_PANE_ID,
    tabIds: tabId === null ? [] : [tabId],
    activeTabId: tabId,
  };
}

function settle(
  state: SplitViewState,
  pairs: readonly SplitViewGroup[],
  root: SplitViewNode,
  focusedPaneId: string,
  selectedTabId: string | null,
): SplitViewState {
  if (
    state.pairs === pairs &&
    state.root === root &&
    state.focusedPaneId === focusedPaneId &&
    state.selectedTabId === selectedTabId
  ) {
    return state;
  }
  return { pairs, selectedTabId, root, focusedPaneId };
}

/** Show `tabId` full width (or nothing, for null) beside `pairs`. */
function showFull(
  state: SplitViewState,
  pairs: readonly SplitViewGroup[],
  tabId: string | null,
): SplitViewState {
  // A pane root is only ever the full-width pane, so its front says what it holds.
  const { root } = state;
  const reuse = root.kind === "pane" && root.activeTabId === tabId;
  return settle(state, pairs, reuse ? root : fullWidthPane(tabId), SPLIT_VIEW_ROOT_PANE_ID, tabId);
}

/**
 * Show `group` (already in `pairs`) with `paneId` focused. The selection is the
 * focused front; an empty focused pane keeps `preferred` when that is one of
 * the group's tabs, else the group's first front.
 */
function showGroup(
  state: SplitViewState,
  pairs: readonly SplitViewGroup[],
  group: SplitViewGroup,
  paneId: string,
  preferred: string | null,
): SplitViewState {
  const panes = panesOf(group);
  const pane = panes.find((candidate) => candidate.id === paneId) ?? panes[0]!;
  const selected =
    pane.activeTabId ??
    (preferred !== null && holds(group, preferred) ? preferred : null) ??
    // A group always holds a tab, and a pane holding tabs has one in front.
    panes.find((candidate) => candidate.activeTabId !== null)!.activeTabId;
  return settle(state, pairs, group, pane.id, selected);
}

/** Replace (or, for a tree that is no longer a group, drop) `pairs[index]`. */
function withGroup(
  pairs: readonly SplitViewGroup[],
  index: number,
  tree: SplitViewNode,
): readonly SplitViewGroup[] {
  return viable(tree)
    ? pairs.map((group, at) => (at === index ? tree : group))
    : pairs.filter((_, at) => at !== index);
}

/**
 * The surface after group `index` became `tree` — the shared tail of every
 * removal. A hidden group changes nothing on screen. The shown group stays
 * shown while it is still a group; a dissolved one hands the screen to the
 * front of the pane that was left, full width.
 */
function afterRemoval(
  state: SplitViewState,
  index: number,
  tree: SplitViewNode,
  focusId: string,
  preferred: string | null,
): SplitViewState {
  const pairs = withGroup(state.pairs, index, tree);
  if (shownGroup(state)?.id !== state.pairs[index]!.id) {
    return settle(state, pairs, state.root, state.focusedPaneId, state.selectedTabId);
  }
  if (viable(tree)) return showGroup(state, pairs, tree, focusId, preferred);
  return showFull(state, pairs, tree.kind === "pane" ? tree.activeTabId : null);
}

/** A surface with no groups, selecting `selectedTabId` full width. */
export function emptySplitView(selectedTabId: string | null): SplitViewState {
  return {
    pairs: [],
    selectedTabId,
    root: fullWidthPane(selectedTabId),
    focusedPaneId: SPLIT_VIEW_ROOT_PANE_ID,
  };
}

// ---------------------------------------------------------------------------
// Select and open

/**
 * SELECT `tabId` — THE write-through behind every "make this tab active" door
 * (a strip click, the Island's show, a notification). A group tab shows its
 * group, in front of its pane, that pane focused; an ordinary tab shows full
 * width and is never pulled into a group.
 */
export function selectTab(state: SplitViewState, tabId: string): SplitViewState {
  const index = state.pairs.findIndex((group) => holds(group, tabId));
  if (index === -1) return showFull(state, state.pairs, tabId);
  const group = state.pairs[index]!;
  const pane = panesOf(group).find((candidate) => candidate.tabIds.includes(tabId))!;
  if (pane.activeTabId === tabId) return showGroup(state, state.pairs, group, pane.id, tabId);
  const fronted = replacePane(group, pane.id, () => ({ ...pane, activeTabId: tabId }));
  return showGroup(
    state,
    withGroup(state.pairs, index, fronted),
    fronted as SplitViewGroup,
    pane.id,
    tabId,
  );
}

/**
 * OPEN `tabId` — a tab that did not exist a moment ago. While a group is shown
 * it joins the focused pane's stack, in front: the pane the person is working
 * in. Otherwise (and for a tab some group already holds) it is a selection.
 */
export function openTab(state: SplitViewState, tabId: string): SplitViewState {
  const shown = shownGroup(state);
  if (shown === null || groupForTab(state, tabId) !== null) return selectTab(state, tabId);
  const panes = panesOf(shown);
  // A shown group's focus is always one of its panes.
  const pane = panes.find((candidate) => candidate.id === state.focusedPaneId)!;
  const next = replacePane(shown, pane.id, () => paneWithTab(pane, tabId, true)) as SplitViewGroup;
  const index = state.pairs.indexOf(shown);
  return showGroup(state, withGroup(state.pairs, index, next), next, pane.id, tabId);
}

/**
 * Claim an ungrouped tab into a group pane without moving focus — a Draft's
 * first content, which may arrive after focus has moved on; its placement still
 * belongs to the pane it was composed in. Only `activate` puts it in front.
 * A tab some group already holds, and a pane no group has, are left alone.
 */
export function claimTabInPane(
  state: SplitViewState,
  tabId: string,
  paneId: string,
  activate: boolean,
): SplitViewState {
  if (groupForTab(state, tabId) !== null) return state;
  const found = locatePane(state, paneId);
  if (found === null) return state;
  const next = replacePane(found.group, paneId, (pane) =>
    paneWithTab(pane, tabId, activate),
  ) as SplitViewGroup;
  const pairs = withGroup(state.pairs, found.index, next);
  if (shownGroup(state) !== found.group) {
    return settle(state, pairs, state.root, state.focusedPaneId, state.selectedTabId);
  }
  return showGroup(state, pairs, next, state.focusedPaneId, state.selectedTabId);
}

// ---------------------------------------------------------------------------
// Membership

/**
 * Take `tabId` out of its group — the drag from a pane strip to the top strip,
 * and the membership half of every close. Its pane collapses if that emptied
 * it, and a group left with one pane (or no tab) dissolves. The tab itself
 * stays open; the caller owns its lifetime and whether to select it.
 */
export function ungroupTab(state: SplitViewState, tabId: string): SplitViewState {
  const index = state.pairs.findIndex((group) => holds(group, tabId));
  if (index === -1) return state;
  const group = state.pairs[index]!;
  const removed = treeWithoutTab(group, tabId, state.focusedPaneId);
  return afterRemoval(
    state,
    index,
    removed.tree,
    removed.focusId,
    state.selectedTabId === tabId ? null : state.selectedTabId,
  );
}

/**
 * The split-view half of closing `tabId`: out of its group (see
 * {@link ungroupTab}), or — for the ordinary tab shown full width — nothing
 * selected, so the surface's own return rule decides what comes forward.
 */
export function removeTab(state: SplitViewState, tabId: string): SplitViewState {
  if (groupForTab(state, tabId) !== null) return ungroupTab(state, tabId);
  return state.selectedTabId === tabId ? showFull(state, state.pairs, null) : state;
}

/**
 * Dissolve a whole group (the chip's Ungroup). Every tab stays open as an
 * ordinary tab; a shown group hands the screen to its selected tab, full width.
 */
export function ungroup(state: SplitViewState, groupId: string): SplitViewState {
  const index = state.pairs.findIndex((group) => group.id === groupId);
  if (index === -1) return state;
  const pairs = state.pairs.filter((_, at) => at !== index);
  if (shownGroup(state)?.id !== groupId) {
    return settle(state, pairs, state.root, state.focusedPaneId, state.selectedTabId);
  }
  return showFull(state, pairs, state.selectedTabId);
}

/**
 * Close a group pane — the empty pane's own menu row. Its tabs are
 * RELINQUISHED to the sibling that takes its space (that subtree's first pane),
 * never closed; focus follows the space. A group left with one pane dissolves.
 */
export function closePane(state: SplitViewState, paneId: string): SplitViewState {
  const found = locatePane(state, paneId);
  if (found === null) return state;
  const { group, pane, index } = found;
  // Every pane of a group is under a branch, so it has a sibling.
  const heir = panesOf(siblingOf(group, paneId)!)[0]!;
  const dropped = dropPane(group, paneId);
  const tree =
    pane.tabIds.length === 0
      ? dropped
      : replacePane(dropped, heir.id, (target) => ({
          ...target,
          tabIds: [...target.tabIds, ...pane.tabIds],
          activeTabId: target.activeTabId ?? pane.activeTabId,
        }));
  const focusId = state.focusedPaneId === paneId ? heir.id : state.focusedPaneId;
  return afterRemoval(state, index, tree, focusId, state.selectedTabId);
}

/**
 * Move `tabId` into a group pane's stack — a drop on a pane's centre, or on its
 * strip. It leaves wherever it was (that pane collapsing if emptied), lands in
 * front, and its pane takes focus. A group that ends with one pane — the tab
 * dropped into its only partner — dissolves, and the moved tab is shown.
 */
export function moveTabToPane(
  state: SplitViewState,
  tabId: string,
  paneId: string,
): SplitViewState {
  const target = locatePane(state, paneId);
  if (target === null) return state;
  if (target.pane.tabIds.includes(tabId)) return selectTab(state, tabId);
  const trees = withoutTabEverywhere(state.pairs, tabId);
  const tree = replacePane(trees[target.index]!, paneId, (pane) => paneWithTab(pane, tabId, true));
  const pairs = viableGroups(trees.map((node, at) => (at === target.index ? tree : node)));
  return viable(tree)
    ? showGroup(state, pairs, tree, paneId, tabId)
    : showFull(state, pairs, tabId);
}

/**
 * Rewrite one pane's stack order after a drag inside its strip. `ids` is that
 * strip as the drop left it; tabs the strip did not draw (not hydrated yet)
 * keep their membership at the end rather than being pruned.
 */
export function reorderPaneTabs(
  state: SplitViewState,
  paneId: string,
  ids: readonly string[],
): SplitViewState {
  const found = locatePane(state, paneId);
  if (found === null) return state;
  const { pane } = found;
  const drawn = [...new Set(ids)].filter((id) => pane.tabIds.includes(id));
  const tabIds = [...drawn, ...pane.tabIds.filter((id) => !drawn.includes(id))];
  if (sameIds(tabIds, pane.tabIds)) return state;
  const tree = replacePane(found.group, paneId, () => ({ ...pane, tabIds })) as SplitViewGroup;
  const pairs = withGroup(state.pairs, found.index, tree);
  return settle(
    state,
    pairs,
    shownGroup(state) === found.group ? tree : state.root,
    state.focusedPaneId,
    state.selectedTabId,
  );
}

// ---------------------------------------------------------------------------
// Splitting

/**
 * Split `paneId` on `edge`, opening a new pane there.
 *
 * Inside a group the new pane joins that group; on the full-width pane
 * ({@link SPLIT_VIEW_ROOT_PANE_ID}) it makes a NEW group of two, the ordinary
 * tab shown beside it. `opts.tabId` is the tab dragged into the new pane, taken
 * out of wherever it was; without one the new pane opens EMPTY — ⌘\, and the
 * menu the surface draws there. A leading edge (`left`/`up`) puts the new pane
 * first. Either way the new pane takes focus: it is the pane just made.
 *
 * Refused by identity: a pane's only tab dropped on its own edge (it would
 * trade one pane for an empty one beside it), a split past
 * {@link SPLIT_VIEW_MAX_PANES} or {@link SPLIT_VIEW_MAX_DEPTH}, and a pane that
 * is not there.
 *
 * `mintId` names the new pane, then the branch that holds it, then — for a new
 * group — the pane the full-width tab moves into.
 */
export function splitPane(
  state: SplitViewState,
  paneId: string,
  edge: SplitViewEdge,
  opts: { tabId?: string },
  mintId: () => string,
): SplitViewState {
  const { tabId } = opts;
  const split = (beside: SplitViewNode): SplitViewGroup => {
    const opened: SplitViewPane = {
      kind: "pane",
      id: mintId(),
      tabIds: tabId === undefined ? [] : [tabId],
      activeTabId: tabId ?? null,
    };
    const leads = splitEdgeLeads(edge);
    return {
      kind: "split",
      id: mintId(),
      direction: splitEdgeDirection(edge),
      ratio: SPLIT_VIEW_DEFAULT_RATIO,
      first: leads ? opened : beside,
      second: leads ? beside : opened,
    };
  };
  const openedOf = (group: SplitViewGroup): string =>
    (splitEdgeLeads(edge) ? group.first : group.second).id;
  const trees = tabId === undefined ? state.pairs : withoutTabEverywhere(state.pairs, tabId);

  if (paneId === SPLIT_VIEW_ROOT_PANE_ID) {
    const anchor = state.root.kind === "pane" ? state.root.activeTabId : null;
    if (anchor === null || anchor === tabId) return state;
    const made = split(fullWidthPane(anchor));
    const kept: SplitViewPane = { ...fullWidthPane(anchor), id: mintId() };
    const group: SplitViewGroup = splitEdgeLeads(edge)
      ? { ...made, second: kept }
      : { ...made, first: kept };
    return showGroup(
      state,
      [...viableGroups(trees), group],
      group,
      openedOf(group),
      tabId ?? anchor,
    );
  }

  const target = locatePane(state, paneId);
  if (target === null) return state;
  if (tabId !== undefined && sameIds(target.pane.tabIds, [tabId])) return state;
  let opened = "";
  const tree = replacePane(trees[target.index]!, paneId, (pane) => {
    const made = split(pane);
    opened = openedOf(made);
    return made;
  }) as SplitViewGroup;
  if (panesOf(tree).length > SPLIT_VIEW_MAX_PANES || depthOf(tree) > SPLIT_VIEW_MAX_DEPTH) {
    return state;
  }
  const pairs = viableGroups(trees.map((node, at) => (at === target.index ? tree : node)));
  return showGroup(state, pairs, tree, opened, tabId ?? state.selectedTabId);
}

/**
 * Group `tabId` beside `targetTabId` on `edge` — a tab dropped on a top-strip
 * tab's edge, and "Open beside chat". The target's pane is split (a new group
 * of two when the target is ordinary); a null `tabId` opens an empty pane
 * there. A tab already in the target's group is simply selected.
 */
export function groupTabs(
  state: SplitViewState,
  targetTabId: string,
  tabId: string | null,
  edge: SplitViewEdge,
  mintId: () => string,
): SplitViewState {
  if (tabId === targetTabId) return state;
  const group = groupForTab(state, targetTabId);
  if (tabId !== null && group !== null && groupForTab(state, tabId) === group) {
    return selectTab(state, tabId);
  }
  const anchored = selectTab(state, targetTabId);
  const next = splitPane(
    anchored,
    anchored.focusedPaneId,
    edge,
    tabId === null ? {} : { tabId },
    mintId,
  );
  return next === anchored ? state : next;
}

// ---------------------------------------------------------------------------
// Focus and geometry

/**
 * Focus a group pane (a click inside it), which shows its group. Ignores an id
 * no group has — the full-width pane included — so focus is never dangling.
 */
export function focusPane(state: SplitViewState, paneId: string): SplitViewState {
  if (state.focusedPaneId === paneId) return state;
  const found = locatePane(state, paneId);
  if (found === null) return state;
  return showGroup(state, state.pairs, found.group, paneId, state.selectedTabId);
}

/**
 * Resize a branch of any group. A non-finite ratio is refused rather than
 * clamped: a divider dragged inside a box that has not been measured yet
 * computes `NaN`, and a `NaN` share renders a pane with no size at all.
 */
export function setSplitRatio(
  state: SplitViewState,
  splitId: string,
  ratio: number,
): SplitViewState {
  if (!Number.isFinite(ratio)) return state;
  const clamped = clampRatio(ratio);
  for (const [index, group] of state.pairs.entries()) {
    const tree = rewrite(group, (node) =>
      node.kind === "split" && node.id === splitId && node.ratio !== clamped
        ? { ...node, ratio: clamped }
        : node,
    ) as SplitViewGroup;
    if (tree === group) continue;
    return settle(
      state,
      withGroup(state.pairs, index, tree),
      shownGroup(state) === group ? tree : state.root,
      state.focusedPaneId,
      state.selectedTabId,
    );
  }
  return state;
}

/**
 * Follow a tab whose IDENTITY changed while the tab stayed put — a preview slot
 * replaced in place, a renamed file. A stale tab already holding `toId` is
 * ABSORBED (taken out of its group), and a selection of either id follows the
 * tab that now carries it.
 */
export function renamedTabInSplitView(
  state: SplitViewState,
  fromId: string,
  toId: string,
): SplitViewState {
  if (fromId === toId) return state;
  const absorbed = ungroupTab(state, toId);
  const follows = state.selectedTabId === fromId || state.selectedTabId === toId;
  const index = absorbed.pairs.findIndex((group) => holds(group, fromId));
  if (index === -1) return follows ? showFull(absorbed, absorbed.pairs, toId) : absorbed;
  const group = absorbed.pairs[index]!;
  const tree = rewrite(group, (node) =>
    node.kind === "pane" && node.tabIds.includes(fromId)
      ? {
          ...node,
          tabIds: node.tabIds.map((id) => (id === fromId ? toId : id)),
          activeTabId: node.activeTabId === fromId ? toId : node.activeTabId,
        }
      : node,
  ) as SplitViewGroup;
  const pairs = withGroup(absorbed.pairs, index, tree);
  if (shownGroup(absorbed) === group) {
    return showGroup(
      absorbed,
      pairs,
      tree,
      absorbed.focusedPaneId,
      follows ? toId : absorbed.selectedTabId,
    );
  }
  const moved = settle(
    absorbed,
    pairs,
    absorbed.root,
    absorbed.focusedPaneId,
    absorbed.selectedTabId,
  );
  return follows ? selectTab(moved, toId) : moved;
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
 * Move focus to the visually adjacent pane of the shown group, or stay put at
 * an outer edge (focus never wraps).
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

// ---------------------------------------------------------------------------
// The tolerant read

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
  // id, so two nodes answering to one name is a tree nothing can operate on.
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
      activeTabId:
        typeof active === "string" && claimed.includes(active) ? active : (claimed[0] ?? null),
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

/**
 * One stored group, or null. Ids (nodes and tabs) must be unique across every
 * group already accepted: a later group's repeated node id refuses that group,
 * and a tab another group claimed is dropped from it (first mention wins). A
 * pane named {@link SPLIT_VIEW_ROOT_PANE_ID} — a legacy primary pane, or a pair
 * an earlier build persisted — is renamed under its group, recorded in `renamed`.
 */
function sanitizeGroup(
  raw: unknown,
  nodeIds: Set<string>,
  tabIds: Set<string>,
  renamed: Map<string, string>,
): SplitViewGroup | null {
  const nodes = new Set(nodeIds);
  const tabs = new Set(tabIds);
  const node = sanitizeNode(raw, nodes, tabs, 1);
  if (node === null || node.kind === "pane") return null;
  const panes = panesOf(node);
  if (panes.length > SPLIT_VIEW_MAX_PANES || !viable(node)) return null;
  let group: SplitViewGroup = node;
  if (panes.some((pane) => pane.id === SPLIT_VIEW_ROOT_PANE_ID)) {
    let id = `${node.id}:${SPLIT_VIEW_ROOT_PANE_ID}`;
    while (nodes.has(id)) id = `${id}'`;
    nodes.delete(SPLIT_VIEW_ROOT_PANE_ID);
    nodes.add(id);
    renamed.set(SPLIT_VIEW_ROOT_PANE_ID, id);
    group = replacePane(node, SPLIT_VIEW_ROOT_PANE_ID, (pane) => ({
      ...pane,
      id,
    })) as SplitViewGroup;
  }
  for (const id of nodes) nodeIds.add(id);
  for (const id of tabs) tabIds.add(id);
  return group;
}

/**
 * Validate a rehydrated split view from any build: a surface this one can
 * draw, or `null` — not a failure but the ungrouped surface, the one
 * degradation that is always safe.
 *
 * SHAPE ONLY: a pane may keep naming tabs nothing on screen answers to (the
 * module doc's rule). A stored `pairs` array is read group by group, each
 * malformed group dropped on its own. A LEGACY split (no `pairs` — the pane
 * tree an older build split the whole surface into) becomes ONE group, stacks
 * and all, focus kept. Pairs an earlier build of grouping wrote (two one-tab
 * panes) are groups as they stand.
 */
export function sanitizeSplitView(raw: unknown): SplitViewState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as {
    pairs?: unknown;
    root?: unknown;
    selectedTabId?: unknown;
    focusedPaneId?: unknown;
  };
  const legacy = record.pairs === undefined;
  if (!legacy && !Array.isArray(record.pairs)) return null;
  const candidates: readonly unknown[] = legacy ? [record.root] : (record.pairs as unknown[]);
  const nodeIds = new Set<string>();
  const tabIds = new Set<string>();
  const renamed = new Map<string, string>();
  const pairs: SplitViewGroup[] = [];
  for (const candidate of candidates) {
    const group = sanitizeGroup(candidate, nodeIds, tabIds, renamed);
    if (group !== null) pairs.push(group);
  }
  if (pairs.length === 0) return null;
  const base: SplitViewState = { ...emptySplitView(null), pairs };
  const storedFocus = typeof record.focusedPaneId === "string" ? record.focusedPaneId : null;
  // A legacy tree covered the whole surface, so it is the group on screen.
  if (legacy) {
    const focus = renamed.get(storedFocus ?? "") ?? storedFocus ?? "";
    return showGroup(base, pairs, pairs[0]!, focus, null);
  }
  const selected = typeof record.selectedTabId === "string" ? record.selectedTabId : null;
  const focused = storedFocus === null ? null : locatePane(base, storedFocus);
  if (focused !== null && (selected === null || holds(focused.group, selected))) {
    return showGroup(base, pairs, focused.group, storedFocus!, selected);
  }
  return selected === null ? base : selectTab(base, selected);
}

// ---------------------------------------------------------------------------
// The render projection

export interface ResolvedSplitViewPane {
  kind: "pane";
  id: string;
  /** This pane's live tabs, in the order its strip draws them. */
  tabIds: readonly string[];
  /** The tab this pane shows, or null — an empty pane draws the surface menu. */
  activeTabId: string | null;
  /** Reading-order position, for "Pane 2 of 3" labels. */
  index: number;
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
  /** Every shown pane in reading order — one, full width, while ungrouped. */
  panes: readonly ResolvedSplitViewPane[];
  focusedPaneId: string;
  /** The focused pane's tab: the surface's active tab, and the rail's context. */
  activeTabId: string | null;
  /** The shown group's id, or null while an ordinary tab is shown full width. */
  groupId: string | null;
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

/**
 * Project a surface's split view onto the tabs that actually exist — the
 * render-time half of the tolerant read, and the only place the model meets
 * live tabs.
 *
 * `selectedTabId` is the surface's active tab as it decided it (a restore, an
 * empty Draft overlay); when the stored selection differs, the view shows what
 * selecting it would. `orderedTabIds` is the surface's live strip; a pane keeps
 * its live tabs in its own order, its front falling back to its first live tab
 * and, with none, to the empty pane's menu — which is also what a pane of dead
 * terminal ids renders after a relaunch until they come back. A group with no
 * live tab at all, and a selected tab that is not live, degrade to the
 * permanent tab full width. Nothing is written back.
 */
export function projectSplitView(
  state: SplitViewState | null,
  orderedTabIds: readonly string[],
  selectedTabId: string,
  permanentTabId: string,
): ResolvedSplitView {
  const base = state ?? emptySplitView(selectedTabId);
  const next = base.selectedTabId === selectedTabId ? base : selectTab(base, selectedTabId);
  const live = new Set([permanentTabId, ...orderedTabIds]);
  if (next.root.kind === "split") {
    const resolved = new Map<string, ResolvedSplitViewPane>();
    panesOf(next.root).forEach((pane, index) => {
      const tabIds = pane.tabIds.filter((id) => live.has(id));
      resolved.set(pane.id, {
        kind: "pane",
        id: pane.id,
        tabIds,
        activeTabId:
          pane.activeTabId !== null && live.has(pane.activeTabId)
            ? pane.activeTabId
            : (tabIds[0] ?? null),
        index,
      });
    });
    const panes = [...resolved.values()];
    if (panes.some((pane) => pane.tabIds.length > 0)) {
      // A shown group's focus is always one of its panes.
      const focused = resolved.get(next.focusedPaneId)!;
      return {
        root: resolveNode(next.root, resolved),
        panes,
        focusedPaneId: focused.id,
        activeTabId: focused.activeTabId,
        groupId: next.root.id,
      };
    }
  }
  const shown =
    next.selectedTabId !== null && live.has(next.selectedTabId)
      ? next.selectedTabId
      : permanentTabId;
  const pane: ResolvedSplitViewPane = {
    kind: "pane",
    id: SPLIT_VIEW_ROOT_PANE_ID,
    tabIds: [shown],
    activeTabId: shown,
    index: 0,
  };
  return {
    root: pane,
    panes: [pane],
    focusedPaneId: SPLIT_VIEW_ROOT_PANE_ID,
    activeTabId: shown,
    groupId: null,
  };
}
