/**
 * Which door the renderer's board goes through (VC-565).
 *
 * - **`cloud` off: the legacy per-channel IPC, exactly as before.** Nothing
 *   here runs: {@link boardApi} answers with `window.api`'s own functions, the
 *   board store keeps its write-through gateway, and boot hydrates from
 *   `volli:data-bootstrap` and refreshes on `volli:data-changed`.
 * - **`cloud` on: the board router, through a board client.** The board store
 *   paints what {@link BoardSync} holds (the host's confirmed board plus this
 *   window's pending writes, T5), the Workspace's change feed keeps it current,
 *   and every per-surface board read and write (comments, activity, bodies,
 *   project settings, the sidebar's signals) goes through {@link boardApi}'s
 *   protocol facade, each write under a fresh `commandId`.
 *
 * The client is the board router's procedures over either link: the desktop's
 * generic IPC bridge for this Mac's in-process host (`sessionRpcClient()`,
 * which serves the board router beside the Session router, VC-608), or
 * `hostLinkTrpcLink(relayHostLink(id))` for a remote project, over the
 * Workspace link desktop main holds (VC-711, {@link createBoardClient}).
 * Nothing above the client knows which.
 *
 * **Routing is per project (VC-711).** One {@link BoardSync} follows every
 * Workspace this window holds, local and remote alike: it already keys every
 * call, base and pending write by Workspace, so it takes a transport per
 * project ({@link BoardClientResolver}) rather than one engine per host,
 * which would split its one pending layer, `workspaceOf` and the facade's
 * commands across engines for nothing. A project the host-connection store
 * claims for a remote host gets that host's client; every other one, this
 * Mac's. The per-surface facade routes the same way: by the project, the
 * ticket's Workspace, or a comment's ticket.
 */
import { createTRPCClient, type TRPCClient, type TRPCLink } from "@trpc/client";
import { hostLinkTrpcLink } from "@volli/host-protocol/client-link";
import type { BoardRouter } from "@volli/session-rpc";
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
import { isRemoteProject, useHostConnectionStore } from "../stores/host-connection";
import { relayHostLink } from "./relay-host-link";
import { sessionRpcClient } from "./session-rpc-ipc-link";
import {
  BoardSync,
  failureMessage,
  type BoardSyncTransport,
  type BoardSyncView,
} from "../stores/board-sync";

/** A board client: the board router's procedures, whichever link carries them. */
export type BoardClient = Pick<TRPCClient<BoardRouter>, "board">;

/** The desktop window's board client: the generic IPC bridge's client, which serves the board router. */
export function desktopBoardClient(): BoardClient {
  return sessionRpcClient() as unknown as BoardClient;
}

/** A board client over any terminating link: a host link's, in particular. */
export function createBoardClient(link: TRPCLink<BoardRouter>): BoardClient {
  return createTRPCClient<BoardRouter>({ links: [link] });
}

/**
 * Which board client one project's calls go to; `undefined` is a call that
 * names no project this window can place (this Mac's, as it always was).
 */
export type BoardClientResolver = (projectId: string | undefined) => BoardClient;

/**
 * Each project's board client: a remote project's over its Workspace link
 * (one client per project, kept for the protocol path's life; a client holds
 * nothing until it is called), every other project's the local one.
 */
export function remoteAwareBoardClients(
  local: BoardClient,
  options: {
    isRemote?: (projectId: string) => boolean;
    remote?: (projectId: string) => BoardClient;
  } = {},
): BoardClientResolver {
  const isRemote =
    options.isRemote ??
    ((projectId) => isRemoteProject(useHostConnectionStore.getState(), projectId));
  const remote =
    options.remote ??
    ((projectId) => createBoardClient(hostLinkTrpcLink(relayHostLink(projectId))));
  const remotes = new Map<string, BoardClient>();
  return (projectId) => {
    if (projectId === undefined || !isRemote(projectId)) return local;
    let client = remotes.get(projectId);
    if (client === undefined) {
      client = remote(projectId);
      remotes.set(projectId, client);
    }
    return client;
  };
}

/** The sync engine's calls, over one board client. */
export function boardSyncTransport(client: BoardClient): BoardSyncTransport {
  const { board } = client;
  return {
    snapshot: (projectId) => board.snapshot.query({ projectId }) as never,
    roster: (projectId) => board.roster.query({ projectId }) as never,
    changes(projectId, lastEventId, handlers) {
      const subscription = board.changes.subscribe(
        { projectId, lastEventId },
        {
          onData: (frame) => handlers.onBatch(frame.data as never),
          onError: (error) => {
            const reason = (error as { data?: { hostError?: { reason?: unknown } } }).data
              ?.hostError?.reason;
            if (reason === "subscription-resnapshot-required") handlers.onResnapshot();
            else handlers.onError(error);
          },
          onComplete: () => handlers.onError(new Error("The board feed ended")),
        },
      );
      return () => subscription.unsubscribe();
    },
    createTicket: (input) => board.createTicket.mutate(input as never) as never,
    moveTickets: (input) => board.moveTickets.mutate(input) as never,
    setPriority: (input) => board.setPriority.mutate(input) as never,
    updateTicket: (input) => board.updateTicket.mutate(input) as never,
    setLabels: (input) => board.setLabels.mutate(input) as never,
    setLabelColor: (input) => board.setLabelColor.mutate(input) as never,
    archiveTicket: (input) => board.archiveTicket.mutate(input) as never,
    unarchiveTicket: (input) => board.unarchiveTicket.mutate(input) as never,
    deleteTicket: (input) => board.deleteTicket.mutate(input) as never,
    archivedTickets: (projectId) => board.archivedTickets.query({ projectId }) as never,
  };
}

