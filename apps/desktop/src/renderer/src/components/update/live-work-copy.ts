/**
 * The install dialog's concrete warning (VC-59). This dialog is the ONE
 * prompt on the install path — the native unsaved-drafts and busy-terminal
 * gates stand down behind it — so what it says must carry everything they
 * would have said: counts, not "the app will close".
 *
 * Three surfaces, named separately and never blended, because "live sessions"
 * as a single number would mean something different here than in the confirms
 * this dialog replaces: a busy PTY (a foreground process beyond the shell) and
 * an open structured agent Session (a turn open on a plane that outlives any
 * one PTY) are different things to lose, and an unsaved draft is the only one
 * of the three a restart destroys unrecoverably.
 */

/** How many file names the drafts line spells out before it counts instead — mirrors main's quit confirm. */
const MAX_NAMED_FILES = 4;

export interface LiveWork {
  /** The foreground process of each busy PTY. */
  busyCommands: string[];
  /** Structured agent Sessions with a turn open right now. */
  openAgentSessions: number;
  /** Display names of editor tabs holding unsaved drafts. */
  unsavedDrafts: string[];
}

/** One warning line per surface with anything at stake; empty when a restart destroys nothing. */
export function liveWorkLines(work: LiveWork): string[] {
  const lines: string[] = [];

  if (work.busyCommands.length > 0) {
    const names = Array.from(new Set(work.busyCommands)).join(", ");
    lines.push(
      work.busyCommands.length === 1
        ? `1 terminal is running “${names}”. Restarting ends it.`
        : `${work.busyCommands.length} terminals are running foreground work (${names}). Restarting ends them.`,
    );
  }

  if (work.openAgentSessions > 0) {
    lines.push(
      work.openAgentSessions === 1
        ? "1 agent Session has a turn open. Restarting interrupts it."
        : `${work.openAgentSessions} agent Sessions have turns open. Restarting interrupts them.`,
    );
  }

  if (work.unsavedDrafts.length === 1) {
    lines.push(`“${work.unsavedDrafts[0]}” has unsaved changes. Restarting discards them.`);
  } else if (work.unsavedDrafts.length > 1) {
    const shown = work.unsavedDrafts.slice(0, MAX_NAMED_FILES).join(", ");
    const remaining = work.unsavedDrafts.length - MAX_NAMED_FILES;
    const list = remaining > 0 ? `${shown}, and ${remaining} more` : shown;
    lines.push(
      `${work.unsavedDrafts.length} files have unsaved changes (${list}). Restarting discards them.`,
    );
  }

  return lines;
}
