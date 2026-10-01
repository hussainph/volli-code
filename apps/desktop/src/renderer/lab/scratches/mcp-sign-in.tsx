/**
 * Configure → MCP Servers with credentials (VC-470): a remote server that
 * needs sign-in, one signed in, one keyed by a header secret that is missing,
 * and a local server with a reference in its environment. Open *Edit* on any
 * row to see the credential editor; *Sign in* resolves after a beat.
 */
import type { McpCatalogTool, McpServerAccess, McpServerRecord, Project } from "@volli/shared";
import { mcpProviderToolName } from "@volli/shared";

import { McpPane } from "@renderer/components/settings/configure/mcp-pane";

import type { ApiOverrides } from "../fake-api";

export const title = "MCP servers — sign-in and credentials";
export const note = "Needs sign-in, signed in, a missing header secret, an env reference";

const project: Project = {
  id: "lab-project",
  name: "Lab",
  path: "/repo/lab",
  ticketPrefix: "LAB",
  colorIndex: 0,
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0,
};

function tools(serverId: string, serverName: string, names: readonly string[]): McpCatalogTool[] {
  return names.map((name, index) => ({
    name,
    description: `${name.replaceAll("_", " ")} — from ${serverName}`,
    enabled: index === 0,
    definition: {
      serverId,
      toolName: name,
      providerName: mcpProviderToolName(serverId, serverName, name),
      description: name,
      inputSchema: { type: "object" },
    },
    error: null,
  }));
}

function server(
  id: string,
  name: string,
  transport: McpServerRecord["transport"],
  names: readonly string[],
): McpServerRecord {
  return {
    id,
    projectId: project.id,
    name,
    enabled: true,
    transport,
    provenance: { source: null, registryType: null, version: null, digest: null },
    catalog: tools(id, name, names),
    stale: false,
    error: null,
    refreshedAt: Date.now() - 600_000,
    createdAt: 1,
    updatedAt: 1,
  };
}

const SERVERS: McpServerRecord[] = [
  server("sentry", "Sentry", { type: "streamable-http", url: "https://mcp.sentry.dev/mcp" }, [
    "search_issues",
    "get_issue_details",
    "find_organizations",
  ]),
  server("linear", "Linear", { type: "streamable-http", url: "https://mcp.linear.app/mcp" }, [
    "list_issues",
    "create_issue",
  ]),
  server(
    "github",
    "GitHub",
    {
      type: "streamable-http",
      url: "https://api.githubcopilot.com/mcp/",
      headers: [
        { name: "Authorization", source: { kind: "secret" } },
        { name: "X-MCP-Toolsets", source: { kind: "reference", template: "${GITHUB_TOOLSETS}" } },
      ],
    },
    ["search_code", "get_pull_request"],
  ),
  server(
    "tools",
    "Tools",
    {
      type: "stdio",
      command: "uvx",
      args: ["tools-mcp"],
      env: [{ name: "API_KEY", source: { kind: "reference", template: "${TOOLS_KEY}" } }],
    },
    ["lookup"],
  ),
];

const access: Record<string, McpServerAccess> = {
  sentry: { signIn: "needs-sign-in", missingSecrets: [] },
  linear: { signIn: "signed-in", missingSecrets: [] },
  github: { signIn: "not-applicable", missingSecrets: ["header Authorization"] },
  tools: { signIn: "not-applicable", missingSecrets: [] },
};

export const api: ApiOverrides = {
  mcp: {
    list: async () => ({ ok: true, servers: SERVERS, operations: [], access }),
    test: async () => ({ ok: true, catalog: SERVERS[0]!.catalog }),
    save: async (input: { server: McpServerRecord }) => ({
      ok: true,
      server: { ...SERVERS[0]!, ...input.server },
    }),
    signIn: async (input: { serverId?: string }) => {
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      if (input.serverId !== undefined)
        access[input.serverId] = { signIn: "signed-in", missingSecrets: [] };
      return { ok: true, message: "Signed in." };
    },
    cancelSignIn: async () => ({ ok: true }),
    signOut: async (input: { serverId: string }) => {
      access[input.serverId] = { signIn: "signed-out", missingSecrets: [] };
      return { ok: true };
    },
    discardDraft: async () => ({ ok: true }),
  },
};

export default function McpSignInScratch() {
  return (
    <div className="max-w-4xl">
      <McpPane project={project} />
    </div>
  );
}
