/**
 * The hosts this Mac added over SSH, as Settings → Hosts and the Add-a-host
 * sheet read them (VC-700 PR 3), and the calls they make.
 *
 * VC-576's host-connection store holds what EVERY host surface shows (a
 * name, an OS, a link); this one holds what only managing a remote host
 * needs: its SSH target, how it was installed (a user install's agents share
 * the person's account), this Mac's device id on it. Both are fed by the one
 * `hosts.subscribe` stream (`remote-host-source.ts`), only while `cloud` is
 * on; with it off this store stays empty and nothing here is called.
 *
 * Nothing durable and no secrets: a sudo password goes straight to
 * `hostAdd.sudoPassword` from the field that holds it, never through here.
 */
import type {
  AddHostAnswer,
  AddHostEvent,
  AddHostFacts,
  AddHostStartInput,
  AddHostStepId,
  RemoteHost,
  RemoteHostDevices,
} from "@volli/shared";
import { create } from "zustand";

import { sessionRpcClient } from "../lib/session-rpc-ipc-link";

/** What managing remote hosts asks of desktop main (the desktop-only tier). */
export interface RemoteHostsApi {
  startAdd(input: AddHostStartInput): Promise<{ readonly flowId: string }>;
  /** One replay (the view, the newest of the log) at once, then every change. */
  subscribeAdd(
    flowId: string,
    handlers: { onEvent(event: AddHostEvent): void; onError(error: unknown): void },
  ): () => void;
  /** Answers the question `questionId` (the view's `question.id`): a stale one is refused. */
  answerAdd(flowId: string, questionId: string, answer: AddHostAnswer): Promise<unknown>;
  sudoPassword(flowId: string, questionId: string, password: string): Promise<unknown>;
  retryAdd(flowId: string, from?: AddHostStepId): Promise<unknown>;
  cancelAdd(flowId: string): Promise<unknown>;
  /** What the flow has found so far: read on each view, beside the stream. */
  addFacts(flowId: string): Promise<AddHostFacts>;
  rename(hostId: string, name: string): Promise<unknown>;
  forget(hostId: string): Promise<unknown>;
  devices(hostId: string): Promise<RemoteHostDevices>;
}

/** The tier client's `hosts.*` and `hostAdd.*`, as tRPC types them (structurally). */
export interface RemoteHostsApiRpc {
  readonly hosts: {
    readonly rename: { mutate(input: { hostId: string; name: string }): Promise<unknown> };
    readonly forget: { mutate(input: { hostId: string }): Promise<unknown> };
    readonly devices: { query(input: { hostId: string }): Promise<RemoteHostDevices> };
  };
  readonly hostAdd: {
    readonly start: { mutate(input: AddHostStartInput): Promise<{ flowId: string }> };
    readonly subscribe: {
      subscribe(
        input: { flowId: string },
        handlers: { onData(event: AddHostEvent): void; onError(error: unknown): void },
      ): { unsubscribe(): void };
    };
    readonly answer: {
      mutate(input: {
        flowId: string;
        questionId: string;
        answer: AddHostAnswer;
      }): Promise<unknown>;
    };
    readonly sudoPassword: {
      mutate(input: { flowId: string; questionId: string; password: string }): Promise<unknown>;
    };
    readonly retry: {
      mutate(input: { flowId: string; from?: AddHostStepId }): Promise<unknown>;
    };
    readonly cancel: { mutate(input: { flowId: string }): Promise<unknown> };
    readonly facts: { query(input: { flowId: string }): Promise<AddHostFacts> };
  };
}

/** The desktop-only tier as {@link RemoteHostsApi}. */
export function remoteHostsApi(rpc: RemoteHostsApiRpc): RemoteHostsApi {
  return {
    startAdd: (input) => rpc.hostAdd.start.mutate(input),
    subscribeAdd(flowId, handlers) {
      const subscription = rpc.hostAdd.subscribe.subscribe(
        { flowId },
        { onData: (event) => handlers.onEvent(event), onError: (error) => handlers.onError(error) },
      );
      return () => subscription.unsubscribe();
    },
    answerAdd: (flowId, questionId, answer) =>
      rpc.hostAdd.answer.mutate({ flowId, questionId, answer }),
    sudoPassword: (flowId, questionId, password) =>
      rpc.hostAdd.sudoPassword.mutate({ flowId, questionId, password }),
    retryAdd: (flowId, from) =>
      rpc.hostAdd.retry.mutate(from === undefined ? { flowId } : { flowId, from }),
    cancelAdd: (flowId) => rpc.hostAdd.cancel.mutate({ flowId }),
    addFacts: (flowId) => rpc.hostAdd.facts.query({ flowId }),
    rename: (hostId, name) => rpc.hosts.rename.mutate({ hostId, name }),
    forget: (hostId) => rpc.hosts.forget.mutate({ hostId }),
    devices: (hostId) => rpc.hosts.devices.query({ hostId }),
  };
}

export interface RemoteHostsState {
  /** The registry's hosts as main last streamed them. Empty with `cloud` off. */
  readonly hosts: readonly RemoteHost[];
  /**
   * Why this Mac's hosts cannot change now (its hosts file is from a newer
   * Volli, or unreadable), or `null`: Settings → Hosts says so and offers no change.
   */
  readonly readOnly: string | null;
  /** The Add-a-host sheet. `target` prefills its field (Back from a flow keeps what was typed). */
  readonly addHost: { readonly open: boolean; readonly target: string };
  setHosts(hosts: readonly RemoteHost[], readOnly?: string | null): void;
  openAddHost(target?: string): void;
  closeAddHost(): void;
}

const NO_HOSTS: readonly RemoteHost[] = Object.freeze([]);

/** Factory so tests get isolated instances (the store module's own convention). */
export function createRemoteHostsStore() {
  return create<RemoteHostsState>()((set) => ({
    hosts: NO_HOSTS,
    readOnly: null,
    addHost: { open: false, target: "" },
    setHosts: (hosts, readOnly = null) =>
      set({ hosts: hosts.length === 0 ? NO_HOSTS : hosts, readOnly }),
    openAddHost: (target = "") => set({ addHost: { open: true, target } }),
    closeAddHost: () => set((state) => ({ addHost: { ...state.addHost, open: false } })),
  }));
}

export const useRemoteHostsStore = createRemoteHostsStore();

let api: RemoteHostsApi | null = null;

/** The app's {@link RemoteHostsApi}, over the session-rpc bridge; tests and the lab swap it. */
export function remoteHosts(): RemoteHostsApi {
  api ??= remoteHostsApi(sessionRpcClient());
  return api;
}

/** Replaces the API (tests, the lab); `null` goes back to the bridge's. */
export function setRemoteHostsApi(next: RemoteHostsApi | null): void {
  api = next;
}

/**
 * Whether this Mac's hosts can change now: `false` while main reports the
 * hosts file read-only (newer Volli, unreadable). Settings → Hosts offers no
 * Add, Rename or Forget then, rather than letting main refuse each.
 */
export function useHostsWritable(): boolean {
  return useRemoteHostsStore((state) => state.readOnly === null);
}

/** One remote host's registry record, or `undefined` (This Mac, or gone). */
export function remoteHostOf(
  hosts: readonly RemoteHost[],
  hostId: string | null,
): RemoteHost | undefined {
  return hostId === null ? undefined : hosts.find((host) => host.id === hostId);
}
