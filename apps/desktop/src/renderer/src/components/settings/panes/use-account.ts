/**
 * The Volli Cloud account as Settings → Account reads it (VC-884): main's
 * `account.subscribe` stream while the pane is mounted, and the commands it
 * sends, and the same for the account's GitHub half (VC-897,
 * `account.githubSubscribe`). The snapshots are a profile, a connection and
 * a state, never a token; main owns the sign-in and follows every browser
 * round trip. Mounted only with `cloud` on.
 */
import * as React from "react";
import type { AccountConnection, AccountGithubSnapshot, AccountSnapshot } from "@volli/shared";

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
    readonly githubSubscribe: {
      subscribe(
        input: undefined,
        handlers: { onData(data: AccountGithubSnapshot): void; onError(error: unknown): void },
      ): { unsubscribe(): void };
    };
    readonly githubConnect: { mutate(): Promise<unknown> };
    readonly githubInstall: { mutate(): Promise<unknown> };
    readonly githubCancel: { mutate(): Promise<unknown> };
    readonly githubDisconnect: { mutate(): Promise<unknown> };
  };
  /** The restart into the store the account now chooses (VC-889). */
  readonly cloud: { readonly relaunch: { mutate(): Promise<unknown> } };
}

type StreamView<Snapshot> =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly snapshot: Snapshot }
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

export interface AccountGithubCommands {
  connect(): Promise<unknown>;
  install(): Promise<unknown>;
  cancel(): Promise<unknown>;
  disconnect(): Promise<unknown>;
}

function githubCommands(rpc: AccountRpc): AccountGithubCommands {
  return {
    connect: () => rpc.account.githubConnect.mutate(),
    install: () => rpc.account.githubInstall.mutate(),
    cancel: () => rpc.account.githubCancel.mutate(),
    disconnect: () => rpc.account.githubDisconnect.mutate(),
  };
}

/** One of the tier's snapshot streams. */
interface SnapshotStream<Snapshot> {
  subscribe(
    input: undefined,
    handlers: { onData(data: Snapshot): void; onError(error: unknown): void },
  ): { unsubscribe(): void };
}

/** Follows one snapshot stream while mounted; a failed stream says so, and a retry subscribes again. */
function useStream<Snapshot>(
  rpc: AccountRpc,
  stream: (rpc: AccountRpc) => SnapshotStream<Snapshot>,
  failed: string,
): { view: StreamView<Snapshot>; retry: () => void } {
  const [view, setView] = React.useState<StreamView<Snapshot>>({ kind: "loading" });
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    setView({ kind: "loading" });
    const subscription = stream(rpc).subscribe(undefined, {
      onData: (snapshot) => setView({ kind: "ready", snapshot }),
      onError: (error) =>
        setView({ kind: "failed", message: error instanceof Error ? error.message : failed }),
    });
    return () => subscription.unsubscribe();
  }, [rpc, stream, failed, attempt]);
  return { view, retry: () => setAttempt((count) => count + 1) };
}

const accountStream = (rpc: AccountRpc) => rpc.account.subscribe;
const githubStream = (rpc: AccountRpc) => rpc.account.githubSubscribe;

/** Follows the account while mounted; a failed stream says so and offers a retry. */
export function useAccount(rpc: AccountRpc = sessionRpcClient()): {
  view: StreamView<AccountSnapshot>;
  commands: AccountCommands;
  retry: () => void;
} {
  const { view, retry } = useStream(rpc, accountStream, "Couldn't read the account.");
  const commands = React.useMemo(() => accountCommands(rpc), [rpc]);
  return { view, commands, retry };
}

/**
 * Follows the account's GitHub half while mounted. Each subscription is a
 * fresh read in main, so `retry` (a new subscription) is also how a failed
 * read is tried again.
 */
export function useAccountGithub(rpc: AccountRpc = sessionRpcClient()): {
  view: StreamView<AccountGithubSnapshot>;
  commands: AccountGithubCommands;
  retry: () => void;
} {
  const { view, retry } = useStream(rpc, githubStream, "Couldn't read your GitHub connection.");
  const commands = React.useMemo(() => githubCommands(rpc), [rpc]);
  return { view, commands, retry };
}
