/**
 * The wire half of a remote project's Sessions (VC-713): a typed Session
 * router client over one Workspace link, the chat core's transport over it,
 * and the listing reader. Pure builders over the link they are handed: no
 * store, no `window.api`, so desktop main's real-link test drives exactly
 * these. What binds them to the window's stores is `remote-sessions.ts`.
 */
import { createTRPCClient, type TRPCClient } from "@trpc/client";
import { hostLinkTrpcLink, type HostLinkCalls } from "@volli/host-protocol/client-link";
import type { IpcClientRouter } from "@volli/host-protocol/ipc";
import {
  racingFlushScheduler,
  type ChatSessionRpc,
  type ChatSessionTransport,
} from "@volli/session-presentation";
import type { AppRouter, RouterProcedurePaths } from "@volli/session-rpc";
import { errorMessage, parseHarnessId } from "@volli/shared";

import type { SessionsResult } from "../../../ipc/contract";
import type { RemoteSessionStreams } from "./remote-session-streams";

/** One door to a project's Session listing rows. */
export interface SessionListingReader {
  list(input: { projectId: string }): Promise<SessionsResult>;
  listForTicket(input: { ticketId: string }): Promise<SessionsResult>;
}

/**
 * The Session router as a client over a Workspace link sees it: every path,
 * with each procedure's own input and output types, untransformed. The link
 * carries the router's values as JSON both ways, and every router seam proves
 * them JSON-safe (`JsonUnsafeProcedures`), so the untransformed types are the
 * honest ones — exactly how the window's IPC client types the same router
 * (`SessionRpcClient`), which is what lets one chat core take either.
 */
export type RemoteSessionRouter = IpcClientRouter<AppRouter, RouterProcedurePaths<AppRouter>>;

/** The Session router's slice a remote Workspace uses: the typed client's own, nothing cast (AM4). */
export type RemoteSessionClient = Pick<TRPCClient<RemoteSessionRouter>, "session" | "sessions">;

/** A typed Session router client over one Workspace link. */
export function remoteSessionClient(link: HostLinkCalls): RemoteSessionClient {
  return createTRPCClient<RemoteSessionRouter>({
    links: [hostLinkTrpcLink<RemoteSessionRouter>(link)],
  });
}

/**
 * The chat core's transport for one remote Workspace. The core's own reads
 * and commands go straight through; its streams go through the Workspace's
 * budget, so only the Sessions on screen hold one.
 */
export function remoteChatTransport(
  client: RemoteSessionClient,
  streams: Pick<RemoteSessionStreams, "wrap">,
  window: Parameters<typeof racingFlushScheduler>[0],
): ChatSessionTransport {
  const { session, sessions } = client;
  const rpc: ChatSessionRpc = {
    session: {
      snapshot: session.snapshot,
      history: session.history,
      projection: session.projection,
      subscribe: streams.wrap(session.subscribe),
      subscribeQueue: streams.wrap(session.subscribeQueue),
      command: session.command,
      cancelQueued: session.cancelQueued,
      editQueued: session.editQueued,
      cancelInteraction: session.cancelInteraction,
      reconcile: session.reconcile,
    },
  };
  return {
    rpc,
    streamRecovery: "host-link",
    scheduler: racingFlushScheduler(window),
    newCommandId: () => crypto.randomUUID(),
    // No model and no automatic pick: a remote Session runs the host's
    // default (VC-713), which the host resolves for the Role at create.
    createSession: (input) =>
      sessions.create.mutate({
        operationId: input.operationId,
        projectId: input.projectId,
        ticketId: input.ticketId,
        title: input.title,
        ...(input.requestedSessionId === undefined
          ? {}
          : { requestedSessionId: input.requestedSessionId }),
        ...(input.skills === undefined ? {} : { skills: [...input.skills] }),
      }),
    attachSession: (input) =>
      sessions.attach.mutate({ operationId: input.operationId, sessionId: input.sessionId }),
  };
}

type ListingRows = Extract<SessionsResult, { ok: true }>["sessions"];
type WireRows = Awaited<ReturnType<RemoteSessionClient["session"]["listing"]["query"]>>["sessions"];

/**
 * The wire's rows as the listing stores hold them. A harness id is the one
 * field the wire carries as a plain string and the domain names nominally
 * (`parseHarnessId`); a terminal row naming no harness this build can read
 * is left out rather than drawn under a made-up one. (hostd composes no
 * terminals, so this is a row from an older or stranger host.)
 */
export function listingRowsFromWire(rows: WireRows): ListingRows {
  return rows.flatMap((row): ListingRows => {
    if (row.kind === "chat") return [row];
    const harnessId = parseHarnessId(row.record.harnessId);
    if (harnessId === null) return [];
    const active =
      row.record.activeHarnessId === null ? null : parseHarnessId(row.record.activeHarnessId);
    return [{ ...row, record: { ...row.record, harnessId, activeHarnessId: active } }];
  });
}

/** A failed read as the listing stores take one: said, never thrown. */
async function listed(read: () => Promise<{ sessions: WireRows }>): Promise<SessionsResult> {
  try {
    return { ok: true, sessions: listingRowsFromWire((await read()).sessions) };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/** The listing reader for one remote Workspace. */
export function remoteListingReader(
  client: Pick<RemoteSessionClient, "session">,
): SessionListingReader {
  return {
    list: ({ projectId }) => listed(() => client.session.listing.query({ projectId })),
    listForTicket: ({ ticketId }) =>
      listed(() => client.session.listingForTicket.query({ ticketId })),
  };
}
