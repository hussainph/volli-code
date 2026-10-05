/** One live host runtime-service module. Construction captures ports; credentials remain lazy. */
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
import type { ClientCapabilityPort } from "./ports";
import {
  BRAVE_SEARCH_KEY_SECRET,
  EXA_SEARCH_KEY_SECRET,
  WebCredentialStore,
} from "./web/credential";
import { WebAccessSettings } from "./web/settings";

export function createHostRuntimeServices(
  db: Database.Database,
  sessionEngine: SessionEngine,
  ports: { client: ClientCapabilityPort },
  options: { dbPath: string; modelAccess?: PiModelAccess; venue?: SessionExecutionVenue },
) {
  const modelAccess = options.modelAccess ?? piOwnedModelAccess();
  const venue = options.venue ?? { id: "local", kind: "local" };
  const decisions = createDesktopDecisions({
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
  });
  return { modelAccess, decisions, mcp, webAccess };
}
export type HostRuntimeServices = ReturnType<typeof createHostRuntimeServices>;
