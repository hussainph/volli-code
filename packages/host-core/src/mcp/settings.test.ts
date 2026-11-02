import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { MCP_CONNECTION_TIMEOUT_MS, MCP_ERROR_MAX_CHARS } from "@volli/shared";
import type { McpProtocolClient } from "./discovery";
import { detachProject, insertProject } from "../db/projects-repo";
import { MemoryMcpCredentialStore } from "./credential-store";
import { openTestDb, testProject, type TestDb } from "../db/test-helpers";
import { McpSettingsService, MCP_CANCELLED_MESSAGE } from "./settings";
import { bindCloudSessionOwner } from "../cloud-move/freeze";
import { McpSessionHost, serversForFrozenMcpTools } from "./session-host";

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

describe("a project moving to Volli Cloud (VC-993)", () => {
  it("keeps its MCP configuration as it is", async () => {
    const saved = await service().save({ projectId: "p1", server: draft, enabledTools: ["echo"] });
    expect(saved.ok).toBe(true);
    ctx.db.exec(`
      INSERT INTO cloud_move_queues VALUES ('q', 'u', 'w', 'r', 1, 0, 'pending', NULL, 'running', 1, 1);
      INSERT INTO cloud_moves (move_id, queue_id, project_id, position, user_id, workspace_id,
        runner_id, state, app_version, mapper_version, created_at, updated_at)
      VALUES ('m', 'q', 'p1', 0, 'u', 'w', 'r', 'frozen', 'test', 3, 1, 1);
    `);
    const refused = { ok: false, error: expect.stringContaining("moving to Volli Cloud") };
    expect(await service().save({ projectId: "p1", server: draft, enabledTools: [] })).toEqual(
      refused,
    );
    expect(service().setEnabled({ projectId: "p1", serverId: "server-1", enabled: false })).toEqual(
      refused,
    );
    expect(service().remove({ projectId: "p1", serverId: "server-1" })).toEqual(refused);
  });
});

describe("a project moved to Volli Cloud, in a cloud launch (VC-1008)", () => {
  afterEach(() => bindCloudSessionOwner(ctx.db, null));

  it("edits the moved project's servers once its move committed, and only in a cloud launch", async () => {
    const saved = await service().save({ projectId: "p1", server: draft, enabledTools: ["echo"] });
    expect(saved.ok).toBe(true);
    ctx.db.exec(`
      INSERT INTO cloud_move_queues VALUES ('q', 'u', 'w', 'r', 1, 0, 'pending', NULL, 'running', 1, 1);
      INSERT INTO cloud_moves (move_id, queue_id, project_id, position, user_id, workspace_id,
        runner_id, state, app_version, mapper_version, created_at, updated_at)
      VALUES ('m', 'q', 'p1', 0, 'u', 'w', 'r', 'confirmed', 'test', 3, 1, 1);
    `);
    const refused = { ok: false, error: expect.stringContaining("Volli Cloud") };
    // A local launch: the archived copy keeps its configuration.
    expect(service().setEnabled({ projectId: "p1", serverId: "server-1", enabled: false })).toEqual(
      refused,
    );
    // A cloud launch for someone else: not theirs to edit.
    bindCloudSessionOwner(ctx.db, "someone-else");
    expect(service().setEnabled({ projectId: "p1", serverId: "server-1", enabled: false })).toEqual(
      refused,
    );
    // A cloud launch serving the moved project: its servers are the cloud project's here.
    bindCloudSessionOwner(ctx.db, "u");
    expect(
      service().setEnabled({ projectId: "p1", serverId: "server-1", enabled: false }),
    ).toMatchObject({ ok: true });
    expect(
      await service().save({ projectId: "p1", server: draft, enabledTools: ["echo"] }),
    ).toMatchObject({
      ok: true,
    });
    // Still moving: held in a cloud launch too.
    ctx.db.exec("UPDATE cloud_moves SET state = 'rows'");
    expect(service().remove({ projectId: "p1", serverId: "server-1" })).toEqual(refused);
    ctx.db.exec("UPDATE cloud_moves SET state = 'checked'");
    expect(service().remove({ projectId: "p1", serverId: "server-1" })).toEqual({ ok: true });
  });
});

