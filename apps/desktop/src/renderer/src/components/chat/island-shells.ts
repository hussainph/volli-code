/**
 * The Activity Island's background shell feed (VC-270): what the island's
 * `shells` cluster reads, and the two verbs its card fires.
 *
 * Its own module, built before the island's mount (VC-268) exists, so the
 * mount plugs it in with one import and one spread:
 *
 *     const { shells, flash } = useIslandShells(sessionId);
 *     model = { ...model, shells, flash: flash ?? model.flash };
 *
 * Everything here is a PROJECTION of `stores/background-shells.ts`, which is
 * itself a projection of main's BackgroundShellHost through one push. The
 * island never learns a pid, a cwd or a byte of output; it gets
 * {@link IslandShell}'s four fields and a flash per transition.
 *
 * Two pure functions carry the rules so the gate can reach them —
 * {@link projectIslandShells} and {@link shellTransitionFlashes} — and the
 * hook is the thin React seam over them. The flash is derived from
 * TRANSITIONS between two projections, never from the store's events: the
 * island's "now" channel says what changed, and a re-projection that changed
 * nothing must not re-announce.
 */

import * as React from "react";

import { errorMessage } from "@volli/shared";
import type { ActivityIslandActions, IslandFlash, IslandShell } from "@volli/session-presentation";

import type { BackgroundShellState } from "../../../../ipc/contract";
import { useBackgroundShellsStore, type ShellsApi } from "@renderer/stores/background-shells";

/** The name a shell row carries: the command's first line, the title if that is blank, the id as a last resort. */
function shellName(shell: BackgroundShellState): string {
  const line = shell.command
    .split("\n")
    .find((one) => one.trim().length > 0)
    ?.trim();
  return line ?? shell.title ?? shell.shellId;
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

const NO_SHELLS: readonly IslandShell[] = [];

/**
 * One Session's island shells and the latest transition among them.
 *
 * The projection is memoized on the Session's own slice of the store, so a
 * push about another Session hands back the same array and the island's
 * spring does not restart. The flash is held in state and replaced only by a
 * newer transition; the island's own hold (`useHeldFlash`) decides how long
 * it reads. What is already in the store on mount is state, not news, so the
 * first projection announces nothing.
 */
export function useIslandShells(sessionId: string): {
  shells: readonly IslandShell[];
  flash: IslandFlash | null;
} {
  const byId = useBackgroundShellsStore((state) => state.byId);
  const shells = React.useMemo(() => {
    const projected = projectIslandShells(Object.values(byId), sessionId);
    return projected.length === 0 ? NO_SHELLS : projected;
  }, [byId, sessionId]);
  // Keyed by identity of the projected rows rather than by the store slice:
  // two projections that read the same are the same for the island.
  const stable = useStableShells(shells);
  const previous = React.useRef<readonly IslandShell[] | null>(null);
  const [flash, setFlash] = React.useState<IslandFlash | null>(null);
  React.useEffect(() => {
    if (previous.current !== null) {
      const latest = shellTransitionFlashes(previous.current, stable).at(-1);
      if (latest !== undefined) setFlash(latest);
    }
    previous.current = stable;
  }, [stable]);
  return { shells: stable, flash };
}

/** The previous array when the projection reads the same, so consumers keyed on identity stay put. */
function useStableShells(next: readonly IslandShell[]): readonly IslandShell[] {
  const held = React.useRef(next);
  if (!sameShells(held.current, next)) held.current = next;
  return held.current;
}

function sameShells(a: readonly IslandShell[], b: readonly IslandShell[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((shell, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      shell.id === other.id &&
      shell.command === other.command &&
      shell.state === other.state &&
      shell.code === other.code
    );
  });
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
