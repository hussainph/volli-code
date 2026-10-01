/**
 * Configure → MCP Servers (VC-470): the server list and the server dialog with
 * its tool picker, against catalogs the size and shape of real ones.
 *
 * - **Linear** — signed in, 24 tools labelled read-only or not, so the picker
 *   groups them. Open it to try Select all, the group checkboxes, the filter
 *   and On/Off.
 * - **GitHub** — a header secret that is missing: the row offers the fix.
 * - **Sentry** — needs sign-in; *Sign in* resolves after a beat.
 * - **Notes** — a local server that labels nothing (one plain list) and has
 *   one tool Volli cannot offer.
 * - **Docs** — off. **Flaky** — its last refresh failed.
 *
 * *Add server* connects to anything and comes back with Linear's catalog; an
 * address containing "sentry" asks for a sign-in first.
 */
import type {
  McpCatalogTool,
  McpServerAccess,
  McpServerRecord,
  McpToolHints,
  Project,
} from "@volli/shared";
import { mcpProviderToolName } from "@volli/shared";

import { McpPane } from "@renderer/components/settings/configure/mcp-pane";

import type { ApiOverrides } from "../fake-api";

export const title = "MCP servers — tools, sign-in and credentials";
export const note = "Server list, server dialog, tool picker with select all and groups";

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

interface ToolSpec {
  name: string;
  title?: string;
  description: string;
  readOnly?: boolean;
  destructive?: boolean;
  params?: Record<string, string>;
  required?: readonly string[];
  on?: boolean;
  error?: string;
}

function tools(serverId: string, serverName: string, specs: readonly ToolSpec[]): McpCatalogTool[] {
  return specs.map((spec) => {
    const hints: McpToolHints = {
      ...(spec.title === undefined ? {} : { title: spec.title }),
      ...(spec.readOnly === undefined ? {} : { readOnly: spec.readOnly }),
      ...(spec.destructive === undefined ? {} : { destructive: spec.destructive }),
    };
    return {
      name: spec.name,
      description: spec.description,
      enabled: spec.on === true && spec.error === undefined,
      definition:
        spec.error === undefined
          ? {
              serverId,
              toolName: spec.name,
              providerName: mcpProviderToolName(serverId, serverName, spec.name),
              description: spec.description,
              inputSchema: {
                type: "object",
                properties: Object.fromEntries(
                  Object.entries(spec.params ?? {}).map(([name, type]) => [name, { type }]),
                ),
                required: [...(spec.required ?? [])],
              },
            }
          : null,
      error: spec.error ?? null,
      ...(Object.keys(hints).length === 0 ? {} : { hints }),
    };
  });
}