describe("a move that starts while a save connects", () => {
  it("writes nothing: the freeze is asked again at the write", async () => {
    expect((await service().save({ projectId: "p1", server: draft, enabledTools: [] })).ok).toBe(
      true,
    );
    const before = service().list("p1");
    const connecting = new McpSettingsService({
      db: ctx.db,
      now: () => 200,
      open: async (): Promise<McpProtocolClient> => ({
        listTools: async () => {
          // The move freezes the project mid-handshake.
          ctx.db.exec(`
            INSERT INTO cloud_move_queues VALUES ('q', 'u', 'w', 'r', 1, 0, 'pending', NULL, 'running', 1, 1);
            INSERT INTO cloud_moves (move_id, queue_id, project_id, position, user_id, workspace_id,
              runner_id, state, app_version, mapper_version, created_at, updated_at)
            VALUES ('m', 'q', 'p1', 0, 'u', 'w', 'r', 'frozen', 'test', 3, 1, 1);
          `);
          return listedTools;
        },
        callTool: vi.fn(async () => ({ content: [] })),
        close: closed,
      }),
    });
    expect(
      await connecting.save({ projectId: "p1", server: draft, enabledTools: ["echo"] }),
    ).toEqual({ ok: false, error: expect.stringContaining("moving to Volli Cloud") });
    expect(service().list("p1")).toEqual(before);
  });
});

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
    expect(settings.surfaceRevision("p1")).toBe(0);
    await settings.save({ projectId: "p1", server: draft, enabledTools: ["echo"] });
    expect(settings.surfaceRevision("p1")).toBe(1);

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
    expect(settings.surfaceRevision("p1")).toBe(5);
    expect(settings.surfaceRevision("other-project")).toBe(0);
    expect(settings.remove({ projectId: "p1", serverId: "missing" }).ok).toBe(false);
    expect(settings.surfaceRevision("p1")).toBe(5);
  });

  it("answers whether a server is configured and enabled, re-reading only after a change (VC-771)", async () => {
    const settings = service();
    expect(settings.configured("p1", "server-1")).toBeUndefined();
    await settings.save({ projectId: "p1", server: draft, enabledTools: ["echo"] });
    expect(settings.configured("p1", "server-1")).toEqual({ enabled: true });
    // Another project's id is not this project's server.
    expect(settings.configured("other-project", "server-1")).toBeUndefined();

    // A write behind the service's back (nothing in the app does this) goes
    // unseen: the answer is remembered, not re-read per call.
    ctx.db.prepare("UPDATE mcp_servers SET enabled = 0 WHERE id = 'server-1'").run();
    expect(settings.configured("p1", "server-1")).toEqual({ enabled: true });

    // A change through the service is seen at once.
    settings.setEnabled({ projectId: "p1", serverId: "server-1", enabled: true });
    expect(settings.configured("p1", "server-1")).toEqual({ enabled: true });
    settings.setEnabled({ projectId: "p1", serverId: "server-1", enabled: false });
    expect(settings.configured("p1", "server-1")).toEqual({ enabled: false });
    settings.remove({ projectId: "p1", serverId: "server-1" });
    expect(settings.configured("p1", "server-1")).toBeUndefined();
  });

  it("stops a server for Sessions that hold its tools when a person disables or removes it (VC-771)", async () => {
    const settings = service();
    await settings.save({ projectId: "p1", server: draft, enabledTools: ["echo"] });
    const sessionClose = vi.fn(async () => undefined);
    const open = vi.fn(async (): Promise<McpProtocolClient> => ({
      listTools: async () => [],
      callTool: async () => ({ content: [{ type: "text", text: "echo ok" }] }),
      close: sessionClose,
    }));
    const host = new McpSessionHost({
      workspacePath: "/repo/project",
      servers: serversForFrozenMcpTools(settings.list("p1"), settings.selectedTools("p1")),
      open,
      configured: (serverId) => settings.configured("p1", serverId),
    });
    const call = { serverId: "server-1", toolName: "echo", arguments: {}, toolCallId: "c1" };
    const signal = new AbortController().signal;
    try {
      await host.port.call(call, signal);
      settings.setEnabled({ projectId: "p1", serverId: "server-1", enabled: false });
      await vi.waitFor(() => expect(sessionClose).toHaveBeenCalledOnce());
      expect((await host.port.call(call, signal)).isError).toBe(true);

      settings.setEnabled({ projectId: "p1", serverId: "server-1", enabled: true });
      expect(await host.port.call(call, signal)).toEqual({
        content: [{ type: "text", text: "echo ok" }],
        isError: false,
      });
      expect(open).toHaveBeenCalledTimes(2);
      // Saved again, switched off in the same edit.
      await settings.save({
        projectId: "p1",
        server: { ...draft, enabled: false },
        enabledTools: ["echo"],
      });
      await vi.waitFor(() => expect(sessionClose).toHaveBeenCalledTimes(2));
      settings.setEnabled({ projectId: "p1", serverId: "server-1", enabled: true });
      await host.port.call(call, signal);
      expect(open).toHaveBeenCalledTimes(3);
      settings.remove({ projectId: "p1", serverId: "server-1" });
      await vi.waitFor(() => expect(sessionClose).toHaveBeenCalledTimes(3));
    } finally {
      await host.close();
    }
  });
});

