/** One live host runtime-service module. Construction captures ports; credentials remain lazy. */
import type { SessionExecutionVenue } from "@volli/shared";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";
import { piOwnedModelAccess, type PiModelAccess } from "@volli/agent-runtime";
import type { SessionEngine } from "@volli/session-engine";
import { createHostDecisions } from "./decision/host-decisions";
import { FileMcpCredentialStore, MCP_CREDENTIAL_FILE_NAME } from "./mcp/credential-store";
import { McpOAuthBroker } from "./mcp/oauth";
import { McpSettingsService } from "./mcp/settings";
import type { ClientCapabilityPort } from "./ports";
import {
  BRAVE_SEARCH_KEY_SECRET,
  EXA_SEARCH_KEY_SECRET,
  WebCredentialStore,
} from "./web/credential";
import { WebCredentialMirror, type WebMirrorResult } from "./web/credential-mirror";
import { WebAccessSettings } from "./web/settings";
import type { CredentialKeyring } from "./ports/credential-keyring";
import { CREDENTIAL_INVENTORY_FILE_NAME, SealedInventory } from "./secrets/inventory";

/** What the web keys' sealed mirror (VC-643, step E) is sealed with, and who hears how it went. */
export interface WebKeySealingOptions {
  /**
   * The host's key backend for the typed inventory: desktop's keychain
   * keyring. Absent or `null`: nothing is sealed and the keys stay in legacy
   * mode, reported as sealing pending.
   */
  keyring?: CredentialKeyring | null;
  /**
   * Whether the unattended launch reconcile may fetch an asynchronous
   * keyring's key (desktop: only once this launch already used the keychain).
   * A person's save or clear always may. Absent: never unattended.
   */
  mayUnlockUnattended?: () => boolean;
  /** Each reconciliation's outcome: counts and reason codes, never a value. */
  onResult?: (result: WebMirrorResult) => void;
}

export function createHostRuntimeServices(
  db: Database.Database,
  sessionEngine: SessionEngine,
  ports: { client: ClientCapabilityPort },
  options: {
    dbPath: string;
    modelAccess?: PiModelAccess;
    venue?: SessionExecutionVenue;
    webKeySealing?: WebKeySealingOptions;
  },
) {
  const modelAccess = options.modelAccess ?? piOwnedModelAccess();
  const venue = options.venue ?? { id: "local", kind: "local" };
  const decisions = createHostDecisions({
    db,
    models: modelAccess.models,
    catalogReady: modelAccess.catalogReady,
    recordUsage: async (sessionId, usage, purpose) => {
      await sessionEngine.observe({
        id: `usage:decision:${randomUUID()}`,
        kind: "usage.recorded",
        sessionId,
        occurredAt: Date.now(),
        provenance: {
          source: { kind: "system", id: "decision-service", detail: { purpose } },
          venue,
        },
        attachmentId: null,
        turnId: null,
        usage,
      });
    },
  });
  const credentials = new FileMcpCredentialStore(
    join(dirname(options.dbPath), MCP_CREDENTIAL_FILE_NAME),
  );
  const mcp = new McpSettingsService({
    db,
    credentials,
    oauth: new McpOAuthBroker({
      store: credentials,
      openExternal: (url) => ports.client.openExternal(url),
    }),
  });
  const webAccess = new WebAccessSettings({
    db,
    credentials: {
      brave: new WebCredentialStore({ db, secretName: BRAVE_SEARCH_KEY_SECRET }),
      exa: new WebCredentialStore({ db, secretName: EXA_SEARCH_KEY_SECRET }),
    },
    mirror: new WebCredentialMirror({
      db,
      inventory:
        options.webKeySealing?.keyring == null
          ? null
          : new SealedInventory({
              path: join(dirname(options.dbPath), CREDENTIAL_INVENTORY_FILE_NAME),
              keyring: options.webKeySealing.keyring,
              families: ["web-search"],
            }),
      keyring: options.webKeySealing?.keyring ?? null,
      ...(options.webKeySealing?.mayUnlockUnattended === undefined
        ? {}
        : { mayUnlockUnattended: options.webKeySealing.mayUnlockUnattended }),
      ...(options.webKeySealing?.onResult === undefined
        ? {}
        : { onResult: options.webKeySealing.onResult }),
    }),
  });
  return { modelAccess, decisions, mcp, webAccess };
}
export type HostRuntimeServices = ReturnType<typeof createHostRuntimeServices>;
