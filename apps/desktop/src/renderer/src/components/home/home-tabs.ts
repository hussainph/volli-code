/**
 * Which Home tab is in front, and what the record owes a tab that names nothing
 * on screen.
 *
 * Home is the ticket workspace's own grammar one level up: a permanent first
 * tab that cannot be closed (the Board, exactly as a ticket's Body tab), with
 * the project's Sessions, Project Files, and Browser Tabs beside it. Two
 * surfaces need the same answer and cannot read it the same way —
 * `home-surface.tsx` renders off it,
 * `sessions-layer.tsx` gates its panes on it — so the decision lives here once,
 * pure, and both callers hand it their store reads.
 *
 * ONE FUNCTION FOR TWO QUESTIONS, deliberately. "Which tab is in front" and
 * "is the recorded tab merely not hydrated yet" are the same decision seen from
 * two sides: the answer to the first is a fallback precisely when the second is
 * unresolved, and a caller that asked them separately could write the fallback
 * back over the record the restore was about to use — silently dropping the
 * Session the person left in front. {@link HomeTabResolution} states both, and
 * `restore` is also the caller's write-back permit.
 *
 * A relaunch puts back the WHOLE strip, not just the tab in front (VC-105).
 * `homeTabOrder` is that record — the VC-189 arrangement, kept equal to the
 * strip as drawn by {@link homeTabOrderReceipt} — so a restore is the same
 * adopt/wait/fallback decision looped over every id it names.
 */
import type { TabOrder } from "@volli/shared";

import { resolveChatRelaunch } from "@renderer/components/ticket/ticket-chat-tab";

/**
 * The permanent first tab. A bare word rather than a prefixed id because it is
 * also the value `homeActiveTab` defaults to and persists, and the id spaces it
 * shares the strip with are a UUID (terminal) or `chat:<uuid>` — neither can
 * collide with it.
 */
export const HOME_BOARD_TAB_ID = "board";

/**
 * Browser Tabs share the strip's one string identity with terminals, chats, and
 * files. Prefixing main's opaque id keeps those independent id spaces from
 * colliding without teaching the BrowserTabHost about renderer tab grammar.
 */
const BROWSER_TAB_PREFIX = "browser:";

export function browserTabId(tabId: string): string {
  return `${BROWSER_TAB_PREFIX}${tabId}`;
}

/** Main's opaque Browser Tab id, or null when another workspace-tab kind was named. */
export function parseBrowserTabId(tabId: string): string | null {
  if (!tabId.startsWith(BROWSER_TAB_PREFIX)) return null;
  const opaqueId = tabId.slice(BROWSER_TAB_PREFIX.length);
  return opaqueId.length > 0 ? opaqueId : null;
}

/** Whether `tabId` names the permanent Board tab. */
export function isHomeBoardTab(tabId: string): boolean {
  return tabId === HOME_BOARD_TAB_ID;
}

/**
 * Record one Home-tab visit in least-to-most-recent order.
 *
 * A tab has one place in the history: revisiting it moves it to the end, while
 * reporting the tab already in front is a no-op by identity. The history is
 * session-local navigation memory, not durable workspace state.
 */
export function visitHomeTab(history: readonly string[], tabId: string): readonly string[] {
  if (history.at(-1) === tabId) return history;
  return [...history.filter((candidate) => candidate !== tabId), tabId];
}

/** The active tab and pruned MRU history after an active Home tab closes. */
export interface HomeTabCloseResolution {
  active: string;
  history: readonly string[];
}

/**
 * Return to the most recently visited Home tab that still exists.
 *
 * The closed tab and stale history entries are removed first. Board is the
 * permanent fallback when this app run has no surviving prior visit — for
 * example, closing a restored File tab immediately after relaunch.
 */
export function closeHomeTabHistory(input: {
  history: readonly string[];
  closedTabId: string;
  openTabIds: readonly string[];
}): HomeTabCloseResolution {
  const open = new Set(input.openTabIds);
  let history: readonly string[] = [];
  for (const tabId of input.history) {
    if (tabId !== input.closedTabId && open.has(tabId)) history = visitHomeTab(history, tabId);
  }
  const active = history.at(-1) ?? HOME_BOARD_TAB_ID;
  return {
    active,
    history: history.length === 0 ? [HOME_BOARD_TAB_ID] : history,
  };
}

