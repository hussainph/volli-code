/**
 * Which right rail ⌥⌘B is talking about — the ticket workspace's, Home's, or
 * neither (VC-55).
 *
 * There are two rails now and one chord, and `railCollapsed` is one PERSISTED
 * preference both honour. That is what makes the gate load-bearing rather than
 * tidy: an ungated chord lets a keystroke on the board flip a preference with
 * nothing on screen to show for it, and the next surface you open arrives with
 * its rail already gone. The gate this replaces made exactly that argument for
 * the ticket rail; Home's rail joins it rather than getting a second one.
 *
 * The chrome facts are the same ones `terminal-focus.ts` and
 * `new-session-shortcut.ts` resolve against, read the same way and for the same
 * reason — a surface is in front when Home says its tab is. It reads the
 * workspace RECORD, not a second derivation of which tab is in front: the
 * record is what `home-surface.tsx` writes back after resolving, so the two
 * cannot drift for longer than the frame that repairs it, and a rail toggle is
 * not worth a second copy of that resolution.
 *
 * Pure and structurally typed like every other shortcut predicate in this
 * renderer, so it unit-tests in the node environment with no DOM.
 */
import { isHomeBoardTab } from "@renderer/components/home/home-tabs";
import type { NavKey } from "@renderer/stores/workspace";

/** The chrome facts the rail chord resolves against, read at press time. */
export interface RailToggleChrome {
  selectedProjectId: string | null;
  /** The selected project's nav page. Ticket detail is a STATE of `home`. */
  nav: NavKey;
  /** Which Home tab is in front (`home-tabs.ts`). */
  homeActiveTab: string;
  /** App-wide Settings is chrome layered OVER the workspace, not a nav page. */
  settingsOpen: boolean;
  /** The selected project's open ticket, or null on the plain board. */
  openTicketId: string | null;
  /**
   * Whether terminal focus holds the canvas — `terminalFocusTarget !== null`.
   *
   * ANY committed target, not one matching the surface in front. Zen mode takes
   * the WHOLE canvas and both rails step aside for it (`home-surface.tsx` gates
   * its strip on exactly this read; `ticket-detail.tsx` drops its rail on the
   * matching one), so while a target is committed there is no rail on screen to
   * talk about on either surface. Reading the narrower "matches this tab"
   * question here would let the chord through during the frame a stale target
   * is still being cleared — and this gate exists precisely to keep a keystroke
   * from writing a persisted preference with nothing to show for it.
   */
  terminalFocusActive: boolean;
}

/** Whose rail is on screen. */
export type RailToggleTarget = "ticket" | "home";

/**
 * The rail ⌥⌘B would collapse, or `null` when there is none on screen.
 *
 * The two rails are two HOME TABS and only one of them can be in front:
 *
 *  • Home's Board tab + an open ticket → the ticket workspace's rail.
 *  • a Home Session tab → Home's own rail.
 *
 * `openTicketId` survives leaving the ticket (stores/workspace.ts) — across
 * Files, Configure, and Home's own Session tabs, which keep the ticket
 * remembered behind them (VC-54 decision 1). So it is true in three places
 * where the ticket is nowhere on screen, and without the tab line a chord
 * pressed on a Home chat would collapse a ticket rail nobody can see.
 *
 * The BOARD alone has no rail, which is why the board arm returns `null` rather
 * than falling through to Home's: Home's rail belongs to a Session, and the
 * board is not one.
 *
 * TERMINAL FOCUS answers for both surfaces at once — see
 * {@link RailToggleChrome.terminalFocusActive}. Home's own terminals may enter
 * it (`terminal-focus.ts`), so this is reachable from a Session tab and not
 * only from a ticket's.
 */
export function railToggleTargetForChrome(chrome: RailToggleChrome): RailToggleTarget | null {
  if (
    chrome.selectedProjectId === null ||
    chrome.settingsOpen ||
    chrome.nav !== "home" ||
    chrome.terminalFocusActive
  ) {
    return null;
  }
  if (isHomeBoardTab(chrome.homeActiveTab)) return chrome.openTicketId === null ? null : "ticket";
  return "home";
}
