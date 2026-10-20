/**
 * A stand-in for main's Workspace link relay, as the window's typed client
 * (VC-712): a real tRPC client over a terminating link that answers
 * `hostLink.query` and `hostLink.subscribe` from the functions it is given.
 * Nothing is cast to the client's type: it is built the way the app's own
 * client is, so a test or a lab scratch hands `relayHostLink` the very type it
 * takes (AM4).
 */
import { createTRPCClient, TRPCClientError, type TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import type { DesktopIpcRouter } from "@volli/session-rpc";
import type { HostLinkRelayCall, HostLinkRelayEvent } from "@volli/shared";

import type { RelayHostLinkRpc } from "./relay-host-link";

/** What the stand-in relay does with each call the window makes. */
export interface FakeRelay {
  /** `hostLink.query` (and `hostLink.mutate`): the operation's own answer, or a throw. */
  query(call: HostLinkRelayCall): Promise<unknown>;
  /** `hostLink.subscribe`: emits relay events; returns the stop. */
  subscribe(
    call: HostLinkRelayCall & { readonly lastEventId?: string },
    emit: (event: HostLinkRelayEvent) => void,
  ): () => void;
}

function isCall(input: unknown): input is HostLinkRelayCall & { readonly lastEventId?: string } {
  return (
    typeof input === "object" &&
    input !== null &&
    typeof (input as { workspaceId?: unknown }).workspaceId === "string" &&
    typeof (input as { path?: unknown }).path === "string"
  );
}

/** The window's client over `relay`: only the relay's slice is served. */
export function fakeRelayRpc(relay: FakeRelay): RelayHostLinkRpc {
  const link: TRPCLink<DesktopIpcRouter> =
    () =>
    ({ op }) =>
      observable((observer) => {
        if (!isCall(op.input)) {
          observer.error(TRPCClientError.from(new Error(`not a relay call: ${op.path}`)));
          return () => {};
        }
        if (op.type === "subscription") {
          observer.next({ result: { type: "started" } });
          return relay.subscribe(op.input, (event) =>
            observer.next({ result: { type: "data", data: event } }),
          );
        }
        relay.query(op.input).then(
          (data) => {
            observer.next({ result: { data } });
            observer.complete();
          },
          (error: unknown) =>
            observer.error(
              TRPCClientError.from(error instanceof Error ? error : new Error(String(error))),
            ),
        );
        return () => {};
      });
  return createTRPCClient<DesktopIpcRouter>({ links: [link] });
}
