/**
 * Staged runtime-service construction (VC-555). Desktop calls these at the
 * same points in its boot sequence as before: legacy key migration stays in
 * the host, ahead of Web Access, and sign-in is wired after the runtime.
 * Construction captures ports; none of these services is opened at boot until
 * its factory is called.
 */
import type { SessionExecutionVenue } from "@volli/shared";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";
import { piOwnedModelAccess, type PiModelAccess } from "@volli/agent-runtime";
import type { SessionEngine } from "@volli/session-engine";
import { createDesktopDecisions } from "./decision/desktop";
import { FileMcpCredentialStore, MCP_CREDENTIAL_FILE_NAME } from "./mcp/credential-store";
import { McpOAuthBroker } from "./mcp/oauth";
import { McpSettingsService } from "./mcp/settings";
import { ModelAccessSignInService } from "./model-access/sign-in-service";
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
  /** Each reconciliation's outcome: counts and reason codes, never a value. */
  onResult?: (result: WebMirrorResult) => void;
}

export function createHostRuntimeServices(
  db: Database.Database | null,
  sessionEngine: SessionEngine | null,
  ports: { client: ClientCapabilityPort },
  options: { dbPath: string },
) {
  return {
    createModelAccess: () => (db === null ? null : piOwnedModelAccess()),
    createDecisions: (
      modelAccess: PiModelAccess | null,
      venue: SessionExecutionVenue = { id: "local", kind: "local" },
    ) =>
      db !== null && modelAccess !== null
        ? createDesktopDecisions({
            db,
            models: modelAccess.models,
            catalogReady: modelAccess.catalogReady,
            recordUsage: async (sessionId, usage, purpose) => {
              if (sessionEngine === null) return;
              await sessionEngine.observe({
                // A fresh id per call: every decision is its own bill.
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
          })
        : null,
    createMcp: () => {
      const credentials = new FileMcpCredentialStore(
        join(dirname(options.dbPath), MCP_CREDENTIAL_FILE_NAME),
      );
      const settings =
        db === null
          ? null
          : new McpSettingsService({
              db,
              credentials,
              oauth: new McpOAuthBroker({
                store: credentials,
                // Only an authorization page already checked by the broker.
                openExternal: (url) => ports.client.openExternal(url),
              }),
            });
      return { credentials, settings };
    },
    createWebAccess: (sealing: WebKeySealingOptions = {}) =>
      db === null
        ? null
        : new WebAccessSettings({
            db,
            credentials: {
              brave: new WebCredentialStore({ db, secretName: BRAVE_SEARCH_KEY_SECRET }),
              exa: new WebCredentialStore({ db, secretName: EXA_SEARCH_KEY_SECRET }),
            },
            mirror: new WebCredentialMirror({
              db,
              inventory:
                sealing.keyring == null
                  ? null
                  : new SealedInventory({
                      path: join(dirname(options.dbPath), CREDENTIAL_INVENTORY_FILE_NAME),
                      keyring: sealing.keyring,
                      families: ["web-search"],
                    }),
              ...(sealing.onResult === undefined ? {} : { onResult: sealing.onResult }),
            }),
          }),
    createSignIn: (input: ConstructorParameters<typeof ModelAccessSignInService>[0]) =>
      new ModelAccessSignInService(input),
  };
}

export type HostRuntimeServices = ReturnType<typeof createHostRuntimeServices>;
