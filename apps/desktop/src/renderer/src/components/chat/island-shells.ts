/**
 * The Activity Island's background shell feed (VC-270): what the island's
 * `shells` cluster reads, as a React hook over `./island-shells-model.ts`.
 *
 * Its own module, built before the island's mount (VC-268) exists, so the
 * mount plugs it in with one import and one spread — the feed and BOTH its
 * verbs, so the mount never has to rediscover how a shell is killed or where
 * its output opens:
 *
 *     const { shells, flash, openShell, killShell } = useIslandShells(sessionId, {
 *       openOutput: (shellId) => openShellOutputTab(shellId),
 *     });
 *     model = { ...model, shells, flash: flash ?? model.flash };
 *     actions = { ...actions, openShell, killShell };
 *
 * `openOutput` is the mount's to supply because WHERE a tail opens is the
 * mount's decision, not the feed's; what it opens is
 * `components/shell/shell-output-view.tsx`. Omit it and `openShell` is inert
 * — a surface with nowhere to put a tail cannot open one — while `killShell`
 * still works, because killing needs no destination.
 *
 * Everything here is a PROJECTION of `stores/background-shells.ts`, which is
 * itself a projection of main's BackgroundShellHost through one push. The
 * island never learns a pid, a cwd or a byte of output; it gets
 * {@link IslandShell}'s four fields and a flash per transition. The flash is
 * derived from TRANSITIONS between two projections, never from the store's
 * events: the island's "now" channel says what changed, and a re-projection
 * that changed nothing must not re-announce.
 */

import * as React from "react";

import type { ActivityIslandActions, IslandFlash, IslandShell } from "@volli/session-presentation";

import { toastError } from "@renderer/lib/toast";
import { useBackgroundShellsStore, type ShellsApi } from "@renderer/stores/background-shells";
import {
  islandShellActions,
  projectIslandShells,
  shellTransitionFlashes,
} from "./island-shells-model";

export {
  islandShellActions,
  projectIslandShells,
  shellTransitionFlashes,
} from "./island-shells-model";

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
/** What the mount supplies: where a tail opens, and the doors under test. */
export interface IslandShellsDeps {
  /** Where `openShell` puts a shell's tail. Omitted means it opens nowhere. */
  openOutput?: (shellId: string) => void;
  /** The preload bridge; production is `window.api.shells`. */
  api?: Pick<ShellsApi, "kill">;
  /** How a failed kill is reported; production toasts it. */
  onError?: (message: string) => void;
}

export function useIslandShells(
  sessionId: string,
  deps: IslandShellsDeps = {},
): {
  shells: readonly IslandShell[];
  flash: IslandFlash | null;
} & Pick<ActivityIslandActions, "openShell" | "killShell"> {
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

  // The two verbs the island's card fires, wired to the bridge here so the
  // mount spreads them rather than rebuilding them. The bridge is read at
  // call time, not at render, so a surface that never kills never touches it.
  const { openOutput, api, onError } = deps;
  const { openShell, killShell } = React.useMemo(
    () =>
      islandShellActions({
        api: { kill: (input) => (api ?? window.api.shells).kill(input) },
        openOutput: (shellId) => openOutput?.(shellId),
        onError: onError ?? ((message) => toastError(`Could not kill the shell: ${message}`)),
      }),
    [api, onError, openOutput],
  );

  return { shells: stable, flash, openShell, killShell };
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
