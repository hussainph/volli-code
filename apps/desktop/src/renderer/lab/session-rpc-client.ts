/**
 * The lab's intentionally tiny browser client for the Session tRPC edge.
 *
 * Importing this module has no transport effect. A scratch must create the
 * client only from an effect after it mounts; the lab shell eagerly imports
 * every scratch to populate its picker.
 */
import {
  createTRPCClient,
  httpBatchLink,
  httpSubscriptionLink,
  splitLink,
  type TRPCClient,
} from "@trpc/client";
import type { AppRouter } from "@volli/session-rpc";

export const LAB_SESSION_RPC_PATH = "/__lab/session-rpc";

export type SessionRpcClient = TRPCClient<AppRouter>;

/** Creates an HTTP-query/mutation plus SSE-subscription client for the lab bridge. */
export function createSessionRpcClient(
  endpoint = new URL(LAB_SESSION_RPC_PATH, window.location.origin).toString(),
): SessionRpcClient {
  return createTRPCClient<AppRouter>({
    links: [
      splitLink({
        condition: (operation) => operation.type === "subscription",
        true: httpSubscriptionLink({ url: endpoint }),
        false: httpBatchLink({ url: endpoint }),
      }),
    ],
  });
}
