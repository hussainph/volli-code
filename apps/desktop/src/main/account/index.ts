/**
 * Desktop main's Volli Cloud account (VC-884), composed from its config: the
 * provider adapter, the backend client and the sealed session store around
 * the service. `index.ts` (main) calls {@link createDesktopAccount} once and
 * hands the result to the handler map as its `AccountPort`.
 */
import type { AccountPort } from "@volli/host-core/handlers";
import type { CloudLaunch } from "@volli/shared";

import { convexAccountBackend } from "./backend";
import type { AccountConfig } from "./config";
import { devIssuerProvider } from "./dev-issuer";
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
  readonly marker?: { write(userId: string): void; clear(): void };
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
 * The service as the handler map's port: the same object, its main-only
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
  },
): AccountPort {
  return {
    snapshot: () => service.snapshot(),
    subscribe: (listener) => service.subscribe(listener),
    signIn: (connection) => service.signIn(connection),
    cancelSignIn: () => service.cancelSignIn(),
    signOut: () => service.signOut(),
    requestDeletion: () => service.requestDeletion(),
    cancelDeletion: () => service.cancelDeletion(),
    accessToken: (force) => service.windowToken(force),
    launch: () => launch.launch(),
    relaunch: () => launch.relaunch(),
    reportUnsavedWrites: (count) => launch.reportUnsavedWrites(count),
    saveSnapshot: (text) => launch.saveSnapshot(text),
    readSnapshot: () => launch.readSnapshot(),
  };
}
