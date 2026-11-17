/**
 * The door the board's per-surface reads and writes go through (comments,
 * history, bodies, the sidebar's signals, project settings), in the legacy
 * channels' shapes (VC-565, VC-889).
 *
 * {@link boardApi} sends each call to the door of the board source
 * (`stores/board-source.ts`) of the project it is for, decided when the call
 * is made: by the project, the ticket's project, or a comment's ticket.
 * Volli Cloud's door in a cloud launch (`cloud-board-api.ts`); in a local
 * launch, the board protocol's facade (`board-protocol.ts`) for a project a
 * remote host serves (VC-711), and `window.api`'s own functions
 * (`stores/local-board-source.ts`) for this Mac's, with the `cloud` flag on
 * as with it off.
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
import {
  boardSourceFor,
  boardSourceForComment,
  boardSourceForTicket,
} from "../stores/board-source";

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

/** Each call to the door its project, ticket or comment names. */
export function routedBoardApi(doors: {
  forProject(projectId: string): BoardApi;
  forTicket(ticketId: string): BoardApi;
  forComment(commentId: string): BoardApi;
}): BoardApi {
  const { forProject, forTicket, forComment } = doors;
  return {
    tickets: {
      events: (input) => forTicket(input.ticketId).tickets.events(input),
      body: (input) => forTicket(input.ticketId).tickets.body(input),
      latestSignals: (input) => forProject(input.projectId).tickets.latestSignals(input),
      statusEntries: (input) => forProject(input.projectId).tickets.statusEntries(input),
    },
    comments: {
      list: (input) => forTicket(input.ticketId).comments.list(input),
      create: (input) => forTicket(input.ticketId).comments.create(input),
      update: (input) => forComment(input.commentId).comments.update(input),
      remove: (input) => forComment(input.commentId).comments.remove(input),
    },
    projects: {
      update: (input) => forProject(input.id).projects.update(input),
      setSkillModes: (input) => forProject(input.id).projects.setSkillModes(input),
      setSessionDefaults: (input) => forProject(input.id).projects.setSessionDefaults(input),
      checkFolder: (projectId) => forProject(projectId).projects.checkFolder(projectId),
    },
  };
}

/** The board surfaces' door, routed by each call's board source (module comment). */
export function boardApi(): BoardApi {
  return routedBoardApi({
    forProject: (projectId) => boardSourceFor(projectId).api,
    forTicket: (ticketId) => boardSourceForTicket(ticketId).api,
    forComment: (commentId) => boardSourceForComment(commentId).api,
  });
}