const LINEAR: ToolSpec[] = [
  {
    name: "list_issues",
    title: "List issues",
    description:
      "List issues in the user's Linear workspace, filtered by team, assignee, state, label, cycle or project, newest first.",
    readOnly: true,
    on: true,
    params: {
      query: "string",
      team: "string",
      assignee: "string",
      state: "string",
      limit: "number",
    },
  },
  {
    name: "get_issue",
    title: "Get issue",
    description:
      "Retrieve a Linear issue by its identifier, with its description, comments, attachments, relations and sub-issues.",
    readOnly: true,
    on: true,
    params: { id: "string" },
    required: ["id"],
  },
  {
    name: "list_comments",
    title: "List comments",
    description: "List the comments on a specific Linear issue, oldest first.",
    readOnly: true,
    on: true,
    params: { issueId: "string" },
    required: ["issueId"],
  },
  {
    name: "list_projects",
    title: "List projects",
    description:
      "List projects in the workspace, optionally filtered by team, lead, state or initiative.",
    readOnly: true,
    params: { team: "string", state: "string" },
  },
  {
    name: "get_project",
    title: "Get project",
    description: "Retrieve a project by name or id, with its milestones, members and progress.",
    readOnly: true,
    params: { query: "string" },
    required: ["query"],
  },
  {
    name: "list_teams",
    title: "List teams",
    description: "List the teams in the user's Linear workspace.",
    readOnly: true,
  },
  {
    name: "get_team",
    title: "Get team",
    description: "Retrieve a team by name, key or id.",
    readOnly: true,
    params: { query: "string" },
    required: ["query"],
  },
  {
    name: "list_users",
    title: "List users",
    description: "List users in the workspace, optionally filtered by team or name.",
    readOnly: true,
    params: { team: "string", query: "string" },
  },
  {
    name: "get_user",
    title: "Get user",
    description: "Retrieve a user by name, email or id. Pass 'me' for the signed-in user.",
    readOnly: true,
    params: { query: "string" },
    required: ["query"],
  },
  {
    name: "list_issue_statuses",
    title: "List issue statuses",
    description: "List the workflow states available to a team.",
    readOnly: true,
    params: { team: "string" },
    required: ["team"],
  },
  {
    name: "list_issue_labels",
    title: "List issue labels",
    description: "List the issue labels in a workspace or team.",
    readOnly: true,
    params: { team: "string" },
  },
  {
    name: "list_cycles",
    title: "List cycles",
    description: "List a team's cycles: the current one, upcoming ones and recent ones.",
    readOnly: true,
    params: { teamId: "string", type: "string" },
    required: ["teamId"],
  },
  {
    name: "list_documents",
    title: "List documents",
    description: "List documents in the workspace, optionally filtered by project or creator.",
    readOnly: true,
    params: { project: "string" },
  },
  {
    name: "get_document",
    title: "Get document",
    description: "Retrieve a Linear document by id or slug, with its full content.",
    readOnly: true,
    params: { id: "string" },
    required: ["id"],
  },
  {
    name: "search_documentation",
    title: "Search Linear docs",
    description: "Search Linear's own product documentation, to learn how a feature works.",
    readOnly: true,
    params: { query: "string" },
    required: ["query"],
  },
  {
    name: "create_issue",
    title: "Create issue",
    description:
      "Create a new issue in a team, with a title, description in Markdown, assignee, priority, labels, project and parent.",
    readOnly: false,
    destructive: false,
    params: {
      title: "string",
      team: "string",
      description: "string",
      assignee: "string",
      priority: "number",
      labels: "array",
    },
    required: ["title", "team"],
  },
  {
    name: "update_issue",
    title: "Update issue",
    description:
      "Update an existing issue: its title, description, state, assignee, priority, labels, estimate, project or cycle.",
    readOnly: false,
    destructive: false,
    params: { id: "string", title: "string", state: "string", assignee: "string" },
    required: ["id"],
  },
  {
    name: "create_comment",
    title: "Comment on issue",
    description: "Add a comment, in Markdown, to an issue. Can reply in a thread.",
    readOnly: false,
    destructive: false,
    params: { issueId: "string", body: "string", parentId: "string" },
    required: ["issueId", "body"],
  },
  {
    name: "create_project",
    title: "Create project",
    description:
      "Create a project in one or more teams, with a summary, description, lead and target date.",
    readOnly: false,
    destructive: false,
    params: { name: "string", team: "string" },
    required: ["name", "team"],
  },
  {
    name: "update_project",
    title: "Update project",
    description: "Update a project's name, summary, description, state, lead, dates or members.",
    readOnly: false,
    destructive: false,
    params: { id: "string" },
    required: ["id"],
  },
  {
    name: "create_issue_label",
    title: "Create label",
    description: "Create an issue label in the workspace or in one team.",
    readOnly: false,
    destructive: false,
    params: { name: "string", color: "string" },
    required: ["name"],
  },
  {
    name: "create_document",
    title: "Create document",
    description: "Create a document in a project, with a title and Markdown content.",
    readOnly: false,
    destructive: false,
    params: { title: "string", project: "string", content: "string" },
    required: ["title"],
  },
  {
    name: "delete_comment",
    title: "Delete comment",
    description: "Delete a comment from an issue. The comment cannot be restored.",
    readOnly: false,
    destructive: true,
    params: { id: "string" },
    required: ["id"],
  },
  {
    name: "archive_issue",
    title: "Archive issue",
    description:
      "Archive an issue. Archived issues leave every view and can only be restored from the archive.",
    readOnly: false,
    destructive: true,
    params: { id: "string" },
    required: ["id"],
  },
];

