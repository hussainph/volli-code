import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  MCP_DESCRIPTION_MAX_CHARS,
  MCP_ERROR_MAX_CHARS,
  MCP_TOOL_NAME_MAX_CHARS,
  mcpProviderToolName,
  type McpServerRecord,
} from "@volli/shared";

import {
  deleteGlobalMcpServer,
  getGlobalMcpServer,
  listGlobalMcpServers,
  putGlobalMcpServer,
  globalMcpServerIds,
  deleteMcpServer,
  getMcpServer,
  listMcpServers,
  markMcpServerRefreshFailure,
  putMcpServer,
  selectedMcpToolDefinitions,
} from "./mcp-servers-repo";
import { insertProject } from "./projects-repo";
import { openRawDb, openTestDb, testProject, type TestDb } from "./test-helpers";

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

  it("round-trips a tool's display hints, and drops stored hints it cannot read without refusing the row", () => {
    const labelled = record();
    const [echo, bad] = labelled.catalog;
    putMcpServer(
      ctx.db,
      record({
        catalog: [
          { ...echo!, hints: { title: "Echo text", readOnly: true, destructive: false } },
          bad!,
        ],
      }),
    );
    expect(getMcpServer(ctx.db, "server-1")?.catalog.map((tool) => tool.hints)).toEqual([
      { title: "Echo text", readOnly: true, destructive: false },
      undefined,
    ]);

    ctx.db.prepare("UPDATE mcp_servers SET catalog = ? WHERE id = ?").run(
      JSON.stringify([
        { ...echo!, hints: { title: "Echo\u202e", readOnly: "yes", destructive: true } },
        { ...bad!, hints: ["read-only"] },
      ]),
      "server-1",
    );
    expect(getMcpServer(ctx.db, "server-1")?.catalog.map((tool) => tool.hints)).toEqual([
      { title: "Echo", destructive: true },
      undefined,
    ]);
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

describe("machine-wide MCP fold-in", () => {
  function otherProject() {
    insertProject(ctx.db, testProject({ id: "p2", name: "Other project", path: "/repo/other" }));
  }

  it("unions project rows, deduplicates identical definitions and retains conflicting names", () => {
    otherProject();
    putMcpServer(ctx.db, record());
    putMcpServer(
      ctx.db,
      record({
        id: "same",
        projectId: "p2",
        catalog: record({ id: "same" }).catalog,
        createdAt: 20,
      }),
    );
    putMcpServer(
      ctx.db,
      record({
        id: "different",
        projectId: "p2",
        transport: { type: "stdio", command: "uvx", args: ["other"] },
        catalog: [],
        createdAt: 30,
      }),
    );
    expect(listGlobalMcpServers(ctx.db).map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "server-1", name: "Fixture" },
      { id: "different", name: "Fixture (Other project)" },
    ]);
    expect(globalMcpServerIds(ctx.db, "server-1")).toEqual(["server-1", "same"]);
    // The old real row codec still reads every original configuration and id.
    expect(listMcpServers(ctx.db, "p2").map(({ name }) => name)).toEqual(["Fixture", "Fixture"]);
    expect(getGlobalMcpServer(ctx.db, "same")).toEqual(
      record({
        id: "same",
        projectId: "p2",
        catalog: record({ id: "same" }).catalog,
        createdAt: 20,
      }),
    );
    // A second process/handle reads the durable fold, not an in-memory cache.
    const reopened = openRawDb(ctx.dbPath);
    try {
      expect(listGlobalMcpServers(reopened)).toEqual(listGlobalMcpServers(ctx.db));
    } finally {
      reopened.close();
    }
  });

  it("deduplicates a conflicting definition even after giving it a distinguishing name", () => {
    otherProject();
    putMcpServer(ctx.db, record({ catalog: [] }));
    const transport = { type: "streamable-http" as const, url: "https://tools.example/mcp" };
    putMcpServer(
      ctx.db,
      record({ id: "remote", projectId: "p2", transport, catalog: [], createdAt: 20 }),
    );
    listGlobalMcpServers(ctx.db);
    putMcpServer(
      ctx.db,
      record({ id: "remote-copy", projectId: "p1", transport, catalog: [], createdAt: 30 }),
    );
    expect(listGlobalMcpServers(ctx.db)).toHaveLength(2);
    expect(globalMcpServerIds(ctx.db, "remote")).toEqual(["remote", "remote-copy"]);
  });

  it("unions enabled tool selections without changing either legacy catalog", () => {
    otherProject();
    putMcpServer(
      ctx.db,
      record({
        enabled: false,
        catalog: record().catalog.map((tool) => Object.assign({}, tool, { enabled: false })),
      }),
    );
    putMcpServer(
      ctx.db,
      record({
        id: "same",
        projectId: "p2",
        catalog: record({ id: "same" }).catalog,
        createdAt: 20,
      }),
    );
    const [server] = listGlobalMcpServers(ctx.db);
    expect(server?.enabled).toBe(true);
    expect(server?.catalog[0]?.enabled).toBe(true);
    expect(getMcpServer(ctx.db, "server-1")?.enabled).toBe(false);
    expect(getGlobalMcpServer(ctx.db, "same")?.catalog[0]?.definition?.serverId).toBe("same");
  });

  it("does not merge different arguments or credential references at the same command or URL", () => {
    otherProject();
    putMcpServer(ctx.db, record());
    putMcpServer(
      ctx.db,
      record({
        id: "args",
        projectId: "p2",
        transport: { type: "stdio", command: "node", args: ["other.mjs"] },
        catalog: [],
      }),
    );
    expect(listGlobalMcpServers(ctx.db)).toHaveLength(2);
  });

  it("reads machine records from before legacy fingerprints without losing the imported union", () => {
    otherProject();
    putMcpServer(ctx.db, record({ enabled: false }));
    putMcpServer(
      ctx.db,
      record({ id: "same", projectId: "p2", catalog: record({ id: "same" }).catalog }),
    );
    const before = listGlobalMcpServers(ctx.db);
    const raw = ctx.db
      .prepare("SELECT value FROM app_state WHERE key = 'volli:mcp-global'")
      .get() as { value: string };
    const state = JSON.parse(raw.value);
    delete state.legacy;
    ctx.db
      .prepare("UPDATE app_state SET value = ? WHERE key = 'volli:mcp-global'")
      .run(JSON.stringify(state));

    expect(listGlobalMcpServers(ctx.db)).toEqual(before);
    expect(getMcpServer(ctx.db, "server-1")?.enabled).toBe(false);
    expect(getGlobalMcpServer(ctx.db, "same")?.id).toBe("same");
  });

  it("observes legacy endpoint and credential-reference edits even when their timestamps are unchanged", () => {
    putMcpServer(ctx.db, record());
    const [original] = listGlobalMcpServers(ctx.db);
    const transport = {
      type: "streamable-http" as const,
      url: "https://changed.example/mcp",
      headers: [{ name: "Authorization", source: { kind: "secret" as const } }],
    };
    putMcpServer(ctx.db, { ...original!, transport });

    expect(getGlobalMcpServer(ctx.db, "server-1")?.transport).toEqual(transport);
    expect(listGlobalMcpServers(ctx.db)[0]?.transport).toEqual(transport);
  });

  it("keeps deduped selections across reads and mirrors, but observes an edited alias without borrowing its credentials", () => {
    otherProject();
    putMcpServer(ctx.db, record({ enabled: false }));
    putMcpServer(
      ctx.db,
      record({ id: "same", projectId: "p2", catalog: record({ id: "same" }).catalog }),
    );
    const [global] = listGlobalMcpServers(ctx.db);
    expect(global?.enabled).toBe(true);
    expect(listGlobalMcpServers(ctx.db)[0]?.enabled).toBe(true);
    putGlobalMcpServer(ctx.db, { ...global!, updatedAt: 200 });
    expect(listGlobalMcpServers(ctx.db)[0]?.enabled).toBe(true);

    const transport = { type: "streamable-http" as const, url: "https://alias.example/mcp" };
    putMcpServer(ctx.db, { ...getMcpServer(ctx.db, "same")!, transport });
    expect(getGlobalMcpServer(ctx.db, "same")?.transport).toEqual(transport);
    expect(getGlobalMcpServer(ctx.db, "server-1")?.transport).toEqual(global?.transport);
  });

  it("mirrors edits for N-1, keeps frozen duplicate ids, and survives deleting the source project", () => {
    otherProject();
    putMcpServer(ctx.db, record());
    putMcpServer(
      ctx.db,
      record({
        id: "same",
        projectId: "p2",
        catalog: record({ id: "same" }).catalog,
        createdAt: 20,
      }),
    );
    const [global] = listGlobalMcpServers(ctx.db);
    putGlobalMcpServer(ctx.db, { ...global!, enabled: false, updatedAt: 200 });
    expect(getMcpServer(ctx.db, "server-1")?.enabled).toBe(false);
    expect(getMcpServer(ctx.db, "same")?.enabled).toBe(false);
    ctx.db.prepare("DELETE FROM projects").run();
    expect(listGlobalMcpServers(ctx.db)).toHaveLength(1);
    expect(getGlobalMcpServer(ctx.db, "same")?.catalog[0]?.definition?.serverId).toBe("same");
    expect(getGlobalMcpServer(ctx.db, "same")?.enabled).toBe(false);
  });

  it("removes every alias and never resurrects an imported row", () => {
    otherProject();
    putMcpServer(ctx.db, record());
    putMcpServer(
      ctx.db,
      record({
        id: "same",
        projectId: "p2",
        catalog: record({ id: "same" }).catalog,
        createdAt: 20,
      }),
    );
    listGlobalMcpServers(ctx.db);
    expect(deleteGlobalMcpServer(ctx.db, "server-1")).toEqual(["server-1", "same"]);
    expect(getGlobalMcpServer(ctx.db, "same")).toBeUndefined();
    // Even a retained row restored by an N-1 build is not re-imported.
    putMcpServer(ctx.db, record());
    expect(listGlobalMcpServers(ctx.db)).toEqual([]);
    expect(deleteGlobalMcpServer(ctx.db, "missing")).toEqual([]);
  });

  it("fails loudly on corrupt global configuration through the production codec", () => {
    putMcpServer(ctx.db, record());
    listGlobalMcpServers(ctx.db);
    const raw = ctx.db
      .prepare("SELECT value FROM app_state WHERE key = 'volli:mcp-global'")
      .get() as { value: string };
    const state = JSON.parse(raw.value);
    state.rows[0].transport = JSON.stringify({ type: "stdio", command: "" });
    ctx.db
      .prepare("UPDATE app_state SET value = ? WHERE key = 'volli:mcp-global'")
      .run(JSON.stringify(state));
    expect(() => listGlobalMcpServers(ctx.db)).toThrow(/Stored MCP server is invalid/);
  });
});
