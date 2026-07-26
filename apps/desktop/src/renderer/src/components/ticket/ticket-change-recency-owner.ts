import {
  errorMessage,
  type FileChangedEvent,
  type FilePathInput,
  type Result,
} from "@volli/shared";

import {
  EMPTY_CHANGE_RECENCY_STATE,
  emptyPathRecord,
  reduceChangeRecency,
  withoutPathEntry,
  withPathEntry,
  type ChangeRecencyState,
} from "./ticket-change-recency";
import {
  matchesFileChangeIdentity,
  type ResolvedFileChangeIdentity,
} from "@renderer/editor/file-change-identity";

export interface TicketRecencyOwnerState {
  recency: ChangeRecencyState;
  inspected: Readonly<Record<string, ResolvedFileChangeIdentity>>;
  localSaveEchoes: Readonly<Record<string, string>>;
}

export const EMPTY_TICKET_RECENCY_OWNER_STATE: TicketRecencyOwnerState = {
  recency: EMPTY_CHANGE_RECENCY_STATE,
  // Null-prototype, like every other path-keyed record here — see
  // `emptyPathRecord`.
  inspected: Object.freeze(emptyPathRecord<ResolvedFileChangeIdentity>()),
  localSaveEchoes: Object.freeze(emptyPathRecord<string>()),
};

export type TicketRecencyOwnerEvent =
  | { type: "inspect"; identity: ResolvedFileChangeIdentity; revision: number }
  | { type: "local-save"; identity: ResolvedFileChangeIdentity; revision: number }
  | { type: "file-changed"; event: FileChangedEvent };

function ticketRecencyWatchKey(input: FilePathInput): string {
  return `${input.projectId}\u0000${input.ticketId ?? ""}\u0000${input.relPath}`;
}

/** The ticket-lifetime watch bookkeeping behind the Changes navigator's badges. */
export interface TicketRecencyWatchOwner {
  /** Arms (once) the ticket-lifetime watch for a path the user actually looked at. */
  watch(input: FilePathInput): Promise<Result>;
  /**
   * Feeds every `volli:file-changed` event back to the owner so it can notice
   * main tearing a watch down. Main owes a watch-less subscription one final
   * event (see `WatchManagerBase.finishReArm`), and when the watched directory
   * is gone that event carries `revision: null` — the only teardown signal the
   * renderer gets. Without this the `held` latch below would short-circuit every
   * later `watch()` with `{ ok: true }` and recency would die silently.
   */
  noteChangedEvent(event: FileChangedEvent): void;
  dispose(): void;
}

export function createTicketRecencyWatchOwner(
  api: {
    watch(input: FilePathInput): Promise<Result>;
    unwatch(input: FilePathInput): Promise<Result>;
  },
  options: {
    /** Called when a torn-down watch could not be re-armed — the caller toasts. */
    onWatchLost?(input: FilePathInput): void;
  } = {},
): TicketRecencyWatchOwner {
  const held = new Map<string, FilePathInput>();
  const pending = new Map<string, Promise<Result>>();
  let disposed = false;

  /** One in-flight arm per key; a rejected `api.watch` resolves as a typed failure. */
  function arm(key: string, input: FilePathInput): Promise<Result> {
    const existing = pending.get(key);
    if (existing !== undefined) return existing;
    const started = api.watch(input).then(
      (result) => {
        if (result.ok) {
          if (disposed) void api.unwatch(input);
          else held.set(key, input);
        }
        return result;
      },
      // A rejected IPC call must reach the caller as a failure it can toast,
      // never as an unhandled rejection that leaves the tab believing the
      // badge is armed.
      (error: unknown): Result => ({ ok: false, error: errorMessage(error) }),
    );
    pending.set(key, started);
    void started.finally(() => {
      if (pending.get(key) === started) pending.delete(key);
    });
    return started;
  }

  return {
    watch(input) {
      const key = ticketRecencyWatchKey(input);
      if (held.has(key)) return Promise.resolve({ ok: true });
      return arm(key, input);
    },
    noteChangedEvent(event) {
      if (disposed || event.revision !== null) return;
      // Held inputs always carry this ticket's id, while a `main`-resolved event
      // reports `ticketId: null` — so match on the (project, path) pair rather
      // than the composite watch key.
      const lost = [...held].filter(
        ([, input]) => input.projectId === event.projectId && input.relPath === event.relPath,
      );
      for (const [key, input] of lost) {
        held.delete(key);
        // Release our hold before re-arming so main's refCount stays balanced:
        // if it already tore the subscription down this is a documented no-op,
        // and if it did not (a plain deletion under a live watcher) we hand the
        // hold straight back. An unwatch failure is not separately actionable —
        // the re-arm result below is what the user is told about.
        void api
          .unwatch(input)
          .catch(() => undefined)
          .then(() => arm(key, input))
          .then((result) => {
            if (!result.ok) options.onWatchLost?.(input);
          });
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const input of held.values()) void api.unwatch(input);
      held.clear();
    },
  };
}

/** Ticket-altitude ownership for deliberate inspection and later file events. */
export function reduceTicketRecencyOwner(
  state: TicketRecencyOwnerState,
  event: TicketRecencyOwnerEvent,
): TicketRecencyOwnerState {
  if (event.type === "inspect") {
    return {
      inspected: withPathEntry(state.inspected, event.identity.relPath, event.identity),
      localSaveEchoes: withoutPathEntry(state.localSaveEchoes, event.identity.relPath),
      recency: reduceChangeRecency(state.recency, {
        type: "inspect",
        path: event.identity.relPath,
        revision: String(event.revision),
      }),
    };
  }

  if (event.type === "local-save") {
    const inspected = state.inspected[event.identity.relPath];
    if (
      inspected === undefined ||
      !matchesFileChangeIdentity({ ...event.identity, revision: event.revision }, inspected)
    ) {
      return state;
    }
    const revision = String(event.revision);
    return {
      ...state,
      localSaveEchoes: withPathEntry(state.localSaveEchoes, event.identity.relPath, revision),
      recency: reduceChangeRecency(state.recency, {
        type: "local-save-echo",
        path: event.identity.relPath,
        revision,
      }),
    };
  }

  const identity = state.inspected[event.event.relPath];
  if (
    identity === undefined ||
    event.event.revision === null ||
    !matchesFileChangeIdentity(event.event, identity)
  ) {
    return state;
  }
  const revision = String(event.event.revision);
  if (state.localSaveEchoes[event.event.relPath] === revision) {
    return {
      ...state,
      localSaveEchoes: withoutPathEntry(state.localSaveEchoes, event.event.relPath),
      recency: reduceChangeRecency(state.recency, {
        type: "local-save-echo",
        path: event.event.relPath,
        revision,
      }),
    };
  }
  const recency = reduceChangeRecency(state.recency, {
    type: "external-revision",
    path: event.event.relPath,
    revision,
  });
  return recency === state.recency ? state : { ...state, recency };
}
