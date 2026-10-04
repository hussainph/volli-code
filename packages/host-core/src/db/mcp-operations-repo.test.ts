import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  listMcpOperations,
  mcpOperationId,
  recordMcpOperation,
  MCP_OPERATION_HISTORY_LIMIT,
} from "./mcp-operations-repo";
import { deleteMcpServer, putMcpServer } from "./mcp-servers-repo";
import { insertProject } from "./projects-repo";
import { openTestDb, testProject, type TestDb } from "./test-helpers";

let ctx: TestDb;

beforeEach(() => {
  ctx = openTestDb();
  insertProject(ctx.db, testProject({ id: "p1", name: "Project", path: "/repo/project" }));
  insertProject(ctx.db, testProject({ id: "p2", name: "Other", path: "/repo/other" }));
});

afterEach(() => ctx.cleanup());

const install = {
  id: mcpOperationId("session-1", "call-1"),
  projectId: "p1",
  serverId: "server-1",
  serverName: "Fixture",
  operation: "install" as const,
  outcome: "applied" as const,
  summary: "Installed Fixture with 1 of 2 tools on.",
  detail: null,
  provenance: {
    source: "registry.modelcontextprotocol.io",
    registryType: "npm" as const,
    version: "1.4.2",
    digest: null,
  },
  sessionId: "session-1",
  ticketId: "ticket-1",
};

describe("MCP operations repository (VC-380)", () => {
  it("records what was asked, where it came from, and how it ended", () => {
    recordMcpOperation(ctx.db, install, 100);

    const [recorded] = listMcpOperations(ctx.db, "p1");
    expect(recorded).toMatchObject({
      projectId: "p1",
      serverId: "server-1",
      serverName: "Fixture",
      operation: "install",
      outcome: "applied",
      summary: "Installed Fixture with 1 of 2 tools on.",
      detail: null,
      provenance: {
        source: "registry.modelcontextprotocol.io",
        registryType: "npm",
        version: "1.4.2",
        digest: null,
      },
      sessionId: "session-1",
      ticketId: "ticket-1",
      createdAt: 100,
    });
    // The id is the caller and the call that asked, not a fresh random value.
    expect(recorded?.id).toBe("session-1:call-1");
  });

  it("lands a replayed tool call once, keeping the first write's facts", () => {
    recordMcpOperation(ctx.db, install, 100);

    // The same tool call arriving again — a retry after a lost response is the
    // ordinary case, not the exotic one. It must not become a second fact about
    // one act, and it must not rewrite the first.
    const replayed = recordMcpOperation(
      ctx.db,
      { ...install, summary: "Installed Fixture with 2 of 2 tools on." },
      500,
    );

    expect(listMcpOperations(ctx.db, "p1")).toHaveLength(1);
    expect(replayed.summary).toBe("Installed Fixture with 1 of 2 tools on.");
    expect(replayed.createdAt).toBe(100);
  });

  it("keeps two genuinely different calls apart, even for the same server", () => {
    recordMcpOperation(ctx.db, install, 100);
    recordMcpOperation(
      ctx.db,
      { ...install, id: mcpOperationId("session-1", "call-2"), summary: "Installed again." },
      200,
    );

    expect(listMcpOperations(ctx.db, "p1").map((row) => row.summary)).toEqual([
      "Installed again.",
      "Installed Fixture with 1 of 2 tools on.",
    ]);
  });

  it("records a failure with the recovery line a person needs to pick it back up", () => {
    recordMcpOperation(
      ctx.db,
      {
        ...install,
        outcome: "failed",
        summary: "Could not install Fixture.",
        detail: "Could not discover tools from Fixture. Nothing was written; retry when ready.",
      },
      100,
    );

    expect(listMcpOperations(ctx.db, "p1")[0]).toMatchObject({
      outcome: "failed",
      detail: "Could not discover tools from Fixture. Nothing was written; retry when ready.",
    });
  });

  it("outlives the server it names, which is the whole point of a removal record", () => {
    putMcpServer(ctx.db, {
      id: "server-1",
      projectId: "p1",
      name: "Fixture",
      enabled: true,
      transport: { type: "stdio", command: "node", args: [] },
      provenance: { source: null, registryType: null, version: null, digest: null },
      catalog: [],
      stale: false,
      error: null,
      refreshedAt: null,
      createdAt: 1,
      updatedAt: 1,
    });
    recordMcpOperation(
      ctx.db,
      {
        ...install,
        id: mcpOperationId("session-1", "call-remove"),
        operation: "remove",
        summary: "Removed Fixture.",
      },
      200,
    );

    deleteMcpServer(ctx.db, "p1", "server-1");

    expect(listMcpOperations(ctx.db, "p1").map((row) => row.summary)).toEqual(["Removed Fixture."]);
  });

  it("reads newest first, scoped to one project, and bounded", () => {
    recordMcpOperation(ctx.db, { ...install, id: "session-1:a", summary: "first" }, 100);
    recordMcpOperation(ctx.db, { ...install, id: "session-1:b", summary: "second" }, 200);
    recordMcpOperation(
      ctx.db,
      { ...install, id: "session-1:c", projectId: "p2", summary: "elsewhere" },
      300,
    );

    expect(listMcpOperations(ctx.db, "p1").map((row) => row.summary)).toEqual(["second", "first"]);
    expect(listMcpOperations(ctx.db, "p1", 1).map((row) => row.summary)).toEqual(["second"]);
    expect(listMcpOperations(ctx.db, "p2").map((row) => row.summary)).toEqual(["elsewhere"]);
    expect(MCP_OPERATION_HISTORY_LIMIT).toBeGreaterThan(0);
  });

  it("bounds an untrusted summary and detail rather than storing them whole", () => {
    recordMcpOperation(
      ctx.db,
      { ...install, summary: "x".repeat(9_000), detail: `line\n${"y".repeat(9_000)}` },
      100,
    );

    const [recorded] = listMcpOperations(ctx.db, "p1");
    expect(recorded!.summary.length).toBeLessThanOrEqual(2_048);
    expect(recorded!.detail!.length).toBeLessThanOrEqual(2_048);
    expect(recorded!.detail).not.toContain("\n");
  });
});
