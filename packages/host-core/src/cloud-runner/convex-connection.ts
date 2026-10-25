/**
 * The backend link's Convex adapter: one Convex client WebSocket per
 * connection, authenticated with the runner token, functions called by name
 * (nothing here depends on the backend's generated types).
 *
 * The Convex client itself is handed in ({@link ConvexClientModule}: the
 * `convex/browser` and `convex/server` exports the adapter uses), so
 * host-core takes no dependency on it; the runner's composition root
 * imports it and passes it here:
 *
 * ```ts
 * import { ConvexClient } from "convex/browser";
 * import { makeFunctionReference } from "convex/server";
 * convexBackendConnection(url, { ConvexClient, makeFunctionReference });
 * ```
 */
import type { BackendConnection, ConnectBackend } from "./backend-link";

type TokenFetcher = (options: { forceRefreshToken: boolean }) => Promise<string | null | undefined>;

/** The slice of `ConvexClient` the adapter uses. */
export interface ConvexClientLike {
  setAuth(fetchToken: TokenFetcher): void;
  mutation(reference: never, args: never): Promise<unknown>;
  onUpdate(reference: never, args: never, callback: (value: never) => void): () => void;
  connectionState(): { isWebSocketConnected: boolean };
  subscribeToConnectionState(
    listener: (state: { isWebSocketConnected: boolean }) => void,
  ): () => void;
  close(): Promise<void>;
}

export interface ConvexClientModule {
  ConvexClient: new (
    address: string,
    options: { unsavedChangesWarning: boolean },
  ) => ConvexClientLike;
  makeFunctionReference(name: string): unknown;
}

/** A {@link ConnectBackend} for the deployment at `url` (`https://<deployment>.convex.cloud`). */
export function convexBackendConnection(url: string, convex: ConvexClientModule): ConnectBackend {
  return (token) => {
    const client = new convex.ConvexClient(url, { unsavedChangesWarning: false });
    client.setAuth(token);
    const connection: BackendConnection = {
      mutation: (name, args) =>
        client.mutation(convex.makeFunctionReference(name) as never, args as never),
      onUpdate(name, args, listener) {
        const off = client.onUpdate(
          convex.makeFunctionReference(name) as never,
          args as never,
          listener as (value: never) => void,
        );
        return () => off();
      },
      isConnected: () => client.connectionState().isWebSocketConnected,
      onConnectionChange(listener) {
        let last = client.connectionState().isWebSocketConnected;
        return client.subscribeToConnectionState((state) => {
          if (state.isWebSocketConnected !== last) {
            last = state.isWebSocketConnected;
            listener(last);
          }
        });
      },
      close: () => client.close(),
    };
    return connection;
  };
}