interface ActiveProtocol {
  /** This Mac's board client. */
  readonly client: BoardClient;
  /** Each project's board client. */
  readonly clientFor: BoardClientResolver;
  readonly sync: BoardSync;
  /** Which ticket each comment the facade has seen is on: how an edit finds its host. */
  readonly commentTickets: CommentTickets;
}

let active: ActiveProtocol | null = null;

/** The board's protocol path, when `cloud` is on and it has started; null on the legacy path. */
export function boardProtocol(): ActiveProtocol | null {
  return active;
}

/**
 * Starts the protocol path: builds the client and the sync engine over it.
 * The caller (boot) then opens each Workspace. Tests pass their own client.
 */
export function startBoardProtocol(options: {
  view: BoardSyncView;
  /** This Mac's board client. */
  client?: BoardClient;
  /** Each project's; by default a remote project's over its Workspace link, else {@link client}. */
  clientFor?: BoardClientResolver;
  sync?: Partial<ConstructorParameters<typeof BoardSync>[0]>;
}): ActiveProtocol {
  active?.sync.closeAll();
  const client = options.client ?? desktopBoardClient();
  const clientFor = options.clientFor ?? remoteAwareBoardClients(client);
  const transports = new WeakMap<BoardClient, BoardSyncTransport>();
  const transportOf = (projectId: string): BoardSyncTransport => {
    const routed = clientFor(projectId);
    let transport = transports.get(routed);
    if (transport === undefined) {
      transport = boardSyncTransport(routed);
      transports.set(routed, transport);
    }
    return transport;
  };
  const sync = new BoardSync({
    ...options.sync,
    transport: options.sync?.transport ?? transportOf,
    view: options.view,
  });
  active = { client, clientFor, sync, commentTickets: commentTickets() };
  return active;
}

/** Back to the legacy path (tests; a window that turned the flag off at runtime reloads anyway). */
export function stopBoardProtocol(): void {
  active?.sync.closeAll();
  active = null;
}

// ---- the per-surface facade ------------------------------------------------

/** How many comments' tickets the facade remembers: oldest first out. */
export const COMMENT_TICKETS_MAX = 10_000;

/** Which ticket each comment is on, bounded. */
export interface CommentTickets {
  get(commentId: string): string | undefined;
  note(commentId: string, ticketId: string): void;
}

export function commentTickets(max: number = COMMENT_TICKETS_MAX): CommentTickets {
  const tickets = new Map<string, string>();
  return {
    get: (commentId) => tickets.get(commentId),
    note(commentId, ticketId) {
      tickets.delete(commentId);
      tickets.set(commentId, ticketId);
      if (tickets.size > max) tickets.delete(tickets.keys().next().value!);
    },
  };
}

async function read<Answer>(
  run: () => Promise<Answer>,
): Promise<{ ok: true; answer: Answer } | { ok: false; error: string }> {
  try {
    return { ok: true, answer: await run() };
  } catch (error) {
    return { ok: false, error: failureMessage(error) };
  }
}

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

/** The legacy door: `window.api`'s own functions, untouched. */
function legacyBoardApi(): BoardApi {
  const { tickets, comments, projects } = window.api;
  return {
    tickets: {
      events: (input) => tickets.events(input),
      body: (input) => tickets.body(input),
      latestSignals: (input) => tickets.latestSignals(input),
      statusEntries: (input) => tickets.statusEntries(input),
    },
    comments: {
      list: (input) => comments.list(input),
      create: (input) => comments.create(input),
      update: (input) => comments.update(input),
      remove: (input) => comments.remove(input),
    },
    projects: {
      update: (input) => projects.update(input),
      setSkillModes: (input) => projects.setSkillModes(input),
      setSessionDefaults: (input) => projects.setSessionDefaults(input),
      checkFolder: (projectId) => projects.checkFolder(projectId),
    },
  };
}

/** The answer of a write proved by the feed rather than its reply. */
function receiptOf(commandId: string) {
  return {
    receipt: { commandId, status: "completed" as const, replayed: true },
    throughCursor: "",
  };
}

