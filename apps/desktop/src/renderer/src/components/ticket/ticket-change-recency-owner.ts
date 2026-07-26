import type { FileChangedEvent } from "@volli/shared";

import {
  EMPTY_CHANGE_RECENCY_STATE,
  reduceChangeRecency,
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
  inspected: Object.freeze({}) as Readonly<Record<string, ResolvedFileChangeIdentity>>,
  localSaveEchoes: Object.freeze({}) as Readonly<Record<string, string>>,
};

export type TicketRecencyOwnerEvent =
  | { type: "inspect"; identity: ResolvedFileChangeIdentity; revision: number }
  | { type: "local-save"; identity: ResolvedFileChangeIdentity; revision: number }
  | { type: "file-changed"; event: FileChangedEvent };

type TicketInspectionRead = (input: {
  projectId: string;
  ticketId: string;
  relPath: string;
}) => Promise<
  | { ok: true; source: ResolvedFileChangeIdentity["source"]; mtime: number }
  | { ok: false; error?: string }
>;

/** Resolve the exact source identity and file revision for a deliberate open. */
export async function readTicketInspection(
  read: TicketInspectionRead,
  input: { projectId: string; ticketId: string; relPath: string },
): Promise<Extract<TicketRecencyOwnerEvent, { type: "inspect" }> | null> {
  const result = await read(input);
  if (!result.ok) return null;
  return {
    type: "inspect",
    identity: {
      projectId: input.projectId,
      ticketId: result.source === "worktree" ? input.ticketId : null,
      relPath: input.relPath,
      source: result.source,
    },
    revision: result.mtime,
  };
}

function withoutPath<T>(
  record: Readonly<Record<string, T>>,
  path: string,
): Readonly<Record<string, T>> {
  if (!(path in record)) return record;
  const next = { ...record };
  delete next[path];
  return next;
}

/** Ticket-altitude ownership for deliberate inspection and later file events. */
export function reduceTicketRecencyOwner(
  state: TicketRecencyOwnerState,
  event: TicketRecencyOwnerEvent,
): TicketRecencyOwnerState {
  if (event.type === "inspect") {
    return {
      inspected: { ...state.inspected, [event.identity.relPath]: event.identity },
      localSaveEchoes: withoutPath(state.localSaveEchoes, event.identity.relPath),
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
      localSaveEchoes: { ...state.localSaveEchoes, [event.identity.relPath]: revision },
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
      localSaveEchoes: withoutPath(state.localSaveEchoes, event.event.relPath),
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
