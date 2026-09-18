import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  MCP_DESCRIPTION_MAX_CHARS,
  MCP_ERROR_MAX_CHARS,
  MCP_TOOL_NAME_MAX_CHARS,
  mcpProviderToolName,
  type McpServerRecord,
} from "@volli/shared";

import {
  deleteMcpServer,
  getMcpServer,
  listMcpServers,
  markMcpServerRefreshFailure,
  putMcpServer,
  selectedMcpToolDefinitions,
} from "./mcp-servers-repo";
import { insertProject } from "./projects-repo";
import { openTestDb, testProject, type TestDb } from "./test-helpers";

let ctx: TestDb;

beforeEach(() => {
  ctx = openTestDb();
  insertProject(ctx.db, testProject({ id: "p1", name: "Project", path: "/repo/project" }));
});

afterEach(() => ctx.cleanup());

function record(overrides: Partial<McpServerRecord> = {}): McpServerRecord {
  const definition = {
    serverId: overrides.id ?? "server-1",
    toolName: "echo",
    providerName: mcpProviderToolName(overrides.id ?? "server-1", "Fixture", "echo"),
    description: "Echo input",
    inputSchema: { type: "object", properties: { text: { type: "string" } } } as const,
  };
  return {
    id: "server-1",
    projectId: "p1",
    name: "Fixture",
    enabled: true,
    transport: { type: "stdio", command: "node", args: ["fixture.mjs"] },
    catalog: [
      { name: "echo", description: "Echo input", enabled: true, definition, error: null },
      {
        name: "bad",
        description: "Unsupported",
        enabled: false,
        definition: null,
        error: 'input schema root type must be "object"',
      },
    ],
    provenance: { source: null, registryType: null, version: null, digest: null },
    stale: false,
    error: null,
    refreshedAt: 100,
    createdAt: 10,
    updatedAt: 100,
    ...overrides,
  };
}

describe("MCP server repository", () => {
  it("stores project-owned configuration and its last working catalog without a repository file", () => {
    putMcpServer(ctx.db, record());

    expect(listMcpServers(ctx.db, "p1")).toEqual([record()]);
    expect(getMcpServer(ctx.db, "server-1")).toEqual(record());
  });

  it("marks a failed refresh stale while preserving the last working catalog", () => {
    putMcpServer(ctx.db, record());

    const failed = markMcpServerRefreshFailure(ctx.db, "server-1", "Handshake failed.", 200);

    expect(failed).toEqual({
      ...record(),
      stale: true,
      error: "Handshake failed.",
      updatedAt: 200,
    });
    expect(getMcpServer(ctx.db, "server-1")?.catalog).toEqual(record().catalog);
  });

  it("selects only explicitly enabled valid tools from enabled servers in stable server/catalog order", () => {
    putMcpServer(ctx.db, record());
    putMcpServer(
      ctx.db,
      record({
        id: "server-2",
        name: "Other",
        createdAt: 20,
        catalog: record({ id: "server-2" }).catalog.map((tool) =>
          Object.assign({}, tool, { enabled: false }),
        ),
      }),
    );
    putMcpServer(ctx.db, record({ id: "server-3", enabled: false, createdAt: 30 }));

    expect(selectedMcpToolDefinitions(ctx.db, "p1").map((tool) => tool.serverId)).toEqual([
      "server-1",
    ]);
  });

  it("refuses oversized untrusted catalog and server error text read from storage", () => {
    putMcpServer(ctx.db, record());
    const unavailable = record().catalog[1]!;
    const oversizedEntries = [
      { ...unavailable, name: "n".repeat(MCP_TOOL_NAME_MAX_CHARS + 1) },
      { ...unavailable, description: "d".repeat(MCP_DESCRIPTION_MAX_CHARS + 1) },
      { ...unavailable, error: "e".repeat(MCP_ERROR_MAX_CHARS + 1) },
    ];

    for (const entry of oversizedEntries) {
      ctx.db
        .prepare("UPDATE mcp_servers SET catalog = ? WHERE id = ?")
        .run(JSON.stringify([entry]), "server-1");
      expect(() => getMcpServer(ctx.db, "server-1")).toThrow(/catalog entry 0 is invalid/i);
    }

    ctx.db
      .prepare("UPDATE mcp_servers SET catalog = ?, error = ? WHERE id = ?")
      .run(JSON.stringify(record().catalog), "e".repeat(MCP_ERROR_MAX_CHARS + 1), "server-1");
    expect(() => getMcpServer(ctx.db, "server-1")).toThrow(/server error is invalid/i);
  });

  it("cascades servers with their project and supports explicit removal", () => {
    putMcpServer(ctx.db, record());
    expect(deleteMcpServer(ctx.db, "p1", "server-1")).toBe(true);
    expect(deleteMcpServer(ctx.db, "p1", "server-1")).toBe(false);

    putMcpServer(ctx.db, record());
    ctx.db.prepare("DELETE FROM projects WHERE id = ?").run("p1");
    expect(listMcpServers(ctx.db, "p1")).toEqual([]);
  });
});

describe("MCP server provenance (VC-380)", () => {
  it("round-trips where a configuration came from, beside the catalog it discovered", () => {
    const provenance = {
      source: "registry.modelcontextprotocol.io/io.github.acme/files",
      registryType: "npm" as const,
      version: "1.4.2",
      digest: "sha256:2f0c1d",
    };

    putMcpServer(ctx.db, record({ provenance }));

    expect(getMcpServer(ctx.db, "server-1")?.provenance).toEqual(provenance);
    expect(listMcpServers(ctx.db, "p1")[0]?.provenance).toEqual(provenance);
  });

  it("refuses to store provenance it could not read back honestly", () => {
    expect(() =>
      putMcpServer(
        ctx.db,
        record({
          provenance: {
            source: "tail\nsecret",
            registryType: null,
            version: null,
            digest: null,
          },
        }),
      ),
    ).toThrow(/provenance source is invalid/);
  });

  it("keeps recorded provenance across a failed refresh, which changed nothing about origin", () => {
    putMcpServer(
      ctx.db,
      record({
        provenance: { source: "npm", registryType: "npm", version: "1.0.0", digest: null },
      }),
    );

    const failed = markMcpServerRefreshFailure(ctx.db, "server-1", "Handshake failed.", 200);

    expect(failed?.provenance).toEqual({
      source: "npm",
      registryType: "npm",
      version: "1.0.0",
      digest: null,
    });
  });
});
