/**
 * Live work inside a directory — the one question every destructive worktree
 * path asks before it touches anything.
 *
 * It lives here, rather than beside the IPC handler that first needed it,
 * because VC-284 found the orphan sweep removing checkouts WITHOUT asking it
 * while the manual Delete beside it always did. Two copies of "is anything
 * running in there?" is two answers; one module is the only way the automatic
 * path and the manual one can be held to the same protection.
 */
import { isInside } from "./paths";

/**
 * A directory something is doing work in right now, and which surface is doing
 * it. The surface travels with the directory because the refusal has to name an
 * action the user can actually reach, and stopping an agent and closing a
 * terminal are different doors.
 */
export interface BusyWorktreeSite {
  directory: string;
  surface: "terminal" | "agent";
}

/** Every directory a local execution surface is working in that could block destroying `target`. */
export type BusyWorktreeSites = (target: string) => Promise<readonly BusyWorktreeSite[]>;

/**
 * The busy site sitting at or under `target`, or `null`. `isInside`
 * canonicalizes both operands, so a terminal running inside a worktree — or an
 * agent mid-turn in it — blocks a remove/orphan-delete/cleanup that would pull
 * the directory out from under it.
 *
 * The supplier is already asked about one target, so this is a second filter
 * over an answer that should already be scoped: it is what makes the guard
 * independent of how carefully the supplier reads `target`, and terminals in
 * particular are reported unscoped because a live PTY holds its cwd whatever it
 * is doing.
 */
export function busySiteWithin(
  target: string,
  sites: readonly BusyWorktreeSite[],
): BusyWorktreeSite | null {
  return sites.find((site) => isInside(target, site.directory)) ?? null;
}

/**
 * Why a destructive worktree action was refused: one line, and one recovery the
 * user can reach from where they are. It never names the act it refused — every
 * caller already frames that ("Couldn't remove worktree: …") — so this says only
 * what is in the way and what clears it.
 *
 * It used to say "Close the live sessions running in this worktree", which named
 * an action that does not exist for a chat: there is no close, and the Session
 * it was talking about was routinely one nobody had ever sent a message to. A
 * chat is stopped (the composer's Stop, or Esc); a terminal is closed.
 */
export function busyRefusal(site: BusyWorktreeSite): string {
  return site.surface === "agent"
    ? "An agent is still running in this worktree. Stop it first."
    : "A terminal is still running in this worktree. Close it first.";
}
