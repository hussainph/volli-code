/**
 * Sign-ins on remote hosts, desktop main's side (VC-702 PR 2): what the
 * renderer's sign-in rows ask for (`HostSignInSource`), over each host's link.
 *
 * - **status / paste**: straight to the host (`signIns.status`,
 *   `signIns.setApiKey`, `signIns.setGitCredential`).
 * - **Send from this Mac**: this Mac's own Pi credential is read here, at the
 *   person's request after the confirm, and goes onto the host link; the key
 *   never reaches the renderer ({@link sendApiKeyFromThisMac}).
 * - **a subscription login**: runs on the host; this Mac relays the browser's
 *   redirect and opens the browser ({@link runHostSignIn}).
 *
 * **The transport is a port.** {@link HostSignInLinks} answers one host's
 * link; VC-700's host registry (PR 2, #815) supplies it. Until it lands,
 * {@link UNCONNECTED_HOST_SIGN_IN_LINKS} answers every host as unreachable,
 * and nothing is wired to the renderer.
 */
import type {
  HostSetGitCredentialInput,
  HostSignInRunEvent,
  HostSignInSendResult,
  HostSignInStatus,
} from "@volli/shared";

import {
  macKeyAvailability,
  sendApiKeyFromThisMac,
  type MacCredentialReader,
  type NativeSendApproval,
  type SendConfirmationLabels,
} from "./send-from-this-mac";
import {
  runHostSignIn,
  type HostFlowLedger,
  type HostSignInLink,
  type HostSignInRun,
} from "./sign-in-runner";

/** One host's link, as the sign-in rows use it. */
export interface HostSignInHostLink extends HostSignInLink {
  status(): Promise<HostSignInStatus>;
  setApiKey(input: { providerId: string; key: string }): Promise<HostSignInStatus>;
  setGitCredential(input: HostSetGitCredentialInput): Promise<HostSignInStatus>;
}

/** Each host's link by host id, or null when this Mac has none open to it. */
export interface HostSignInLinks {
  linkFor(hostId: string): HostSignInHostLink | null;
}

/** No host is connected yet (VC-700 PR 2 plugs the registry in). */
export const UNCONNECTED_HOST_SIGN_IN_LINKS: HostSignInLinks = Object.freeze({
  linkFor: () => null,
});

/** The reads "Send from this Mac" needs from this Mac's Pi credential store. */
export interface MacCredentialStore extends MacCredentialReader {
  list(): Promise<readonly { providerId: string; type: "api_key" | "oauth" }[]>;
}

/** The most provider ids "Send from this Mac" offers, and the longest one. */
export const MAX_MAC_KEYS = 256;
export const MAX_PROVIDER_ID_LENGTH = 256;

export class HostUnreachableError extends Error {
  constructor() {
    super("This Mac has no connection to that host.");
    this.name = "HostUnreachableError";
  }
}

export interface HostSignInService {
  status(hostId: string): Promise<HostSignInStatus>;
  macKeys(): Promise<readonly string[]>;
  sendFromThisMac(
    hostId: string,
    providerId: string,
    confirmed: true,
  ): Promise<HostSignInSendResult>;
  setApiKey(hostId: string, providerId: string, key: string): Promise<HostSignInStatus>;
  setGitCredential(hostId: string, input: HostSetGitCredentialInput): Promise<HostSignInStatus>;
  /**
   * A subscription login on the host. `follows` is what came before it for
   * the same host and provider: the run it replaces, and the flows the host
   * may still hold.
   */
  signInOnHost(
    hostId: string,
    providerId: string,
    onEvent: (event: HostSignInRunEvent) => void,
    follows?: { readonly replaces?: HostSignInRun; readonly ledger?: HostFlowLedger },
  ): HostSignInRun;
}

export function createHostSignInService(options: {
  readonly links: HostSignInLinks;
  readonly mac: MacCredentialStore;
  readonly openExternal: (url: string) => void | Promise<void>;
  /** Main resolves local catalog/registry names and owns the native dialog. */
  readonly sendConfirmation: {
    resolve(hostId: string, providerId: string): SendConfirmationLabels | null;
    confirm(labels: SendConfirmationLabels): Promise<NativeSendApproval | "cancelled" | null>;
  };
  /** Test seam: the relay's bind, handed to every run. */
  readonly bind?: Parameters<typeof runHostSignIn>[0]["bind"];
}): HostSignInService {
  const link = (hostId: string): HostSignInHostLink => {
    const found = options.links.linkFor(hostId);
    if (found === null) throw new HostUnreachableError();
    return found;
  };
  return {
    status: async (hostId) => link(hostId).status(),
    macKeys: async () => {
      const listed = await options.mac.list();
      const keys: string[] = [];
      for (const { providerId, type } of listed) {
        // Bounded: a provider id a row could name, and no more than a sheet shows.
        if (keys.length === MAX_MAC_KEYS) break;
        if (type !== "api_key" || providerId.length > MAX_PROVIDER_ID_LENGTH) continue;
        if ((await macKeyAvailability(options.mac, providerId)).kind === "key") {
          keys.push(providerId);
        }
      }
      return keys;
    },
    sendFromThisMac: async (hostId, providerId, confirmed) => {
      const host = link(hostId);
      let lost = false;
      // Latch loss even if this link reconnects while the dialog is open.
      const stop = host.watchLoss(() => {
        lost = true;
      });
      try {
        const labels = options.sendConfirmation?.resolve(hostId, providerId);
        if (labels == null) return { ok: false, reason: "send-failed" };
        const isCurrent = (): boolean => {
          const current = options.sendConfirmation.resolve(hostId, providerId);
          // linkFor creates adapters, so their object identity is not a connection
          // identity. watchLoss owns that fence; lookup also catches flag-off/forget.
          return (
            !lost &&
            options.links.linkFor(hostId) !== null &&
            current !== null &&
            current.providerLabel === labels.providerLabel &&
            current.hostName === labels.hostName &&
            current.hostTarget === labels.hostTarget
          );
        };
        const sent = await sendApiKeyFromThisMac({
          providerId,
          confirmed,
          store: options.mac,
          confirm: () => options.sendConfirmation.confirm(labels),
          isCurrent,
          setApiKey: (input) => host.setApiKey(input),
        });
        if (sent.ok) return sent;
        if (sent.reason === "cancelled") {
          // The existing wire success is a status projection, not a send receipt.
          // Return the unchanged authoritative status so Cancel returns to the
          // row without an error, a credential read, or a write on the host.
          return { ok: true, status: await host.status() };
        }
        return { ok: false, reason: sent.reason };
      } catch {
        return { ok: false, reason: "send-failed" };
      } finally {
        stop();
      }
    },
    setApiKey: async (hostId, providerId, key) => link(hostId).setApiKey({ providerId, key }),
    setGitCredential: async (hostId, input) => link(hostId).setGitCredential(input),
    signInOnHost: (hostId, providerId, onEvent, follows) =>
      runHostSignIn({
        link: link(hostId),
        providerId,
        openExternal: options.openExternal,
        onEvent,
        replaces: follows?.replaces,
        ledger: follows?.ledger,
        bind: options.bind,
      }),
  };
}