/**
 * The protocol door: the same calls through the board client. Every write
 * is one of the sync engine's commands (`BoardSync.command`), so it follows
 * the board's rules: an unknown outcome is sent again under its id for as
 * long as it takes, the first proof (a reply, or the feed's row naming it)
 * settles it, and only a refusal fails it.
 */
export function protocolBoardApi(
  clientFor: BoardClientResolver,
  sync: BoardSync,
  comments: CommentTickets = commentTickets(),
): BoardApi {
  const forProject = (projectId: string) => clientFor(projectId).board;
  const forTicket = (ticketId: string) => clientFor(sync.workspaceOf(ticketId)).board;
  const forComment = (commentId: string) => {
    const ticketId = comments.get(commentId);
    return clientFor(ticketId === undefined ? undefined : sync.workspaceOf(ticketId)).board;
  };
  const noted = <Row extends { id: string; ticketId: string }>(row: Row): Row => {
    comments.note(row.id, row.ticketId);
    return row;
  };
  return {
    tickets: {
      events: async ({ ticketId }) => {
        const result = await read(() => forTicket(ticketId).ticketEvents.query({ ticketId }));
        return result.ok ? { ok: true, events: result.answer as never } : result;
      },
      body: async ({ ticketId }) => {
        const result = await read(() => forTicket(ticketId).ticketBody.query({ ticketId }));
        return result.ok ? { ok: true, body: result.answer.body } : result;
      },
      latestSignals: async ({ projectId }) => {
        const result = await read(() => forProject(projectId).latestSignals.query({ projectId }));
        return result.ok ? { ok: true, signals: result.answer } : result;
      },
      statusEntries: async ({ projectId }) => {
        const result = await read(() => forProject(projectId).statusEntries.query({ projectId }));
        return result.ok ? { ok: true, entries: result.answer } : result;
      },
    },
    comments: {
      list: async ({ ticketId }) => {
        const result = await read(() => forTicket(ticketId).comments.query({ ticketId }));
        return result.ok ? { ok: true, comments: result.answer.map(noted) } : result;
      },
      create: async (input) => {
        const result = await sync.command({
          verb: "add comment",
          send: (commandId) =>
            forTicket(input.ticketId).createComment.mutate({ commandId, ...input }),
          fromFeed: (row, commandId) => ({ ...receiptOf(commandId), comment: row as never }),
        });
        return result.ok ? { ok: true, comment: noted(result.answer.comment) } : result;
      },
      update: async (input) => {
        const result = await sync.command({
          verb: "edit comment",
          send: (commandId) =>
            forComment(input.commentId).updateComment.mutate({ commandId, ...input }),
          fromFeed: (row, commandId) => ({ ...receiptOf(commandId), comment: row as never }),
        });
        return result.ok ? { ok: true, comment: result.answer.comment } : result;
      },
      remove: async (input) => {
        // A retried removal that finds its comment gone was the removal itself.
        const result = await sync.command({
          verb: "delete comment",
          send: (commandId) =>
            forComment(input.commentId).removeComment.mutate({ commandId, ...input }),
          fromFeed: (_row, commandId) => receiptOf(commandId),
          goneMeansDone: true,
        });
        return result.ok ? { ok: true } : result;
      },
    },
    projects: {
      update: async ({ id, baseBranch, setupCommand }) => {
        const result = await sync.command({
          verb: "update project",
          send: (commandId) =>
            forProject(id).updateProject.mutate({
              commandId,
              projectId: id,
              baseBranch,
              ...(setupCommand === undefined ? {} : { setupCommand }),
            }),
          fromFeed: (row, commandId) => ({ ...receiptOf(commandId), project: row as never }),
        });
        return result.ok ? { ok: true, project: result.answer.project as never } : result;
      },
      setSkillModes: async ({ id, modes }) => {
        const result = await sync.command({
          verb: "update skills",
          send: (commandId) =>
            forProject(id).setSkillModes.mutate({
              commandId,
              projectId: id,
              modes: modes as never,
            }),
          fromFeed: (row, commandId) => ({ ...receiptOf(commandId), project: row as never }),
        });
        return result.ok ? { ok: true, project: result.answer.project as never } : result;
      },
      setSessionDefaults: async ({ id, model }) => {
        const result = await sync.command({
          verb: "update session defaults",
          send: (commandId) =>
            forProject(id).setSessionDefaults.mutate({ commandId, projectId: id, model }),
          fromFeed: (row, commandId) => ({ ...receiptOf(commandId), project: row as never }),
        });
        return result.ok ? { ok: true, project: result.answer.project as never } : result;
      },
      checkFolder: async (projectId) => {
        const result = await read(() => forProject(projectId).projectFolder.query({ projectId }));
        return result.ok ? { ok: true, ...result.answer } : result;
      },
    },
  };
}

/** The board surfaces' door: the protocol facade with `cloud` on, `window.api` otherwise. */
export function boardApi(): BoardApi {
  return active === null
    ? legacyBoardApi()
    : protocolBoardApi(active.clientFor, active.sync, active.commentTickets);
}
