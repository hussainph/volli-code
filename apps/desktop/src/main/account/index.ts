/**
 * Desktop main's Volli Cloud account (VC-884), composed from its config: the
 * provider adapter, the backend client and the sealed session store around
 * the service, and the account's GitHub half (VC-897) over the same backend.
 * `index.ts` (main) calls {@link createDesktopAccount} and
 * {@link createDesktopGithub} once and hands both to the handler map as its
 * `AccountPort`.
 */
import type { AccountPort } from "@volli/host-core/handlers";
import type { CloudLaunch } from "@volli/shared";

import { convexAccountBackend, convexCaller } from "./backend";
import type { AccountConfig } from "./config";
import { devIssuerProvider } from "./dev-issuer";
import { convexGithubBackend, createGithubService, type GithubService } from "./github";
import type { AccountProvider } from "./provider";
import { createAccountService, type AccountLogger, type AccountService } from "./service";
import { inventoryAccountSessionStore, type AccountSessionInventory } from "./session-store";
import { workosProvider } from "./workos";

export { resolveAccountConfig } from "./config";

function providerFor(config: AccountConfig): AccountProvider | null {
  const chosen = config.provider;
  if (chosen === null) return null;
  if (chosen.kind === "dev") {
    return devIssuerProvider({
      privateKeyPem: chosen.privateKeyPem,
      ...(chosen.subject === null ? {} : { subject: chosen.subject }),
      ...(chosen.email === undefined ? {} : { email: chosen.email }),
    });
  }
  return workosProvider({
    clientId: chosen.clientId,
    ...(chosen.apiBase === null ? {} : { apiBase: chosen.apiBase }),
  });
}

export function createDesktopAccount(input: {
  readonly config: AccountConfig;
  readonly enabled: () => boolean;
  readonly inventory: AccountSessionInventory;
  readonly unlockInventory: () => Promise<void>;
  readonly openBrowser: (url: string) => void | Promise<void>;
  readonly log: AccountLogger;
  /** The next launch's product store marker (`../cloud-launch.ts`). */
  readonly marker?: { write(userId: string, joinedWorkspaceId?: string): void; clear(): void };
}): AccountService {
  if (input.config.problem !== null) {
    input.log.warn("account configuration ignored", { problem: input.config.problem });
  }
  return createAccountService({
    enabled: input.enabled,
    provider: providerFor(input.config),
    backend:
      input.config.backendUrl === null
        ? null
        : convexAccountBackend({ url: input.config.backendUrl }),
    store: inventoryAccountSessionStore(input.inventory, input.unlockInventory),
    openBrowser: input.openBrowser,
    log: input.log,
    ...(input.marker === undefined ? {} : { marker: input.marker }),
  });
}

/**
 * The account's GitHub half (VC-897): the backend's GitHub functions with the
 * account's access token, following the account so a sign-out, a deletion or
 * another person ends what was shown. Every call refuses while `cloud` is off.
 */
export function createDesktopGithub(input: {
  readonly config: AccountConfig;
  readonly enabled: () => boolean;
  readonly account: Pick<AccountService, "accessToken" | "subscribe">;
  readonly openBrowser: (url: string) => void | Promise<void>;
  readonly log: AccountLogger;
}): GithubService {
  return createGithubService({
    enabled: input.enabled,
    backend:
      input.config.backendUrl === null
        ? null
        : convexGithubBackend(convexCaller({ url: input.config.backendUrl }), input.log),
    accessToken: () => input.account.accessToken(),
    account: { subscribe: (listener) => input.account.subscribe(listener) },
    openBrowser: input.openBrowser,
    log: input.log,
  });
}

/**
 * The services as the handler map's port: the same objects, their main-only
 * methods hidden by type, beside the launch it chose (VC-889).
 */
export function accountPort(
  service: AccountService,
  launch: {
    launch(): CloudLaunch;
    relaunch(): void;
    reportUnsavedWrites(count: number): void;
    saveSnapshot(text: string): void;
    readSnapshot(): string | null;
    beforeSignOut?(): void;
  },
  github: GithubService,
): AccountPort {
  return {
    snapshot: () => service.snapshot(),
    subscribe: (listener) => service.subscribe(listener),
    signIn: (connection, inviteCode, acceptedAgreementVersion) =>
      service.signIn(connection, inviteCode, acceptedAgreementVersion),
    cancelSignIn: () => service.cancelSignIn(),
    signOut: () => {
      launch.beforeSignOut?.();
      return service.signOut();
    },
    requestDeletion: () => service.requestDeletion(),
    cancelDeletion: () => service.cancelDeletion(),
    accessToken: (force) => service.windowToken(force),
    launch: () => launch.launch(),
    relaunch: () => launch.relaunch(),
    reportUnsavedWrites: (count) => launch.reportUnsavedWrites(count),
    saveSnapshot: (text) => launch.saveSnapshot(text),
    readSnapshot: () => launch.readSnapshot(),
    github: {
      subscribe: (listener) => github.subscribe(listener),
      connect: () => github.connect(),
      install: () => github.install(),
      cancel: () => github.cancel(),
      disconnect: () => github.disconnect(),
    },
  };
}
