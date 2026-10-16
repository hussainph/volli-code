/**
 * Following a window's remote projects (VC-711): the half of
 * `followRemoteProjects` (`./boot`) that holds no store of its own, so main's
 * real-link test drives it against a real relay. Relative imports only.
 */
import { toast } from "sonner";

import { isBoardUnavailable } from "../stores/board-sync";
import {
  hostOfProject,
  isRemoteProject,
  type HostConnectionState,
  type HostLinkView,
} from "../stores/host-connection";
import {
  boardUnavailableOn,
  type RemoteBoardAvailabilityState,
} from "../stores/remote-board-availability";
import { isLinkReady } from "./relay-host-link";

/** What the follower reads of the host-connection store. */
export interface FollowedHostStore {
  getState(): Pick<HostConnectionState, "hosts" | "projects">;
  subscribe(listener: (state: Pick<HostConnectionState, "hosts" | "projects">) => void): () => void;
}

/**
 * Follows every remote project the host-connection store claims (VC-711):
 * opens its board (whose snapshot puts its row in the project list, through
 * `adoptProject`), and when its claim goes (the host was forgotten, the
 * project closed there) closes it and `drop`s its board and its row. Answers
 * the unsubscribe. It follows while `alive` holds (the protocol path it
 * serves is still the running one), and lets go of the store at the first
 * change after.
 *
 * - **An outage is the board's to wait out.** An open that fails on the way
 *   (the link dropped, the host is away) is retried by the board itself, with
 *   backoff, and the project's link state says why. Nothing is said here.
 * - **A host whose board is not this window's is said once, and left.** An
 *   older host that grants no `board.read`, or one that does not know the
 *   Workspace (`isBoardUnavailable`), refuses every open alike, so the board
 *   stops asking: the reason goes to `availability` (in the
 *   host's name, where Settings → Hosts shows it) and to one toast. The board
 *   is opened again only when that changes: the project's link changes (a
 *   reconnect brings a new welcome, and a newer host its grants), the claim
 *   comes back, or the person asks to try again.
 */
export function followRemoteClaims({
  sync,
  store,
  alive,
  availability,
  drop,
}: {
  sync: { open(projectId: string): Promise<void>; close(projectId: string): void };
  store: FollowedHostStore;
  alive: () => boolean;
  availability: Pick<RemoteBoardAvailabilityState, "setUnavailable" | "setRetry">;
  /** Lets go of a project whose claim went: its board and its row. */
  drop: (projectId: string) => void;
}): () => void {
  /** Each followed project, and the link its last open was refused under (`null`: not refused). */
  const followed = new Map<string, { refusedUnder: HostLinkView | null }>();
  let unsubscribe: (() => void) | null = null;

  const open = (projectId: string): void => {
    const entry = followed.get(projectId)!;
    entry.refusedUnder = null;
    availability.setUnavailable(projectId, null);
    void sync.open(projectId).catch((error: unknown) => {
      // Gone since, or an outage the board itself retries.
      if (followed.get(projectId) !== entry || !isBoardUnavailable(error)) return;
      const state = store.getState();
      // Still followed, so still claimed: a claim's loss forgets its entry at once.
      entry.refusedUnder = state.projects[projectId]!.link;
      const reason = boardUnavailableOn(hostOfProject(state, projectId).name);
      availability.setUnavailable(projectId, reason);
      toast.warning(reason, { id: `remote-board-unavailable:${projectId}` });
    });
  };

  const reconcile = (state: ReturnType<FollowedHostStore["getState"]>): void => {
    if (!alive()) {
      unsubscribe?.();
      return;
    }
    const claimed = new Set(Object.keys(state.projects).filter((id) => isRemoteProject(state, id)));
    for (const projectId of claimed) {
      const entry = followed.get(projectId);
      if (entry === undefined) {
        followed.set(projectId, { refusedUnder: null });
        open(projectId);
        continue;
      }
      // Refused: asked again only once the link it was refused under changed.
      const link = state.projects[projectId]!.link;
      if (entry.refusedUnder !== null && link !== entry.refusedUnder && isLinkReady(link)) {
        open(projectId);
      }
    }
    for (const projectId of Array.from(followed.keys())) {
      if (claimed.has(projectId)) continue;
      followed.delete(projectId);
      availability.setUnavailable(projectId, null);
      sync.close(projectId);
      drop(projectId);
    }
  };
  reconcile(store.getState());
  // The person's "Try again": only a project whose board was refused.
  availability.setRetry((projectId) => {
    if (alive() && followed.get(projectId)?.refusedUnder != null) open(projectId);
  });
  const stop = store.subscribe(reconcile);
  unsubscribe = () => {
    stop();
    availability.setRetry(null);
  };
  return unsubscribe;
}
