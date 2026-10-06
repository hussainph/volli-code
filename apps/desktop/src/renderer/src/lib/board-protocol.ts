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
 * `hostLinkTrpcLink(link)` for a remote host ({@link createBoardClient}).
 * Nothing above the client knows which.
 */
import { createTRPCClient, type TRPCClient, type TRPCLink } from "@trpc/client";
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
  readonly client: BoardClient;
  readonly sync: BoardSync;
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
  client?: BoardClient;
  sync?: Partial<ConstructorParameters<typeof BoardSync>[0]>;
}): ActiveProtocol {
  active?.sync.closeAll();
  const client = options.client ?? desktopBoardClient();
  const sync = new BoardSync({
    ...options.sync,
    transport: options.sync?.transport ?? boardSyncTransport(client),
    view: options.view,
  });
  active = { client, sync };
  return active;
}

/** Back to the legacy path (tests; a window that turned the flag off at runtime reloads anyway). */
export function stopBoardProtocol(): void {
  active?.sync.closeAll();
  active = null;
}

// ---- the per-surface facade ------------------------------------------------

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
export function protocolBoardApi(client: BoardClient, sync: BoardSync): BoardApi {
  const { board } = client;
  return {
    tickets: {
      events: async ({ ticketId }) => {
        const result = await read(() => board.ticketEvents.query({ ticketId }));
        return result.ok ? { ok: true, events: result.answer as never } : result;
      },
      body: async ({ ticketId }) => {
        const result = await read(() => board.ticketBody.query({ ticketId }));
        return result.ok ? { ok: true, body: result.answer.body } : result;
      },
      latestSignals: async ({ projectId }) => {
        const result = await read(() => board.latestSignals.query({ projectId }));
        return result.ok ? { ok: true, signals: result.answer } : result;
      },
      statusEntries: async ({ projectId }) => {
        const result = await read(() => board.statusEntries.query({ projectId }));
        return result.ok ? { ok: true, entries: result.answer } : result;
      },
    },
    comments: {
      list: async ({ ticketId }) => {
        const result = await read(() => board.comments.query({ ticketId }));
        return result.ok ? { ok: true, comments: result.answer } : result;
      },
      create: async (input) => {
        const result = await sync.command({
          verb: "add comment",
          send: (commandId) => board.createComment.mutate({ commandId, ...input }),
          fromFeed: (row, commandId) => ({ ...receiptOf(commandId), comment: row as never }),
        });
        return result.ok ? { ok: true, comment: result.answer.comment } : result;
      },
      update: async (input) => {
        const result = await sync.command({
          verb: "edit comment",
          send: (commandId) => board.updateComment.mutate({ commandId, ...input }),
          fromFeed: (row, commandId) => ({ ...receiptOf(commandId), comment: row as never }),
        });
        return result.ok ? { ok: true, comment: result.answer.comment } : result;
      },
      remove: async (input) => {
        // A retried removal that finds its comment gone was the removal itself.
        const result = await sync.command({
          verb: "delete comment",
          send: (commandId) => board.removeComment.mutate({ commandId, ...input }),
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
            board.updateProject.mutate({
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
            board.setSkillModes.mutate({ commandId, projectId: id, modes: modes as never }),
          fromFeed: (row, commandId) => ({ ...receiptOf(commandId), project: row as never }),
        });
        return result.ok ? { ok: true, project: result.answer.project as never } : result;
      },
      setSessionDefaults: async ({ id, model }) => {
        const result = await sync.command({
          verb: "update session defaults",
          send: (commandId) => board.setSessionDefaults.mutate({ commandId, projectId: id, model }),
          fromFeed: (row, commandId) => ({ ...receiptOf(commandId), project: row as never }),
        });
        return result.ok ? { ok: true, project: result.answer.project as never } : result;
      },
      checkFolder: async (projectId) => {
        const result = await read(() => board.projectFolder.query({ projectId }));
        return result.ok ? { ok: true, ...result.answer } : result;
      },
    },
  };
}

/** The board surfaces' door: the protocol facade with `cloud` on, `window.api` otherwise. */
export function boardApi(): BoardApi {
  return active === null ? legacyBoardApi() : protocolBoardApi(active.client, active.sync);
}