// VC-796, VC-822: a removed project is detached, not deleted, so its server
// rows stay; but no Settings screen shows them any more, and a credential
// nobody can see is one nobody would think to revoke. They go by name, once
// the project is off the rail.
describe("McpSettingsService on a project's removal", () => {
  it("names the project's servers, then forgets the credentials of every one off the rail", async () => {
    const credentials = new MemoryMcpCredentialStore();
    const settings = new McpSettingsService({
      db: ctx.db,
      now: () => 100,
      credentials,
      open: async (): Promise<McpProtocolClient> => ({
        listTools: async () => listedTools,
        callTool: vi.fn(async () => ({ content: [] })),
        close: closed,
      }),
    });
    insertProject(ctx.db, testProject({ id: "p2", path: "/repo/other" }));
    await settings.save({ projectId: "p1", server: draft, enabledTools: [] });
    await settings.save({
      projectId: "p2",
      server: { ...draft, id: "server-2" },
      enabledTools: [],
    });
    credentials.update("server-1", () => ({ secrets: { TOKEN: "one" } }));
    credentials.update("server-2", () => ({ secrets: { TOKEN: "two" } }));
    // A record whose server row is gone altogether is no one's either.
    credentials.update("server-gone", () => ({ secrets: { TOKEN: "gone" } }));

    const serverIds = settings.disconnectProject("p1");
    expect(serverIds).toEqual(["server-1"]);
    // Before the removal commits, nothing is forgotten.
    settings.forgetRemovedServers(serverIds);
    expect(credentials.read("server-1")).toEqual({ secrets: { TOKEN: "one" } });

    detachProject(ctx.db, "p1", 200);
    settings.forgetRemovedServers([...serverIds, "server-2", "server-gone"]);
    expect(credentials.read("server-1")).toBeUndefined();
    expect(credentials.read("server-gone")).toBeUndefined();
    expect(credentials.read("server-2")).toEqual({ secrets: { TOKEN: "two" } });
    // The server itself is kept for the project's return, without its secrets.
    expect(settings.list("p1").map(({ id }) => id)).toEqual(["server-1"]);
  });
});