/**
 * What the caller owes the workspace record after rendering {@link
 * HomeTabResolution.active}.
 *
 *  - `settled` — nothing is left to restore, and the record is either right or
 *    stale-for-good; write back what was derived. This is also how a reset
 *    happens: there is no separate reset kind, because "record the fallback" IS
 *    the reset. It is also the caller's cue that this project's strip has been
 *    restored for the run.
 *  - `pending` — the project's durable Session listing has not answered yet, so
 *    nothing is known about the Sessions the record names. Write NOTHING and
 *    adopt nothing: a write here is the bug where "not hydrated yet" is
 *    mistaken for "gone".
 *  - `adopt` — these recorded Sessions are real and have no tab. Put them back,
 *    in this order, and still write nothing: the strip is about to change under
 *    the derivation, and the next render — which finds them among `tabIds` —
 *    is the one that settles.
 */
export type HomeTabRestore =
  | { kind: "settled" }
  | { kind: "pending" }
  | { kind: "adopt"; sessionIds: readonly string[] };

const SETTLED: HomeTabRestore = { kind: "settled" };
const PENDING: HomeTabRestore = { kind: "pending" };

export interface HomeTabResolution {
  /** The tab to render. Always legal — {@link HOME_BOARD_TAB_ID} at worst. */
  active: string;
  restore: HomeTabRestore;
}

export interface HomeTabsInput {
  /** The project's open Session tabs, in strip order. The Board is not among them. */
  tabIds: readonly string[];
  /** `homeActiveTab` off the workspace record. */
  recorded: string;
  /**
   * The strip a relaunch puts back: `homeTabOrder` as this run first read it
   * for the project. Only its chat Session ids can come back — a terminal's
   * PTY died with the app, and every other kind restores itself.
   */
  recordedOrder: TabOrder;
  /** The terminal container's own active session id, or null. */
  containerActive: string | null;
  /**
   * The project's durable TICKETLESS chat Session ids, or `undefined` while
   * that listing has never been read (`stores/project-sessions.ts`).
   */
  durableChatIds: readonly string[] | undefined;
  /**
   * Whether main's live Browser Tab registry has answered for this project.
   * Unlike a terminal, a Browser Tab survives renderer remounts, so a recorded
   * browser id cannot be called stale while that registry is still in flight.
   */
  browserTabsHydrated: boolean;
  /**
   * Whether this project's strip has already been resolved once in this app
   * run. Restoration is a boot-time act: after it, a recorded id that names
   * nothing is a tab that CLOSED, and adopting it back would reopen the tab the
   * user just shut.
   */
  hydrated: boolean;
}

/**
 * The tab in front, decided at render rather than stored.
 *
 * The recorded id wins while it still names a tab — it is what the sidebar,
 * ⌘K and every start path write to put a Session in front, and what a project
 * switch comes back to. Failing that, the terminal container's own active
 * session, so closing the chat that was covering a terminal puts that terminal
 * back rather than jumping to the head of the strip. Failing that, the head of
 * the strip. Failing that, the Board — which is why the Board can be the
 * default without ever being a special case in the fallback chain.
 *
 * Deriving beats storing because both maps behind it are resident: a tab that
 * closes simply stops being named, and the write-back that follows records what
 * was derived instead of repairing what was stored.
 *
 * The one thing that is NOT resident is a chat Session, which outlives the app.
 * So until the strip has been restored once this run, every chat id the record
 * names — the tab in front and the whole `recordedOrder` beside it — is put to
 * {@link resolveChatRelaunch}, the same adopt/wait/fallback discipline
 * `ticket-detail.tsx` uses for a ticket's own persisted tab. A persisted
 * TERMINAL id needs no such patience: a PTY dies with the app, so it is stale
 * by definition and `resolveChatRelaunch` says so without asking.
 *
 * During that restore a recorded tab that names nothing falls back to the
 * Board, not down the chain above: the strip is still coming back, so its head
 * is an accident of which tabs have arrived, and the Board is the one tab a
 * relaunch can promise.
 */
