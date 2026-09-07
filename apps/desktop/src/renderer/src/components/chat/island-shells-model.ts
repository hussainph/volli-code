/**
 * The Activity Island's background shell feed, pure half (VC-270): one
 * Session's shells as the island models them, the flash per transition, and
 * the two verbs its card fires. React-free, so main's in-process smoke can
 * read the same projection the mount will spread in, and so the gate can
 * reach every branch — a start announced twice, or an exit never announced,
 * is invisible in a screenshot. The hook over this lives in
 * `./island-shells.ts`.
 */

import { errorMessage, shellCommandLine } from "@volli/shared";
import type { ActivityIslandActions, IslandFlash, IslandShell } from "@volli/session-presentation";

import type { BackgroundShellState } from "../../../../ipc/contract";
import type { ShellsApi } from "../../stores/background-shells";

/**
 * The name a shell row carries: the command's first line, the title if the
 * command is all blank, the id as a last resort. Left untruncated on purpose
 * — the island's own chain decides how much of it fits.
 */
function shellName(shell: BackgroundShellState): string {
  return shellCommandLine(shell.command) || shell.title || shell.shellId;
}

/** One Session's shells as the island models them, in start order. */
export function projectIslandShells(
  shells: readonly BackgroundShellState[],
  sessionId: string,
): IslandShell[] {
  return shells
    .filter((shell) => shell.sessionId === sessionId)
    .toSorted((a, b) => a.startedAt - b.startedAt)
    .map((shell) => ({
      id: shell.shellId,
      command: shellName(shell),
      state: shell.state,
      code: shell.code,
    }));
}

function exitEvent(shell: IslandShell): string {
  return shell.code === null ? "Killed" : `Exited ${shell.code}`;
}

/**
 * The announcements between two projections: a start for every new id, an
 * exit for every running → exited. A shell that arrives already exited gets
 * both, in order — it did start, and the person should see that it ran. A
 * shell that was forgotten announces nothing: the attachment ended, and the
 * island's cluster leaving says so.
 */
export function shellTransitionFlashes(
  previous: readonly IslandShell[],
  next: readonly IslandShell[],
): IslandFlash[] {
  const before = new Map(previous.map((shell) => [shell.id, shell]));
  const flashes: IslandFlash[] = [];
  for (const shell of next) {
    const was = before.get(shell.id);
    if (was === undefined) {
      flashes.push({ id: `shell:${shell.id}:started`, event: "Started", payload: shell.command });
    }
    if (shell.state === "exited" && (was === undefined || was.state === "running")) {
      flashes.push({
        id: `shell:${shell.id}:exited`,
        event: exitEvent(shell),
        payload: shell.command,
      });
    }
  }
  return flashes;
}

/**
 * The island's two shell verbs, bound to the bridge and to wherever output
 * opens. `openOutput` is injected because the island's mount decides which
 * strip a shell's tail opens in; the verb only names the shell. A kill that
 * fails is reported — a person pressed twice for it, and silence would read
 * as a shell that will not die.
 */
export function islandShellActions(deps: {
  api: Pick<ShellsApi, "kill">;
  openOutput: (shellId: string) => void;
  onError: (message: string) => void;
}): Pick<ActivityIslandActions, "openShell" | "killShell"> {
  return {
    openShell: (id) => deps.openOutput(id),
    killShell: (id) => {
      void deps.api
        .kill({ shellId: id })
        .then((result) => {
          if (!result.ok) deps.onError(result.error);
        })
        .catch((error: unknown) => deps.onError(errorMessage(error)));
    },
  };
}
