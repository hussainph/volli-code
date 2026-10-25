/**
 * The Volli Cloud account as Settings → Account reads it (VC-884): main's
 * `account.subscribe` stream while the pane is mounted, and the commands it
 * sends. The snapshot is a profile and a state, never a token; main owns the
 * sign-in. Mounted only with `cloud` on.
 */
import * as React from "react";
import type { AccountConnection, AccountSnapshot } from "@volli/shared";

import { sessionRpcClient } from "@renderer/lib/session-rpc-ipc-link";

/** What the tier client offers this hook: `account.*`, as tRPC types it. */
export interface AccountRpc {
  readonly account: {
    readonly subscribe: {
      subscribe(
        input: undefined,
        handlers: { onData(data: AccountSnapshot): void; onError(error: unknown): void },
      ): { unsubscribe(): void };
    };
    readonly signIn: { mutate(input: { connection: AccountConnection }): Promise<unknown> };
    readonly cancelSignIn: { mutate(): Promise<unknown> };
    readonly signOut: { mutate(): Promise<unknown> };
    readonly requestDeletion: { mutate(): Promise<unknown> };
    readonly cancelDeletion: { mutate(): Promise<unknown> };
  };
  /** The restart into the store the account now chooses (VC-889). */
  readonly cloud: { readonly relaunch: { mutate(): Promise<unknown> } };
}

type AccountView =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly snapshot: AccountSnapshot }
  | { readonly kind: "failed"; readonly message: string };

export interface AccountCommands {
  signIn(connection: AccountConnection): Promise<unknown>;
  cancelSignIn(): Promise<unknown>;
  signOut(): Promise<unknown>;
  requestDeletion(): Promise<unknown>;
  cancelDeletion(): Promise<unknown>;
  relaunch(): Promise<unknown>;
}

function accountCommands(rpc: AccountRpc): AccountCommands {
  return {
    signIn: (connection) => rpc.account.signIn.mutate({ connection }),
    cancelSignIn: () => rpc.account.cancelSignIn.mutate(),
    signOut: () => rpc.account.signOut.mutate(),
    requestDeletion: () => rpc.account.requestDeletion.mutate(),
    cancelDeletion: () => rpc.account.cancelDeletion.mutate(),
    relaunch: () => rpc.cloud.relaunch.mutate(),
  };
}

/** Follows the account while mounted; a failed stream says so and offers a retry. */
export function useAccount(rpc: AccountRpc = sessionRpcClient()): {
  view: AccountView;
  commands: AccountCommands;
  retry: () => void;
} {
  const [view, setView] = React.useState<AccountView>({ kind: "loading" });
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    setView({ kind: "loading" });
    const subscription = rpc.account.subscribe.subscribe(undefined, {
      onData: (snapshot) => setView({ kind: "ready", snapshot }),
      onError: (error) =>
        setView({
          kind: "failed",
          message: error instanceof Error ? error.message : "Couldn't read the account.",
        }),
    });
    return () => subscription.unsubscribe();
  }, [rpc, attempt]);
  const commands = React.useMemo(() => accountCommands(rpc), [rpc]);
  return { view, commands, retry: () => setAttempt((count) => count + 1) };
}