export function resolveHomeTabs(input: HomeTabsInput): HomeTabResolution {
  const { tabIds, recorded, containerActive, browserTabsHydrated, hydrated } = input;
  const restore = (): HomeTabRestore => (hydrated ? SETTLED : restoreHomeStrip(input));
  if (isHomeBoardTab(recorded) || tabIds.includes(recorded)) {
    return { active: recorded, restore: restore() };
  }

  const active = !hydrated
    ? HOME_BOARD_TAB_ID
    : containerActive !== null && tabIds.includes(containerActive)
      ? containerActive
      : (tabIds[0] ?? HOME_BOARD_TAB_ID);
  // Ahead of the strip, too: until main's registry answers, a Session adopted
  // now would sit on screen with the restore unfinished, and closing it in that
  // window would read as a Session still waiting to come back.
  if (parseBrowserTabId(recorded) !== null && !browserTabsHydrated) {
    return { active, restore: PENDING };
  }
  return { active, restore: restore() };
}

/**
 * The relaunch itself: every recorded id with no tab, put to
 * {@link resolveChatRelaunch} in strip order.
 *
 * One unanswered listing holds the whole strip — the listing is one read, so
 * no Session in it is known before every Session in it is. A Session the
 * listing does not know (archived, removed, or never a ticketless chat) is
 * simply not adopted: it strands no tab and holds up none of its neighbours.
 * The tab in front rides along at the end, so a record written before the
 * strip was (VC-54, active tab only) still brings its one Session back.
 */
function restoreHomeStrip(input: HomeTabsInput): HomeTabRestore {
  const { tabIds, recorded, recordedOrder, durableChatIds } = input;
  const sessionIds: string[] = [];
  for (const tabId of new Set([...recordedOrder, recorded])) {
    if (tabIds.includes(tabId)) continue;
    const relaunch = resolveChatRelaunch(tabId, durableChatIds);
    if (relaunch.kind === "wait") return PENDING;
    if (relaunch.kind === "adopt") sessionIds.push(relaunch.sessionId);
  }
  return sessionIds.length === 0 ? SETTLED : { kind: "adopt", sessionIds };
}

export interface HomeTabOrderReceiptInput {
  /** The strip as drawn, Board first — `arrangeTabs` over the composed tabs. */
  drawn: readonly string[];
  /** Tabs on screen that must never reach the record: an empty Chat Draft's. */
  transient: ReadonlySet<string>;
  /**
   * Whether everything the record names has had its chance to come back: the
   * strip's restore has settled and main's Browser Tab registry has answered.
   */
  restored: boolean;
}

/**
 * The arrangement Home records for the strip it is drawing, or `null` while it
 * may record nothing at all. Recording what the record already says is the
 * store's no-op (`recordHomeTabOrder`), so this never has to compare.
 *
 * This is what makes `homeTabOrder` the strip's whole record rather than a
 * memory of the last drag: an arrangement that named only dragged tabs would
 * forget every Session nobody happened to move, and the relaunch reads its
 * Sessions from here. The receipt is the strip AS DRAWN — `arrangeTabs`'
 * output fed back as its own overlay — so recording it moves no tab. What it
 * changes is only where the next new tab lands: at the end of the strip, which
 * is where `arrangeTabs` puts any tab an overlay does not name yet.
 *
 * This is also the one place the record is pruned, and it is pruned LIVE: a
 * closed tab, a dead terminal, a Session the listing no longer knows all drop
 * out here because they are not drawn. Before the restore has settled nothing
 * is written at all — an id that has not come back yet looks exactly like one
 * that never will, and only one of those may lose its place (`tab-order.ts`).
 */
export function homeTabOrderReceipt(input: HomeTabOrderReceiptInput): TabOrder | null {
  const { drawn, transient, restored } = input;
  if (!restored) return null;
  return drawn.filter((tabId) => !isHomeBoardTab(tabId) && !transient.has(tabId));
}

/**
 * Validate a rehydrated `homeActiveTab`. Persisted JSON a past build wrote can
 * hold anything, and the sanitizer's job here is only shape: whether the id
 * still names a Session is {@link resolveHomeTabs}'s question, asked live and
 * answered against the durable listing rather than guessed at boot.
 */
export function sanitizeHomeActiveTab(raw: unknown): string {
  return typeof raw === "string" && raw.length > 0 ? raw : HOME_BOARD_TAB_ID;
}
