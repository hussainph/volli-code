/**
 * The door the board's per-surface reads and writes go through (comments,
 * history, bodies, the sidebar's signals, project settings), in the legacy
 * channels' shapes (VC-565, VC-889).
 *
 * {@link boardApi} routes each call by the place of the project it is for
 * (`stores/project-place.ts`), decided when the call is made:
 *
 * - **a cloud launch:** Volli Cloud's (`cloud-board-api.ts`), for every call;
 * - **a local launch:** `window.api`'s own functions for this Mac's projects,
 *   with the `cloud` flag on as with it off; the board protocol's facade
 *   (`board-protocol.ts`) for a project a remote host serves (VC-711), by the
 *   project, the ticket's project, or a comment's ticket.
 */
import type { ModelSelection } from "@volli/shared";

import type {
  ProjectFolderResult,
  ProjectUpdateResult,
  Result,
  TicketBodyResult,
  TicketCommentResult,
  TicketCommentsResult,
  TicketEventsResult,
  TicketLatestSignalsResult,
  TicketStatusEntriesResult,
} from "../../../ipc/contract";
import { launchStore } from "../stores/launch";
import { boardSourceFor } from "../stores/board-source";
import { boardProtocol, protocolBoardApi } from "./board-protocol";
import { cloudBoardApi } from "./cloud-board-api";

/** The board surfaces' reads and writes, in the legacy channels' shapes. */
export interface BoardApi {
  tickets: {
    events(input: { ticketId: string }): Promise<TicketEventsResult>;
    body(input: { ticketId: string }): Promise<TicketBodyResult>;
    latestSignals(input: { projectId: string }): Promise<TicketLatestSignalsResult>;
    statusEntries(input: { projectId: string }): Promise<TicketStatusEntriesResult>;
  };
  comments: {
    list(input: { ticketId: string }): Promise<TicketCommentsResult>;
    create(input: {
      ticketId: string;
      body: string;
      sessionId?: string | null;
    }): Promise<TicketCommentResult>;
    update(input: { commentId: string; body: string }): Promise<TicketCommentResult>;
    remove(input: { commentId: string }): Promise<Result>;
  };
  projects: {
    update(input: {
      id: string;
      baseBranch: string | null;
      setupCommand?: string | null;
    }): Promise<ProjectUpdateResult>;
    setSkillModes(input: {
      id: string;
      modes: Record<string, string>;
    }): Promise<ProjectUpdateResult>;
    setSessionDefaults(input: {
      id: string;
      model: ModelSelection | null;
    }): Promise<ProjectUpdateResult>;
    checkFolder(projectId: string): Promise<ProjectFolderResult>;
  };
}

/**
 * The legacy door: `window.api`'s own functions, untouched, each read when
 * called (a door built for a remote host's call never touches `window.api`).
 */
export function legacyBoardApi(): BoardApi {
  return {
    tickets: {
      events: (input) => window.api.tickets.events(input),
      body: (input) => window.api.tickets.body(input),
      latestSignals: (input) => window.api.tickets.latestSignals(input),
      statusEntries: (input) => window.api.tickets.statusEntries(input),
    },
    comments: {
      list: (input) => window.api.comments.list(input),
      create: (input) => window.api.comments.create(input),
      update: (input) => window.api.comments.update(input),
      remove: (input) => window.api.comments.remove(input),
    },
    projects: {
      update: (input) => window.api.projects.update(input),
      setSkillModes: (input) => window.api.projects.setSkillModes(input),
      setSessionDefaults: (input) => window.api.projects.setSessionDefaults(input),
      checkFolder: (projectId) => window.api.projects.checkFolder(projectId),
    },
  };
}

/**
 * Each call to whichever of two doors its project's place names: `remote`
 * when `isRemote` says the project (a ticket's, a comment's ticket's) is a
 * remote host's, `local` otherwise.
 */
export function routedBoardApi(
  local: BoardApi,
  remote: BoardApi,
  places: {
    projectIsRemote(projectId: string): boolean;
    ticketIsRemote(ticketId: string): boolean;
    commentIsRemote(commentId: string): boolean;
  },
): BoardApi {
  const byProject = (projectId: string) => (places.projectIsRemote(projectId) ? remote : local);
  const byTicket = (ticketId: string) => (places.ticketIsRemote(ticketId) ? remote : local);
  const byComment = (commentId: string) => (places.commentIsRemote(commentId) ? remote : local);
  return {
    tickets: {
      events: (input) => byTicket(input.ticketId).tickets.events(input),
      body: (input) => byTicket(input.ticketId).tickets.body(input),
      latestSignals: (input) => byProject(input.projectId).tickets.latestSignals(input),
      statusEntries: (input) => byProject(input.projectId).tickets.statusEntries(input),
    },
    comments: {
      list: (input) => byTicket(input.ticketId).comments.list(input),
      create: (input) => byTicket(input.ticketId).comments.create(input),
      update: (input) => byComment(input.commentId).comments.update(input),
      remove: (input) => byComment(input.commentId).comments.remove(input),
    },
    projects: {
      update: (input) => byProject(input.id).projects.update(input),
      setSkillModes: (input) => byProject(input.id).projects.setSkillModes(input),
      setSessionDefaults: (input) => byProject(input.id).projects.setSessionDefaults(input),
      checkFolder: (projectId) => byProject(projectId).projects.checkFolder(projectId),
    },
  };
}

/** The board surfaces' door, routed by each call's project (module comment). */
export function boardApi(): BoardApi {
  if (launchStore() === "cloud") return cloudBoardApi();
  const protocol = boardProtocol();
  if (protocol === null) return legacyBoardApi();
  const { sync, commentTickets } = protocol;
  return routedBoardApi(
    legacyBoardApi(),
    protocolBoardApi(protocol.clientFor, sync, commentTickets),
    {
      projectIsRemote: (projectId) => boardSourceFor(projectId) !== null,
      ticketIsRemote: (ticketId) => sync.projectOf(ticketId) !== undefined,
      commentIsRemote: (commentId) => {
        const ticketId = commentTickets.get(commentId);
        return ticketId !== undefined && sync.projectOf(ticketId) !== undefined;
      },
    },
  );
}
