/**
 * Desktop main's Volli Cloud account (VC-884), composed from its config: the
 * provider adapter, the backend client and the sealed session store around
 * the service. `index.ts` (main) calls {@link createDesktopAccount} once and
 * hands the result to the handler map as its `AccountPort`.
 */
import type { AccountPort } from "@volli/host-core/handlers";

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
  });
}

/** The service as the handler map's port: the same object, its main-only methods hidden by type. */
export function accountPort(service: AccountService): AccountPort {
  return {
    snapshot: () => service.snapshot(),
    subscribe: (listener) => service.subscribe(listener),
    signIn: (connection) => service.signIn(connection),
    cancelSignIn: () => service.cancelSignIn(),
    signOut: () => service.signOut(),
    requestDeletion: () => service.requestDeletion(),
    cancelDeletion: () => service.cancelDeletion(),
  };
}
