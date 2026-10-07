/**
 * The wire half of a remote project's Sessions (VC-713): a typed Session
 * router client over one Workspace link, the chat core's transport over it,
 * and the listing reader. Pure builders over the link they are handed: no
 * store, no `window.api`, so desktop main's real-link test drives exactly
 * these. What binds them to the window's stores is `remote-sessions.ts`.
 */
import { createTRPCClient, TRPCClientError, type TRPCClient, type TRPCLink } from "@trpc/client";
import type { AnyRouter } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import { TRPC_ERROR_CODES_BY_KEY } from "@trpc/server/rpc";
import { readHostError } from "@volli/host-protocol";
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
import { hostNotConnected } from "./remote-owners";
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

/** What a host that grants this window no Session features says, in its name (VC-713, B3). */
export function sessionsUnavailableOn(hostName: string): string {
  return `Sessions aren’t available on ${hostName} — update it to use them here`;
}

/** Whether a host refused an operation its link was never granted (an older host). */
export function isNotGranted(error: unknown): boolean {
  return readHostError(error).reason === "verb-refused";
}

/** The same failure, its message in the host's name; its code and reason unchanged. */
function renamed(error: TRPCClientError<AnyRouter>, message: string): TRPCClientError<AnyRouter> {
  const hostError = readHostError(error);
  return TRPCClientError.from<AnyRouter>(
    {
      error: {
        code: TRPC_ERROR_CODES_BY_KEY[hostError.code],
        message,
        data: { code: hostError.code, hostError: { ...hostError, message } },
      },
    },
    { cause: error },
  );
}

/**
 * Names the host in the two failures a person reads off a remote Session
 * (VC-713, B3): an operation an older host never granted, and a link that is
 * not connected. Every other failure passes through unchanged, so a
 * resnapshot or a refusal keeps the reason the chat core branches on.
 */
export function hostNamingLink<Router extends AnyRouter>(hostName: string): TRPCLink<Router> {
  return () =>
    ({ op, next }) =>
      observable((observer) => {
        const subscription = next(op).subscribe({
          next: (value) => observer.next(value),
          error: (error) => {
            const reason = readHostError(error).reason;
            if (reason === "verb-refused") {
              observer.error(renamed(error, sessionsUnavailableOn(hostName)));
            } else if (reason === "host-unreachable") {
              observer.error(renamed(error, hostNotConnected(hostName)));
            } else observer.error(error);
          },
          complete: () => observer.complete(),
        });
        return () => subscription.unsubscribe();
      });
}

/** A typed Session router client over one Workspace link, its failures in the host's name. */
export function remoteSessionClient(link: HostLinkCalls, hostName: string): RemoteSessionClient {
  return createTRPCClient<RemoteSessionRouter>({
    links: [
      hostNamingLink<RemoteSessionRouter>(hostName),
      hostLinkTrpcLink<RemoteSessionRouter>(link),
    ],
  });
}

/**
 * The transport for a project known to be on a remote host whose Workspace
 * is not bound here now (VC-713, B1): every read, command and stream fails at
 * once in the host's name. Never This Mac's IPC.
 */
export function closedRemoteTransport(
  hostName: string,
  window: Parameters<typeof racingFlushScheduler>[0],
): ChatSessionTransport {
  const refuse = (): Promise<never> => Promise.reject(new Error(hostNotConnected(hostName)));
  const call = { query: refuse, mutate: refuse };
  const stream = {
    subscribe: (_input: unknown, handlers: { onError(error: unknown): void }) => {
      let open = true;
      queueMicrotask(() => {
        if (open) handlers.onError(new Error(hostNotConnected(hostName)));
      });
      return {
        unsubscribe: () => {
          open = false;
        },
      };
    },
  };
  return {
    rpc: {
      session: {
        snapshot: call,
        history: call,
        projection: call,
        subscribe: stream,
        subscribeQueue: stream,
        command: call,
        cancelQueued: call,
        editQueued: call,
        cancelInteraction: call,
        reconcile: call,
      },
    },
    streamRecovery: "host-link",
    scheduler: racingFlushScheduler(window),
    newCommandId: () => crypto.randomUUID(),
    createSession: refuse,
    attachSession: refuse,
  };
}

/** The listing reader for a project known remote whose Workspace is not bound here now. */
export function closedListingReader(hostName: string): SessionListingReader {
  const refuse = async (): Promise<SessionsResult> => ({
    ok: false,
    error: hostNotConnected(hostName),
  });
  return { list: refuse, listForTicket: refuse };
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

/**
 * A failed read as the listing stores take one: said, never thrown. An
 * operation the host never granted is no failure to retry: the reader says
 * so once (`notGranted`) and answers an empty listing, which the surfaces
 * draw as the host's named unavailable state.
 */
async function listed(
  read: () => Promise<{ sessions: WireRows }>,
  notGranted: () => void,
): Promise<SessionsResult> {
  try {
    return { ok: true, sessions: listingRowsFromWire((await read()).sessions) };
  } catch (error) {
    if (isNotGranted(error)) {
      notGranted();
      return { ok: true, sessions: [] };
    }
    return { ok: false, error: errorMessage(error) };
  }
}

/**
 * The listing reader for one remote Workspace. `notGranted` hears that the
 * host refused the listing as an operation it never granted this link.
 */
export function remoteListingReader(
  client: Pick<RemoteSessionClient, "session">,
  notGranted: () => void,
): SessionListingReader {
  return {
    list: ({ projectId }) => listed(() => client.session.listing.query({ projectId }), notGranted),
    listForTicket: ({ ticketId }) =>
      listed(() => client.session.listingForTicket.query({ ticketId }), notGranted),
  };
}