const GITHUB: ToolSpec[] = [
  "search_code",
  "search_issues",
  "get_pull_request",
  "list_pull_requests",
  "get_file_contents",
  "list_commits",
  "create_pull_request",
  "merge_pull_request",
  "create_issue",
  "add_issue_comment",
].map((name, index) => ({
  name,
  description: `${name.replaceAll("_", " ")} in a GitHub repository.`,
  readOnly: index < 6,
  on: index < 2,
}));

const NOTES: ToolSpec[] = [
  {
    name: "search_notes",
    description: "Full-text search across every note in the vault.",
    on: true,
    params: { query: "string" },
    required: ["query"],
  },
  {
    name: "read_note",
    description: "Read one note by its path, as Markdown.",
    on: true,
    params: { path: "string" },
    required: ["path"],
  },
  {
    name: "append_note",
    description: "Append Markdown to the end of a note, creating it if it does not exist.",
    params: { path: "string", text: "string" },
    required: ["path", "text"],
  },
  {
    name: "render_graph",
    description: "Render the vault's link graph.",
    error: "input schema exceeds the 2048-node limit",
  },
];

function server(
  id: string,
  name: string,
  transport: McpServerRecord["transport"],
  specs: readonly ToolSpec[],
  overrides: Partial<McpServerRecord> = {},
): McpServerRecord {
  return {
    id,
    projectId: project.id,
    name,
    enabled: true,
    transport,
    provenance: { source: null, registryType: null, version: null, digest: null },
    catalog: tools(id, name, specs),
    stale: false,
    error: null,
    refreshedAt: Date.now() - 600_000,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

let SERVERS: McpServerRecord[] = [
  server(
    "linear",
    "Linear",
    { type: "streamable-http", url: "https://mcp.linear.app/mcp" },
    LINEAR,
  ),
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
    GITHUB,
  ),
  server("sentry", "Sentry", { type: "streamable-http", url: "https://mcp.sentry.dev/mcp" }, [
    {
      name: "search_issues",
      title: "Search issues",
      description: "Search Sentry issues with a natural-language query.",
      readOnly: true,
      on: true,
    },
    {
      name: "get_issue_details",
      title: "Issue details",
      description: "Get the stack trace, tags and recent events of one issue.",
      readOnly: true,
    },
    {
      name: "update_issue",
      title: "Update issue",
      description: "Resolve, ignore or assign an issue.",
      readOnly: false,
    },
  ]),
  server(
    "notes",
    "Notes",
    {
      type: "stdio",
      command: "npx",
      args: ["-y", "@acme/notes-mcp", "--vault", "~/Notes"],
      env: [{ name: "NOTES_TOKEN", source: { kind: "reference", template: "${NOTES_TOKEN}" } }],
    },
    NOTES,
    {
      provenance: {
        source: "io.github.acme/notes-mcp",
        registryType: "npm",
        version: "1.4.2",
        digest: null,
      },
    },
  ),
  server(
    "docs",
    "Docs",
    { type: "streamable-http", url: "https://docs.example.com/mcp" },
    [{ name: "search", description: "Search the docs.", readOnly: true, on: true }],
    { enabled: false },
  ),
  server(
    "flaky",
    "Flaky",
    { type: "stdio", command: "uvx", args: ["flaky-mcp"] },
    [{ name: "ping", description: "Ping.", on: true }],
    {
      stale: true,
      error: "Could not refresh Flaky: the server closed the connection before answering.",
      refreshedAt: Date.now() - 3 * 86_400_000,
    },
  ),
];

const access: Record<string, McpServerAccess> = {
  linear: { signIn: "signed-in", missingSecrets: [] },
  github: { signIn: "not-applicable", missingSecrets: ["header Authorization"] },
  sentry: { signIn: "needs-sign-in", missingSecrets: [] },
  notes: { signIn: "not-applicable", missingSecrets: [] },
  docs: { signIn: "signed-out", missingSecrets: [] },
  flaky: { signIn: "not-applicable", missingSecrets: [] },
};

function put(record: McpServerRecord): McpServerRecord {
  SERVERS = SERVERS.some((candidate) => candidate.id === record.id)
    ? SERVERS.map((candidate) => (candidate.id === record.id ? record : candidate))
    : [...SERVERS, record];
  return record;
}

/** A catalog with exactly `enabled` turned on. */
function withEnabled(
  catalog: readonly McpCatalogTool[],
  enabled: ReadonlySet<string>,
): McpCatalogTool[] {
  return catalog.map((tool) => Object.assign({}, tool, { enabled: enabled.has(tool.name) }));
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Drafts that have signed in, so their next Connect succeeds. */
const draftsSignedIn = new Set<string>();

export const api: ApiOverrides = {
  mcp: {
    list: async () => ({ ok: true, servers: SERVERS, operations: [], access }),
    test: async (input: { server: McpServerRecord }) => {
      await pause(700);
      // Any address with "sentry" in it wants a sign-in first, once.
      if (
        input.server.transport.type === "streamable-http" &&
        input.server.transport.url.includes("sentry") &&
        !draftsSignedIn.has(input.server.id)
      ) {
        return {
          ok: false,
          error: `${input.server.name} needs a person to sign in.`,
          blocked: { kind: "sign-in", insufficientScope: false },
        };
      }
      return {
        ok: true,
        catalog: withEnabled(tools(input.server.id, input.server.name, LINEAR), new Set()),
      };
    },
    save: async (input: { server: McpServerRecord; enabledTools: readonly string[] }) => {
      await pause(500);
      const enabled = new Set(input.enabledTools);
      const catalog = withEnabled(tools(input.server.id, input.server.name, LINEAR), enabled);
      access[input.server.id] ??= { signIn: "not-applicable", missingSecrets: [] };
      return {
        ok: true,
        server: put({
          ...server(input.server.id, input.server.name, input.server.transport, []),
          ...input.server,
          catalog,
          refreshedAt: Date.now(),
        }),
      };
    },
    setTools: async (input: { serverId: string; enabledTools: readonly string[] }) => {
      await pause(200);
      const enabled = new Set(input.enabledTools);
      const current = SERVERS.find((candidate) => candidate.id === input.serverId)!;
      return {
        ok: true,
        server: put({
          ...current,
          catalog: withEnabled(current.catalog, enabled),
        }),
      };
    },
    setEnabled: async (input: { serverId: string; enabled: boolean }) => {
      await pause(150);
      const current = SERVERS.find((candidate) => candidate.id === input.serverId)!;
      return { ok: true, server: put({ ...current, enabled: input.enabled }) };
    },
    refresh: async (input: { serverId: string }) => {
      await pause(600);
      const current = SERVERS.find((candidate) => candidate.id === input.serverId)!;
      return {
        ok: true,
        server: put({ ...current, stale: false, error: null, refreshedAt: Date.now() }),
      };
    },
    remove: async (input: { serverId: string }) => {
      SERVERS = SERVERS.filter((candidate) => candidate.id !== input.serverId);
      return { ok: true };
    },
    signIn: async (input: { serverId?: string; server?: McpServerRecord }) => {
      await pause(1_500);
      if (input.serverId !== undefined)
        access[input.serverId] = { signIn: "signed-in", missingSecrets: [] };
      if (input.server !== undefined) draftsSignedIn.add(input.server.id);
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
    <div className="max-w-5xl">
      <McpPane project={project} />
    </div>
  );
}
