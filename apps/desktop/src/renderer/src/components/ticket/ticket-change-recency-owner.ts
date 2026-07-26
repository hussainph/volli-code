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
}

export const EMPTY_TICKET_RECENCY_OWNER_STATE: TicketRecencyOwnerState = {
  recency: EMPTY_CHANGE_RECENCY_STATE,
  inspected: Object.freeze({}) as Readonly<Record<string, ResolvedFileChangeIdentity>>,
};

export type TicketRecencyOwnerEvent =
  | { type: "inspect"; identity: ResolvedFileChangeIdentity; revision: number }
  | { type: "file-changed"; event: FileChangedEvent };

/** Ticket-altitude ownership for deliberate inspection and later file events. */
export function reduceTicketRecencyOwner(
  state: TicketRecencyOwnerState,
  event: TicketRecencyOwnerEvent,
): TicketRecencyOwnerState {
  if (event.type === "inspect") {
    return {
      inspected: { ...state.inspected, [event.identity.relPath]: event.identity },
      recency: reduceChangeRecency(state.recency, {
        type: "inspect",
        path: event.identity.relPath,
        revision: String(event.revision),
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
  const recency = reduceChangeRecency(state.recency, {
    type: "external-revision",
    path: event.event.relPath,
    revision: String(event.event.revision),
  });
  return recency === state.recency ? state : { ...state, recency };
}