describe("McpSettingsService cancellation and provenance (VC-380)", () => {
  it("honours a caller's signal during an install and says it was cancelled", async () => {
    const controller = new AbortController();
    const settings = new McpSettingsService({
      db: ctx.db,
      now: () => 100,
      open: async (_server, _workspacePath, signal): Promise<McpProtocolClient> => {
        controller.abort();
        signal.throwIfAborted();
        throw new Error("unreachable");
      },
    });

    const result = await settings.save({
      projectId: "p1",
      server: draft,
      enabledTools: ["echo"],
      signal: controller.signal,
    });

    expect(result).toEqual({
      ok: false,
      error: "The MCP connection was cancelled before it finished.",
    });
    // A first-time failure writes nothing at all — the row must not exist.
    expect(settings.list("p1")).toEqual([]);
  });

  it("tells a timeout apart from a cancellation, so a caller knows which happened", async () => {
    // The attempt spends the whole deadline and then fails. Nothing in the
    // error says "timeout": what makes it one is the duration, and that is what
    // is measured.
    let clock = 100;
    const settings = new McpSettingsService({
      db: ctx.db,
      now: () => clock,
      open: async (): Promise<McpProtocolClient> => {
        clock += MCP_CONNECTION_TIMEOUT_MS;
        throw new Error("socket hang up");
      },
    });

    const result = await settings.save({ projectId: "p1", server: draft, enabledTools: [] });

    expect(result).toEqual({
      ok: false,
      error: "Fixture did not answer within the 10s MCP connection limit.",
    });
    expect(settings.list("p1")).toEqual([]);
  });

  it("leaves a server's own wording out of the verdict entirely", async () => {
    // A server that proxies something slow may print "timeout" in an error it
    // raised immediately. Reading the words would blame Volli's connection
    // limit for a fault well inside it.
    const settings = new McpSettingsService({
      db: ctx.db,
      now: () => 100,
      open: async (): Promise<McpProtocolClient> => {
        throw new Error("upstream request timed out after 20ms");
      },
    });

    const result = await settings.save({ projectId: "p1", server: draft, enabledTools: [] });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).not.toContain("did not answer within");
  });

  it("writes nothing when the caller cancels after the catalog arrives", async () => {
    // The narrow window between a successful handshake and the only write in
    // `save`. Acceptance 6 promises a cancelled install leaves NO partial
    // configuration, and "almost none" is a different promise.
    const controller = new AbortController();
    const settings = new McpSettingsService({
      db: ctx.db,
      now: () => 100,
      open: async (): Promise<McpProtocolClient> => ({
        listTools: async () => {
          controller.abort();
          return [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }];
        },
        callTool: async () => ({ content: [] }),
        close: async () => {},
      }),
    });

    const result = await settings.save({
      projectId: "p1",
      server: draft,
      enabledTools: [],
      signal: controller.signal,
    });

    expect(result).toEqual({ ok: false, error: MCP_CANCELLED_MESSAGE });
    expect(settings.list("p1")).toEqual([]);
  });

  it("carries the caller's signal into a preview, and leaves nothing behind", async () => {
    const controller = new AbortController();
    controller.abort();
    const settings = service();

    const result = await settings.test({
      projectId: "p1",
      server: draft,
      signal: controller.signal,
    });

    expect(result).toEqual({
      ok: false,
      error: "The MCP connection was cancelled before it finished.",
    });
    expect(settings.list("p1")).toEqual([]);
  });

  it("stores the provenance an install supplied, and refuses one it cannot read back", async () => {
    const settings = service();

    const saved = await settings.save({
      projectId: "p1",
      server: draft,
      enabledTools: ["echo"],
      provenance: {
        source: "registry.modelcontextprotocol.io",
        registryType: "npm",
        version: "1.4.2",
      },
    });

    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.server.provenance).toEqual({
      source: "registry.modelcontextprotocol.io",
      registryType: "npm",
      version: "1.4.2",
      digest: null,
    });

    expect(
      await settings.save({
        projectId: "p1",
        server: draft,
        enabledTools: ["echo"],
        provenance: { registryType: "homebrew" },
      }),
    ).toEqual({
      ok: false,
      error: "registry type must be one of: npm, pypi, nuget, cargo, oci, mcpb",
    });
  });

  it("keeps recorded provenance through a refresh nobody gave a new origin for", async () => {
    const settings = service();
    await settings.save({
      projectId: "p1",
      server: draft,
      enabledTools: ["echo"],
      provenance: { source: "npm", version: "1.4.2" },
    });

    const refreshed = await settings.refresh({ projectId: "p1", serverId: "server-1" });

    expect(refreshed.ok).toBe(true);
    if (!refreshed.ok) return;
    expect(refreshed.server.provenance).toMatchObject({ source: "npm", version: "1.4.2" });
  });
});
