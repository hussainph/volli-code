import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { MCP_ERROR_MAX_CHARS } from "@volli/shared";
import type { McpProtocolClient } from "./discovery";
import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject, type TestDb } from "../db/test-helpers";
import { McpSettingsService } from "./settings";

let ctx: TestDb;
let listedTools: readonly { name: string; description?: string; inputSchema: unknown }[];
let listFailure: Error | null;
let closed: ReturnType<typeof vi.fn<() => Promise<void>>>;

beforeEach(() => {
  ctx = openTestDb();
  insertProject(ctx.db, testProject({ id: "p1", path: "/repo/project" }));
  listedTools = [
    { name: "echo", description: "Echo", inputSchema: { type: "object" } },
    { name: "later", description: "Later", inputSchema: { type: "object" } },
  ];
  listFailure = null;
  closed = vi.fn<() => Promise<void>>(async () => {});
});

afterEach(() => ctx.cleanup());

function service() {
  return new McpSettingsService({
    db: ctx.db,
    now: () => 100,
    open: async (_server, workspacePath): Promise<McpProtocolClient> => {
      expect(workspacePath).toBe("/repo/project");
      return {
        listTools: async () => {
          if (listFailure !== null) throw listFailure;
          return listedTools;
        },
        callTool: vi.fn(async () => ({ content: [] })),
        close: closed,
      };
    },
  });
}

const draft = {
  id: "server-1",
  name: "Fixture",
  enabled: true,
  transport: { type: "stdio" as const, command: "node", args: ["fixture.mjs"] },
};

describe("McpSettingsService", () => {
  it("adds by connecting and discovering, then stores only the exact selected tool set", async () => {
    const result = await service().save({ projectId: "p1", server: draft, enabledTools: ["echo"] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.server.catalog.map((tool) => [tool.name, tool.enabled])).toEqual([
      ["echo", true],
      ["later", false],
    ]);
    expect(
      service()
        .selectedTools("p1")
        .map((tool) => tool.toolName),
    ).toEqual(["echo"]);
    expect(closed).toHaveBeenCalledOnce();
  });

  it("a failed refresh preserves the last catalog and marks it stale with a clear error", async () => {
    const settings = service();
    await settings.save({ projectId: "p1", server: draft, enabledTools: ["echo"] });
    listFailure = new Error("transport included token=secret");

    const result = await settings.refresh({ projectId: "p1", serverId: "server-1" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("Could not discover tools from Fixture.");
    expect(result.server).toMatchObject({ stale: true, error: result.error });
    expect(result.server?.catalog.map((tool) => tool.name)).toEqual(["echo", "later"]);
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("bounds untrusted errors before returning or storing them", async () => {
    const settings = service();
    await settings.save({ projectId: "p1", server: draft, enabledTools: ["echo"] });
    const hostileName = `bad\n${"x".repeat(MCP_ERROR_MAX_CHARS)}secret-tail`;

    const result = await settings.save({
      projectId: "p1",
      server: draft,
      enabledTools: [hostileName],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toHaveLength(MCP_ERROR_MAX_CHARS);
    expect(result.error).not.toContain("\n");
    expect(result.error).not.toContain("secret-tail");
    expect(result.server?.error).toBe(result.error);
  });

  it("keeps the last working catalog when refreshed definitions fail validation", async () => {
    const settings = service();
    await settings.save({ projectId: "p1", server: draft, enabledTools: ["echo"] });
    listedTools = [
      {
        name: "echo",
        description: "Broken replacement",
        inputSchema: { type: "object", properties: { value: 1 } },
      },
    ];

    const result = await settings.refresh({ projectId: "p1", serverId: "server-1" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.server).toMatchObject({ stale: true });
    expect(result.server?.catalog.map((tool) => [tool.name, tool.description])).toEqual([
      ["echo", "Echo"],
      ["later", "Later"],
    ]);
  });

  it("marks a catalog stale when refresh drops a previously enabled tool", async () => {
    const settings = service();
    await settings.save({ projectId: "p1", server: draft, enabledTools: ["echo"] });
    listedTools = [
      { name: "later", description: "Later changed", inputSchema: { type: "object" } },
    ];

    const result = await settings.refresh({ projectId: "p1", serverId: "server-1" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("Enabled MCP tool echo was not discovered.");
    expect(result.server).toMatchObject({ stale: true, error: result.error });
    expect(result.server?.catalog.map((tool) => [tool.name, tool.description])).toEqual([
      ["echo", "Echo"],
      ["later", "Later"],
    ]);
  });

  it("tests without saving and rejects enabled names absent from discovery", async () => {
    const settings = service();
    const tested = await settings.test({ projectId: "p1", server: draft });
    expect(tested.ok).toBe(true);
    expect(settings.list("p1")).toEqual([]);

    const saved = await settings.save({
      projectId: "p1",
      server: draft,
      enabledTools: ["not-discovered"],
    });
    expect(saved).toEqual({
      ok: false,
      error: "Enabled MCP tool not-discovered was not discovered.",
    });
    expect(settings.list("p1")).toEqual([]);
  });

  it("edits, enables, disables, changes selected tools, and removes without affecting stored history", async () => {
    const settings = service();
    await settings.save({ projectId: "p1", server: draft, enabledTools: ["echo"] });

    expect(settings.setEnabled({ projectId: "p1", serverId: "server-1", enabled: false }).ok).toBe(
      true,
    );
    expect(settings.selectedTools("p1")).toEqual([]);
    expect(
      settings.setTools({ projectId: "p1", serverId: "server-1", enabledTools: ["later"] }).ok,
    ).toBe(true);
    expect(settings.setEnabled({ projectId: "p1", serverId: "server-1", enabled: true }).ok).toBe(
      true,
    );
    expect(settings.selectedTools("p1").map((tool) => tool.toolName)).toEqual(["later"]);
    expect(settings.remove({ projectId: "p1", serverId: "server-1" })).toEqual({ ok: true });
    expect(settings.list("p1")).toEqual([]);
  });
});
