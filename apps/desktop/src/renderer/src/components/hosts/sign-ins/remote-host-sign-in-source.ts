/**
 * The sign-in rows' source over the desktop-only tier (VC-702 PR 2):
 * `hostSignIns.*`, which desktop main answers over each remote host's link.
 *
 * Nothing secret comes back through it. A key the person pastes passes
 * straight through to main; "Send from this Mac" names only the provider, and
 * main reads this Mac's own key itself, after the confirm the rows showed.
 */
import type { HostSignInRunEvent, HostSignInSendResult, HostSignInStatus } from "@volli/shared";
import { create } from "zustand";

import type { HostSignInRunHandle, HostSignInSource } from "./host-sign-in-controller";

/** What the tier client offers this source: `hostSignIns.*`, as tRPC types it. */
export interface HostSignInsRpc {
  readonly hostSignIns: {
    readonly status: { query(input: { hostId: string }): Promise<HostSignInStatus> };
    readonly macKeys: { query(): Promise<readonly string[]> };
    readonly sendFromThisMac: {
      mutate(input: {
        hostId: string;
        providerId: string;
        confirmed: true;
      }): Promise<HostSignInSendResult>;
    };
    readonly setApiKey: {
      mutate(input: { hostId: string; providerId: string; key: string }): Promise<HostSignInStatus>;
    };
    readonly setGitCredential: {
      mutate(input: {
        hostId: string;
        host: string;
        username: string;
        password: string;
      }): Promise<HostSignInStatus>;
    };
    readonly run: {
      subscribe(
        input: { hostId: string; providerId: string; runId: string },
        handlers: {
          onData(event: HostSignInRunEvent): void;
          onError(error: unknown): void;
          onComplete(): void;
        },
      ): { unsubscribe(): void };
    };
    readonly answer: {
      mutate(input: {
        hostId: string;
        providerId: string;
        promptId: string;
        value: string;
        runId: string;
      }): Promise<unknown>;
    };
    readonly cancel: {
      mutate(input: { hostId: string; providerId: string; runId: string }): Promise<unknown>;
    };
  };
}

export function remoteHostSignInSource(
  rpc: HostSignInsRpc,
  openExternal: (url: string) => void,
  /** Test seam: names each run, so main reaches only that run with its answer or cancel. */
  newRunId: () => string = () => crypto.randomUUID(),
): HostSignInSource {
  const tier = rpc.hostSignIns;
  return {
    status: (hostId) => tier.status.query({ hostId }),
    macKeys: () => tier.macKeys.query(),
    sendFromThisMac: (hostId, providerId) =>
      tier.sendFromThisMac.mutate({ hostId, providerId, confirmed: true }),
    setApiKey: (hostId, providerId, key) => tier.setApiKey.mutate({ hostId, providerId, key }),
    setGitCredential: (hostId, input) => tier.setGitCredential.mutate({ hostId, ...input }),
    signInOnHost(hostId, providerId, onEvent): HostSignInRunHandle {
      // This run's own name: a stale sheet's answer or cancel never reaches a newer run.
      const runId = newRunId();
      let ended = false;
      const end = (event: HostSignInRunEvent): void => {
        if (ended) return;
        ended = true;
        onEvent(event);
      };
      const subscription = tier.run.subscribe(
        { hostId, providerId, runId },
        {
          onData: (event) => {
            if (ended) return;
            if (["done", "failed", "cancelled", "lost"].includes(event.kind)) end(event);
            else onEvent(event);
          },
          // The window's link to main broke: nothing more will be heard.
          onError: () => end({ kind: "lost" }),
          onComplete: () => end({ kind: "lost" }),
        },
      );
      return {
        answer: (promptId, value) =>
          tier.answer.mutate({ hostId, providerId, promptId, value, runId }),
        // Cancelled here, it says nothing more: the surface that cancelled it
        // has already moved on. Ending the stream cancels it on the host too.
        cancel: async () => {
          ended = true;
          subscription.unsubscribe();
          await tier.cancel.mutate({ hostId, providerId, runId }).catch(() => undefined);
        },
      };
    },
    openExternal,
  };
}

/** Which host's sign-ins are open, and the provider a recovery asked to start. */
export interface HostSignInSheetTarget {
  readonly hostId: string;
  readonly hostName: string;
  /** "Sign in again" from the host chip: this provider's sign-in starts on open. */
  readonly providerId: string | null;
}

interface HostSignInSheetState {
  readonly target: HostSignInSheetTarget | null;
  open(target: HostSignInSheetTarget): void;
  close(): void;
}

/**
 * The one host sign-in sheet's target: the host chip's recovery opens it, and
 * VC-700's host pages and Checklist open it for a host too.
 */
export const useHostSignInSheet = create<HostSignInSheetState>()((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}));
