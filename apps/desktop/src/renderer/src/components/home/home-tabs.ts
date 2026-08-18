/**
 * Which Home tab is in front, and what the record owes a tab that names nothing
 * on screen.
 *
 * Home is the ticket workspace's own grammar one level up: a permanent first
 * tab that cannot be closed (the Board, exactly as a ticket's Body tab), with
 * the project's own Sessions opening beside it. Two surfaces need the same
 * answer and cannot read it the same way — `home-surface.tsx` renders off it,
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
 */
import { resolveChatRelaunch } from "@renderer/components/ticket/ticket-chat-tab";

/**
 * The permanent first tab. A bare word rather than a prefixed id because it is
 * also the value `homeActiveTab` defaults to and persists, and the id spaces it
 * shares the strip with are a UUID (terminal) or `chat:<uuid>` — neither can
 * collide with it.
 */
export const HOME_BOARD_TAB_ID = "board";

/** Whether `tabId` names the permanent Board tab. */
export function isHomeBoardTab(tabId: string): boolean {
  return tabId === HOME_BOARD_TAB_ID;
}

/**
 * What the caller owes the workspace record after rendering {@link
 * HomeTabResolution.active}.
 *
 *  - `settled` — the record is either right or stale-for-good; write back what
 *    was derived. This is also how a reset happens: there is no separate reset
 *    kind, because "record the fallback" IS the reset.
 *  - `pending` — the project's durable Session listing has not answered yet, so
 *    nothing is known about the recorded id. Write NOTHING: a write here is the
 *    bug where "not hydrated yet" is mistaken for "gone".
 *  - `adopt` — the recorded Session is real and has no tab. Put it back, and
 *    still write nothing: the record already names it, and the next render will
 *    find it among `tabIds`.
 */
export type HomeTabRestore =
  | { kind: "settled" }
  | { kind: "pending" }
  | { kind: "adopt"; sessionId: string };

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
  /** The terminal container's own active session id, or null. */
  containerActive: string | null;
  /**
   * The project's durable TICKETLESS chat Session ids, or `undefined` while
   * that listing has never been read (`stores/project-sessions.ts`).
   */
  durableChatIds: readonly string[] | undefined;
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
 * So before a stale-looking record is written off, it is put to
 * {@link resolveChatRelaunch} — the same adopt/wait/fallback discipline
 * `ticket-detail.tsx` uses for a ticket's own persisted tab. A persisted
 * TERMINAL id needs no such patience: a PTY dies with the app, so it is stale
 * by definition and `resolveChatRelaunch` says so without asking.
 */
export function resolveHomeTabs(input: HomeTabsInput): HomeTabResolution {
  const { tabIds, recorded, containerActive, durableChatIds, hydrated } = input;
  if (isHomeBoardTab(recorded)) return { active: HOME_BOARD_TAB_ID, restore: { kind: "settled" } };
  if (tabIds.includes(recorded)) return { active: recorded, restore: { kind: "settled" } };

  const active =
    containerActive !== null && tabIds.includes(containerActive)
      ? containerActive
      : (tabIds[0] ?? HOME_BOARD_TAB_ID);
  if (hydrated) return { active, restore: { kind: "settled" } };

  const relaunch = resolveChatRelaunch(recorded, durableChatIds);
  if (relaunch.kind === "wait") return { active, restore: { kind: "pending" } };
  if (relaunch.kind === "adopt") {
    return { active, restore: { kind: "adopt", sessionId: relaunch.sessionId } };
  }
  return { active, restore: { kind: "settled" } };
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
