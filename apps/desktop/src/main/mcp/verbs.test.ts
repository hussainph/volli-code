/**
 * The MCP management verbs, through the real Agent Tool Surface door (VC-380).
 *
 * The seam is `createAgentToolDoor` and a real `McpSettingsService` over a real
 * database — not the handler functions, and not a mocked settings service. Two
 * reasons. The door is where the caller is BOUND rather than claimed, so a test
 * that called a handler directly would prove nothing about the property the
 * whole family rests on; and the settings service is where the frozen-surface
 * rules, the discovery bounds and the stale-catalog behaviour already live, so
 * mocking it would leave the ticket's acceptance criteria asserted against a
 * fiction.
 *
 * Only the MCP protocol client is faked, because that is the genuine outside
 * edge: a real one would start a process.
 */

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  DEFAULT_AUTHORITY_POLICY,
  MCP_CONNECTION_TIMEOUT_MS,
  resolveAgentToolSurface,
} from "@volli/shared";
import type { RuntimeAskChoice, RuntimeAskRequest, RuntimeSessionIdentity } from "@volli/shared";

import { createAgentToolDoor } from "../agent-tool-door";
import type { VerbBudgetAsk } from "../agent-tool-door";
import { listMcpOperations } from "../db/mcp-operations-repo";
import { listMcpServers, putMcpServer } from "../db/mcp-servers-repo";
import { insertProject } from "../db/projects-repo";
import { insertTicket } from "../db/tickets-repo";
import { openRawDb, openTestDb, testProject, testTicket, type TestDb } from "../db/test-helpers";
import type { McpProtocolClient } from "./discovery";
import { serversForFrozenMcpTools } from "./session-host";
import { McpSettingsService } from "./settings";

let ctx: TestDb;
/** A handle a test reopened after a simulated relaunch, so `afterEach` can close it. */
let relaunchedDb: { close: () => void } | null = null;

/**
 * A clock a test can push forward, for the one question duration answers.
 *
 * `McpSettingsService` reads elapsed time from the clock it was given, so a
 * timeout is reproduced by letting the clock run — not by writing the words
 * "timed out" into an error and checking they come back.
 */
function advancingClock(start = 1_000) {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

/** The Board Session doing the calling — identity the adapter closed over. */
const CALLER: RuntimeSessionIdentity = {
  role: "project",
  sessionId: "caller-session",
  rootThreadId: "thread-1",
  attachmentId: "attachment-1",
  projectId: "project-one",
  ticketId: null,
};

const TICKET_CALLER: RuntimeSessionIdentity = {
  role: "ticket",
  sessionId: "ticket-caller",
  rootThreadId: "thread-2",
  attachmentId: "attachment-2",
  projectId: "project-one",
  ticketId: "ticket-one",
};

const LOCAL = { id: "files", name: "Acme Files", command: "npx", args: "-y @acme/files-mcp" };
const REMOTE = { id: "search", name: "Acme Search", url: "https://mcp.example.com/mcp" };
/** The shape acceptance 12 forbids: a credential parked where a URL will carry it. */
const REMOTE_WITH_TOKEN = { ...REMOTE, url: "https://mcp.example.com/mcp?token=abc" };

interface HarnessOptions {
  tools?: readonly { name: string; description?: string; inputSchema: unknown }[];
  failWith?: Error;
  /** Called when the fake client is opened, so a test can abort mid-flight. */
  onOpen?: (signal: AbortSignal) => void;
  mcp?: "present" | "absent";
  /** The clock the settings owner reads, for tests about duration. */
  now?: () => number;
}

function harness(options: HarnessOptions = {}) {
  ctx = openTestDb();
  const db = ctx.db;
  insertProject(
    db,
    testProject({ id: "project-one", name: "Volli", path: "/repo/volli", ticketPrefix: "VC" }),
  );
  insertProject(
    db,
    testProject({ id: "project-two", name: "Other", path: "/repo/other", ticketPrefix: "OT" }),
  );
  insertTicket(db, testTicket("project-one", { id: "ticket-one", ticketNumber: 1, title: "Work" }));

  const opened: { command: string; cwd: string }[] = [];
  const settings = new McpSettingsService({
    db,
    now: options.now ?? (() => 1_000),
    open: async (server, workspacePath, signal): Promise<McpProtocolClient> => {
      opened.push({
        command:
          server.transport.type === "stdio"
            ? [server.transport.command, ...server.transport.args].join(" ")
            : server.transport.url,
        cwd: workspacePath,
      });
      options.onOpen?.(signal);
      signal.throwIfAborted();
      if (options.failWith !== undefined) throw options.failWith;
      return {
        listTools: async () =>
          options.tools ?? [
            { name: "read_file", description: "Read a file", inputSchema: { type: "object" } },
            { name: "write_file", description: "Write a file", inputSchema: { type: "object" } },
          ],
        callTool: vi.fn(async () => ({ content: [] })),
        close: async () => {},
      };
    },
  });

  const door = createAgentToolDoor({
    db,
    projects: () => [
      { id: "project-one", name: "Volli", path: "/repo/volli" } as never,
      { id: "project-two", name: "Other", path: "/repo/other" } as never,
    ],
    sessions: () => null,
    submitSessionMessage: async () => {},
    onSessionStarted: () => {},
    actorTicketDisplay: () => null,
    now: () => 1_000,
    delegation: {
      startGrantScope: () => null,
      claimStart: () => ({ ok: false, reason: "not-granted" }),
      releaseIfUnstarted: () => undefined,
      recordExtension: () => undefined,
    },
    automations: () => null,
    authorityPolicy: () => DEFAULT_AUTHORITY_POLICY,
    subscribeTicketWake: () => () => undefined,
    subscribeSessionWake: () => () => undefined,
    supervise: () => null,
    delegate: () => null,
    mcp: () => (options.mcp === "absent" ? null : settings),
  });

  // A fresh id per call, the way a real runtime mints one. Two calls are two
  // acts; a test that means a REPLAY says so by passing the id it saw before.
  let calls = 0;
  const call = (
    verb: string,
    input: Record<string, unknown>,
    extras: {
      toolCallId?: string;
      caller?: RuntimeSessionIdentity;
      signal?: AbortSignal;
      ask?: VerbBudgetAsk;
    } = {},
  ) => {
    calls += 1;
    return door(
      extras.caller ?? CALLER,
      { verb: verb as never, input, toolCallId: extras.toolCallId ?? `tc-${calls}` },
      extras.signal ?? new AbortController().signal,
      extras.ask,
    );
  };

  /**
   * What the next launch actually does: close this handle, open the file again.
   *
   * A new service object over the STILL-OPEN connection would not have been a
   * restart at all — it would pass even for state that never reached the disk.
   */
  const reopen = () => {
    db.close();
    const reopened = openRawDb(ctx.dbPath);
    relaunchedDb = reopened;
    return reopened;
  };

  return { call, db, settings, opened, reopen };
}

/** An ask port that answers with a fixed choice and records what it was shown. */
function askingWith(choice: RuntimeAskChoice) {
  const seen: RuntimeAskRequest[] = [];
  const ask: VerbBudgetAsk = async (request) => {
    seen.push(request);
    return choice;
  };
  return { ask, seen };
}

/** Install one server for real, so the toggle/remove suites have something to act on. */
async function installed(h: ReturnType<typeof harness>, tools = "read_file") {
  return h.call("mcp.install", { ...LOCAL, tools, confirm: "apply" });
}

afterEach(() => {
  relaunchedDb?.close();
  relaunchedDb = null;
  ctx?.cleanup();
});

describe("mcp_preview", () => {
  it("connects, lists the tools, and saves nothing", async () => {
    const h = harness();

    const result = await h.call("mcp.preview", LOCAL);

    expect(result.text).toContain("read_file");
    expect(result.text).toContain("write_file");
    expect(h.opened).toEqual([{ command: "npx -y @acme/files-mcp", cwd: "/repo/volli" }]);
    // Acceptance 1: nothing is saved by a preview.
    expect(listMcpServers(h.db, "project-one")).toEqual([]);
  });

  it("names a tool it could not make safe rather than dropping it silently", async () => {
    const h = harness({
      tools: [
        { name: "ok", description: "Fine", inputSchema: { type: "object" } },
        { name: "broken", description: "Bad", inputSchema: { type: "array" } },
      ],
    });

    const result = await h.call("mcp.preview", LOCAL);

    expect(result.text).toContain("ok");
    expect(result.text).toContain("broken");
    expect(result.text).toMatch(/unusable|unavailable/i);
  });

  /**
   * Every other MCP client — Claude Code, Cursor, VS Code, Claude Desktop, Zed
   * — spells a local server's arguments as `args: string[]`. A model that has
   * seen any of those configs will send an array here, and a field that took
   * only a string would either reject or silently stringify it.
   */
  it("takes args as the array every other MCP config uses", async () => {
    const h = harness();

    await h.call("mcp.preview", {
      id: "files",
      name: "Acme Files",
      command: "npx",
      args: ["-y", "@acme/files-mcp", "--root", "/a path/with spaces"],
    });

    expect(h.opened).toEqual([
      { command: "npx -y @acme/files-mcp --root /a path/with spaces", cwd: "/repo/volli" },
    ]);
  });

  it("still takes args as a string, keeping quoted runs whole", async () => {
    const h = harness();

    await h.call("mcp.preview", { ...LOCAL, args: '-y @acme/files-mcp --root "/a path"' });

    expect(h.opened[0]?.command).toBe("npx -y @acme/files-mcp --root /a path");
  });

  it("refuses an args array holding anything but strings, rather than coercing it", async () => {
    const h = harness();

    const result = await h.call("mcp.preview", { ...LOCAL, args: ["-y", 7] });

    expect(result.text).toMatch(/`args` must be/);
    expect(h.opened).toEqual([]);
  });

  it("refuses a configuration that names both a command and a URL", async () => {
    const h = harness();

    const result = await h.call("mcp.preview", { ...LOCAL, url: "https://example.com/mcp" });

    expect(result.text).toMatch(/one of `command` or `url`/);
    expect(h.opened).toEqual([]);
  });

  it("refuses an invalid configuration in words, before anything is started", async () => {
    const h = harness();

    const result = await h.call("mcp.preview", { id: "bad id!", name: "X", command: "node" });

    expect(result.text).toMatch(/server id is invalid/);
    expect(h.opened).toEqual([]);
  });
});

describe("mcp_list", () => {
  it("says plainly when a project has none, rather than printing an empty table", async () => {
    const h = harness();

    const result = await h.call("mcp.list", {});

    expect(result.text).toMatch(/no MCP servers/i);
  });

  it("shows each server's transport, selected tools, and recorded provenance", async () => {
    const h = harness();
    await h.call("mcp.install", {
      ...LOCAL,
      tools: "read_file",
      source: "registry.modelcontextprotocol.io",
      registryType: "npm",
      version: "1.4.2",
      digest: "sha256:abc123",
      confirm: "apply",
    });

    const result = await h.call("mcp.list", {});

    expect(result.text).toContain("Acme Files");
    expect(result.text).toContain("npx -y @acme/files-mcp");
    expect(result.text).toContain("read_file");
    expect(result.text).toContain("registry.modelcontextprotocol.io");
    expect(result.text).toContain("1.4.2");
    expect(result.text).toContain("sha256:abc123");
    // Recorded, never verified — the listing must not let that be misread.
    expect(result.text).toMatch(/recorded|not verified/i);
  });

  it("shows the management history a person can pick work back up from", async () => {
    const h = harness();
    await installed(h);

    const result = await h.call("mcp.list", {});

    expect(result.text).toMatch(/Recent MCP operations/i);
    expect(result.text).toContain("Installed Acme Files");
  });
});

describe("mcp_install previews before it does anything", () => {
  it("warns about a local command, and starts no process (acceptance 7)", async () => {
    const h = harness();

    const result = await h.call("mcp.install", { ...LOCAL, tools: "read_file" });

    expect(result.text).toContain("PREVIEW");
    expect(result.text).toContain("npx -y @acme/files-mcp");
    expect(result.text).toContain("runs on this machine as you");
    expect(result.text).toContain('confirm="apply"');
    // "Before anything runs" has to mean before the PROCESS, not before the
    // write: a local MCP server is a command started as the person using Volli.
    expect(h.opened).toEqual([]);
    expect(listMcpServers(h.db, "project-one")).toEqual([]);
  });

  it("warns about a remote endpoint in its own terms, naming no query string", async () => {
    const h = harness();

    const result = await h.call("mcp.install", REMOTE);

    expect(result.text).toContain("PREVIEW");
    expect(result.text).toContain("receives whatever arguments its tools are given");
    expect(result.text).toContain("https://mcp.example.com");
    expect(h.opened).toEqual([]);
  });

  it("refuses an endpoint carrying a query string, before anything is opened", async () => {
    const h = harness();

    const result = await h.call("mcp.install", { ...REMOTE_WITH_TOKEN, confirm: "apply" });

    // Acceptance 12 is absolute: no secret reaches a server process, a verb
    // argument, or a stored record. A query string is the last place in a URL a
    // token can sit, and Volli cannot tell one from an ordinary parameter.
    expect(result.text).toContain("carries a query string");
    expect(result.text).toContain("Settings");
    expect(h.opened).toEqual([]);
    expect(listMcpServers(h.db, "project-one")).toEqual([]);
    expect(listMcpOperations(h.db, "project-one")).toEqual([]);
  });

  it("refuses it on preview too, so the refusal never costs a connection", async () => {
    const h = harness();

    const previewed = await h.call("mcp.preview", REMOTE_WITH_TOKEN);

    expect(previewed.text).toContain("carries a query string");
    expect(h.opened).toEqual([]);
  });

  it("says when the plain call would REPLACE an existing server rather than add one", async () => {
    const h = harness();
    await installed(h);

    const result = await h.call("mcp.install", { ...LOCAL, tools: "write_file" });

    expect(result.text).toMatch(/would UPDATE the existing server/);
    // Still nothing written by the preview.
    expect(listMcpServers(h.db, "project-one")[0]?.catalog.filter((t) => t.enabled)).toHaveLength(
      1,
    );
  });

  it("refuses provenance it could not store, at preview rather than after a handshake", async () => {
    const h = harness();

    const result = await h.call("mcp.install", { ...LOCAL, registryType: "homebrew" });

    // Learning this on the apply call would mean a wasted process launch and a
    // caller that read the warning, agreed to it, and then got a typo back.
    expect(result.text).toMatch(/registry type must be one of/);
    expect(result.text).not.toContain("PREVIEW");
    expect(h.opened).toEqual([]);
  });

  it("writes no audit record for a preview, because nothing happened", async () => {
    const h = harness();

    await h.call("mcp.install", LOCAL);

    expect(listMcpOperations(h.db, "project-one")).toEqual([]);
  });
});

describe("mcp_install applies only on the explicit second call", () => {
  it("installs, selects the named tools, and says when they become usable", async () => {
    const h = harness();

    const result = await h.call("mcp.install", { ...LOCAL, tools: "read_file", confirm: "apply" });

    expect(result.text).toContain("Installed Acme Files");
    // Acceptance 3: the honest explanation, in the result text.
    expect(result.text).toContain("frozen when it is created");
    expect(result.text).toContain("next Session created");
    const [server] = listMcpServers(h.db, "project-one");
    expect(server?.catalog.map((tool) => [tool.name, tool.enabled])).toEqual([
      ["read_file", true],
      ["write_file", false],
    ]);
  });

  it("puts the warning in front of a person when there is one, and obeys a refusal", async () => {
    const h = harness();
    const asking = askingWith("refuse");

    const result = await h.call(
      "mcp.install",
      { ...LOCAL, tools: "read_file", confirm: "apply" },
      { ask: asking.ask },
    );

    expect(asking.seen[0]).toMatchObject({
      cause: "confirm.mcp-install",
      tool: "mcp_install",
      overridable: true,
    });
    expect(asking.seen[0]?.reason).toContain("runs on this machine as you");
    expect(result.text).toMatch(/declined/);
    expect(listMcpServers(h.db, "project-one")).toEqual([]);
    expect(h.opened).toEqual([]);
  });

  it("installs when the person allows it, and says who confirmed", async () => {
    const h = harness();
    const asking = askingWith("allow");

    const result = await h.call(
      "mcp.install",
      { ...LOCAL, tools: "read_file", confirm: "apply" },
      { ask: asking.ask },
    );

    expect(result.text).toContain("Installed Acme Files");
    expect(result.text).toContain("The person driving confirmed");
  });

  it("says plainly when nobody could be asked, rather than implying someone was", async () => {
    const h = harness();

    const result = await installed(h);

    expect(result.text).toMatch(/Nobody was asked to confirm/);
  });

  it("running the same install twice leaves one server and one tool set (acceptance 4)", async () => {
    const h = harness();

    await installed(h);
    const second = await installed(h);

    expect(second.text).toContain("Installed Acme Files");
    const servers = listMcpServers(h.db, "project-one");
    expect(servers).toHaveLength(1);
    expect(servers[0]?.catalog.filter((tool) => tool.enabled).map((tool) => tool.name)).toEqual([
      "read_file",
    ]);
  });

  it("refuses a tool the server never offered, rather than installing a lie", async () => {
    const h = harness();

    const result = await h.call("mcp.install", {
      ...LOCAL,
      tools: "read_file, nonexistent",
      confirm: "apply",
    });

    expect(result.text).toContain("nonexistent was not discovered");
    expect(listMcpServers(h.db, "project-one")).toEqual([]);
  });

  it("reports the tools it could not offer instead of pretending the server is smaller", async () => {
    const h = harness({
      tools: [
        { name: "ok", description: "Fine", inputSchema: { type: "object" } },
        { name: "broken", description: "Bad", inputSchema: { type: "array" } },
      ],
    });

    const result = await h.call("mcp.install", { ...LOCAL, tools: "ok", confirm: "apply" });

    expect(result.text).toContain("could not be offered: broken");
  });
});

describe("mcp_install when the attempt stops", () => {
  it("leaves no row after a first-time failure, and can be retried at once", async () => {
    const failing = harness({ failWith: new Error("handshake refused") });

    const failed = await installed(failing);

    expect(failed.text).toMatch(/Could not install Acme Files/);
    expect(failed.text).toMatch(/Nothing was written/);
    expect(failed.text).toMatch(/retrying the same call is safe/);
    expect(listMcpServers(failing.db, "project-one")).toEqual([]);
  });

  it("keeps the last working tool list after a failed update, marked stale (acceptance 5)", async () => {
    let broken = false;
    const h = harness({
      onOpen: () => {
        if (broken) throw new Error("server went away");
      },
    });
    await installed(h);
    broken = true;

    const result = await installed(h);

    expect(result.text).toMatch(/last working tool list was kept/);
    const [server] = listMcpServers(h.db, "project-one");
    expect(server?.stale).toBe(true);
    expect(server?.catalog.map((tool) => tool.name)).toEqual(["read_file", "write_file"]);
    expect(server?.catalog.filter((tool) => tool.enabled).map((tool) => tool.name)).toEqual([
      "read_file",
    ]);
  });

  it("a cancelled install stops, writes nothing, and says it was cancelled (acceptance 6)", async () => {
    const controller = new AbortController();
    const h = harness({ onOpen: () => controller.abort() });

    const result = await h.call(
      "mcp.install",
      { ...LOCAL, tools: "read_file", confirm: "apply" },
      { signal: controller.signal },
    );

    expect(result.text).toContain("cancelled");
    expect(result.text).not.toContain("did not answer within");
    expect(listMcpServers(h.db, "project-one")).toEqual([]);
  });

  it("a timed-out install says so, and is not reported as a cancellation", async () => {
    // The clock really runs past the limit while the handshake is in flight.
    // Nothing here names a timeout: the attempt spends its deadline, which is
    // what a timeout IS, and the message is derived from that.
    const clock = advancingClock();
    const h = harness({
      now: clock.now,
      onOpen: () => clock.advance(MCP_CONNECTION_TIMEOUT_MS),
      failWith: new Error("socket hang up"),
    });

    const result = await installed(h);

    expect(result.text).toContain("did not answer within the 10s MCP connection limit");
    expect(result.text).not.toContain("cancelled");
    expect(listMcpServers(h.db, "project-one")).toEqual([]);
  });

  it("does not call a server's own error a Volli timeout just because it says so", async () => {
    // The failure text is a third party's prose, and MCP servers proxy things
    // that time out. Classifying on the wording would blame Volli's connection
    // limit for a fault that happened well inside it, and send a caller off to
    // fix the wrong thing.
    const h = harness({ failWith: new Error("upstream database timeout after 500ms") });

    const result = await installed(h);

    expect(result.text).not.toContain("did not answer within");
    expect(result.text).not.toContain("cancelled");
    expect(result.text).toMatch(/Could not install Acme Files/);
  });

  it("records a failed first install with enough to retry it by hand", async () => {
    const h = harness({ failWith: new Error("handshake refused") });

    await installed(h);

    // No server row survives a first-time failure, so this record is the only
    // place the attempted configuration exists at all.
    expect(listMcpServers(h.db, "project-one")).toEqual([]);
    const [recorded] = listMcpOperations(h.db, "project-one");
    expect(recorded?.outcome).toBe("failed");
    expect(recorded?.detail).toContain("npx -y @acme/files-mcp");
    expect(recorded?.detail).toContain("tools requested: read_file");
  });
});

describe("mcp_remove refuses to act without confirmation (acceptance 8)", () => {
  it("previews, naming the reattachment it breaks and the safer verb", async () => {
    const h = harness();
    await installed(h);

    const result = await h.call("mcp.remove", { server: "files" });

    expect(result.text).toContain("PREVIEW");
    expect(result.text).toContain("fail to reattach");
    expect(result.text).toContain("mcp_disable");
    expect(listMcpServers(h.db, "project-one")).toHaveLength(1);
  });

  it("asks a person on apply, and leaves the server alone when they decline", async () => {
    const h = harness();
    await installed(h);
    const asking = askingWith("refuse");

    const result = await h.call(
      "mcp.remove",
      { server: "files", confirm: "apply" },
      { ask: asking.ask },
    );

    expect(asking.seen[0]).toMatchObject({ cause: "confirm.mcp-remove", tool: "mcp_remove" });
    expect(asking.seen[0]?.reason).toContain("fail to reattach");
    expect(result.text).toMatch(/declined/);
    expect(listMcpServers(h.db, "project-one")).toHaveLength(1);
  });

  it("removes on apply, and hands back what it would take to restore it", async () => {
    const h = harness();
    await installed(h);

    const result = await h.call("mcp.remove", { server: "files", confirm: "apply" });

    expect(result.text).toContain("Removed Acme Files");
    expect(result.text).toContain("npx -y @acme/files-mcp");
    expect(listMcpServers(h.db, "project-one")).toEqual([]);
  });

  it("says so when the server is not there, rather than reporting a removal", async () => {
    const h = harness();

    const result = await h.call("mcp.remove", { server: "ghost", confirm: "apply" });

    expect(result.text).toMatch(/No MCP server ghost in this project/);
  });
});

describe("mcp_enable, mcp_disable, mcp_tools and mcp_refresh", () => {
  it("turns a server off without deleting it, so older Sessions still reattach", async () => {
    const h = harness();
    await installed(h);

    const result = await h.call("mcp.disable", { server: "files" });

    expect(result.text).toContain("Turned Acme Files off");
    expect(result.text).toContain("can still reattach");
    expect(listMcpServers(h.db, "project-one")[0]?.enabled).toBe(false);
    expect(h.settings.selectedTools("project-one")).toEqual([]);
  });

  it("turns it back on, and says when the tools become usable", async () => {
    const h = harness();
    await installed(h);
    await h.call("mcp.disable", { server: "files" });

    const result = await h.call("mcp.enable", { server: "files" });

    expect(result.text).toContain("Turned Acme Files on");
    expect(result.text).toContain("next Session created");
    expect(h.settings.selectedTools("project-one").map((tool) => tool.toolName)).toEqual([
      "read_file",
    ]);
  });

  it("replaces the tool selection rather than adding to it", async () => {
    const h = harness();
    await installed(h);

    const result = await h.call("mcp.tools", { server: "files", tools: "write_file" });

    expect(result.text).toContain("1 of 2 tools on: write_file");
    expect(h.settings.selectedTools("project-one").map((tool) => tool.toolName)).toEqual([
      "write_file",
    ]);
  });

  it("turns every tool off when given an empty selection", async () => {
    const h = harness();
    await installed(h);

    await h.call("mcp.tools", { server: "files", tools: "" });

    expect(h.settings.selectedTools("project-one")).toEqual([]);
  });

  it("re-reads a catalog, keeping the current selection", async () => {
    const h = harness();
    await installed(h);

    const result = await h.call("mcp.refresh", { server: "files" });

    expect(result.text).toContain("Refreshed Acme Files");
    expect(result.text).toContain("tools on: read_file");
  });

  it("keeps the last working catalog when a refresh fails, and says so", async () => {
    let broken = false;
    const h = harness({
      onOpen: () => {
        if (broken) throw new Error("gone");
      },
    });
    await installed(h);
    broken = true;

    const result = await h.call("mcp.refresh", { server: "files" });

    expect(result.text).toMatch(/last working tool list was kept/);
    expect(listMcpServers(h.db, "project-one")[0]?.catalog).toHaveLength(2);
  });
});

describe("the durable record every install and removal leaves (acceptance 11)", () => {
  it("records an install with its source, outcome and the Session that asked", async () => {
    const h = harness();

    await h.call("mcp.install", {
      ...LOCAL,
      tools: "read_file",
      source: "registry.modelcontextprotocol.io",
      registryType: "npm",
      version: "1.4.2",
      confirm: "apply",
    });

    const [recorded] = listMcpOperations(h.db, "project-one");
    expect(recorded).toMatchObject({
      serverId: "files",
      serverName: "Acme Files",
      operation: "install",
      outcome: "applied",
      sessionId: "caller-session",
      provenance: { source: "registry.modelcontextprotocol.io", version: "1.4.2" },
    });
  });

  it("records a FAILED install with what to do about it", async () => {
    const h = harness({ failWith: new Error("handshake refused") });

    await installed(h);

    const [recorded] = listMcpOperations(h.db, "project-one");
    expect(recorded).toMatchObject({ operation: "install", outcome: "failed" });
    expect(recorded?.detail).toMatch(/retrying the same call is safe/);
  });

  it("records a removal that survives the server it names", async () => {
    const h = harness();
    await installed(h);

    await h.call("mcp.remove", { server: "files", confirm: "apply" });

    const summaries = listMcpOperations(h.db, "project-one").map((row) => row.summary);
    expect(summaries[0]).toMatch(/Removed Acme Files/);
    expect(listMcpServers(h.db, "project-one")).toEqual([]);
  });

  it("also comments on the Ticket when the caller has one, so a person finds it there", async () => {
    const h = harness();

    await h.call(
      "mcp.install",
      { ...LOCAL, tools: "read_file", confirm: "apply" },
      { caller: TICKET_CALLER },
    );

    const comments = h.db
      .prepare("SELECT body FROM ticket_comments WHERE ticket_id = 'ticket-one'")
      .all() as { body: string }[];
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("MCP install");
    expect(comments[0]?.body).toContain("Acme Files");
    // The Board Role holds these verbs, so the project-scoped row is the
    // canonical one and the comment is the extra.
    expect(listMcpOperations(h.db, "project-one")).toHaveLength(1);
  });

  it("stores no secret from a remote endpoint in the durable record (acceptance 12)", async () => {
    const h = harness();

    await h.call("mcp.install", { ...REMOTE, confirm: "apply" });
    await h.call("mcp.remove", { server: "search", confirm: "apply" });

    const recorded = JSON.stringify(listMcpOperations(h.db, "project-one"));
    expect(recorded).toContain("mcp.example.com");
    expect(recorded).not.toContain("?");
  });

  it("redacts a query string a person configured by hand, wherever it prints one", async () => {
    const h = harness();
    // The verbs refuse this shape, but Settings is the named way through, so a
    // stored server CAN still carry one. Everything an agent reads about it
    // travels into a model's context and into durable records.
    putMcpServer(h.db, {
      id: "search",
      projectId: "project-one",
      name: "Acme Search",
      enabled: true,
      transport: { type: "streamable-http", url: "https://mcp.example.com/mcp?token=abc" },
      provenance: { source: null, registryType: null, version: null, digest: null },
      catalog: [],
      stale: false,
      error: null,
      refreshedAt: 1,
      createdAt: 1,
      updatedAt: 1,
    });

    const listed = await h.call("mcp.list", {});

    expect(listed.text).toContain("https://mcp.example.com/mcp");
    expect(listed.text).not.toContain("token=abc");
    expect(listed.text).toContain("query string not shown");
  });
});

describe("what the MCP verbs never do", () => {
  it("binds the caller's project instead of believing one in the input", async () => {
    const h = harness();

    await h.call("mcp.install", {
      ...LOCAL,
      tools: "read_file",
      confirm: "apply",
      projectId: "project-two",
      sessionId: "somebody-else",
    });

    expect(listMcpServers(h.db, "project-two")).toEqual([]);
    expect(listMcpServers(h.db, "project-one")).toHaveLength(1);
    expect(listMcpOperations(h.db, "project-one")[0]?.sessionId).toBe("caller-session");
  });

  it("cannot reach another project's server, even by its exact id", async () => {
    const h = harness();
    await installed(h);
    const elsewhere: RuntimeSessionIdentity = { ...CALLER, projectId: "project-two" };

    const result = await h.call(
      "mcp.remove",
      { server: "files", confirm: "apply" },
      {
        caller: elsewhere,
      },
    );

    expect(result.text).toMatch(/No MCP server files in this project/);
    expect(listMcpServers(h.db, "project-one")).toHaveLength(1);
  });

  it("refuses in words when no MCP settings owner came up this launch", async () => {
    const h = harness({ mcp: "absent" });

    for (const verb of ["mcp.list", "mcp.preview", "mcp.install", "mcp.remove"]) {
      const result = await h.call(verb, { ...LOCAL, server: "files" });
      expect(result.text, verb).toMatch(/MCP settings are not available this launch/);
    }
  });

  it("survives a restart: configuration and history are read back from disk", async () => {
    const h = harness();
    await installed(h);
    await h.call("mcp.remove", { server: "files", confirm: "apply" });
    await installed(h);

    // A real relaunch: the handle this process held is CLOSED and the file is
    // opened again. Reusing the open connection would have proved only that the
    // service reads SQLite rather than its own memory, and would have passed
    // just as well if nothing had ever reached the disk.
    const reopened = h.reopen();
    const relaunched = new McpSettingsService({ db: reopened, now: () => 2_000 });
    expect(relaunched.list("project-one").map((server) => server.name)).toEqual(["Acme Files"]);
    expect(relaunched.selectedTools("project-one").map((tool) => tool.toolName)).toEqual([
      "read_file",
    ]);
    expect(listMcpOperations(reopened, "project-one").map((row) => row.operation)).toEqual([
      "install",
      "remove",
      "install",
    ]);
  });

  it("lands a retried tool call as one operation, not two", async () => {
    const h = harness();

    // The same tool call id twice is a REPLAY — a retry after a lost response,
    // which a network transport makes ordinary. Two rows would tell a person
    // auditing that two installs happened.
    await h.call(
      "mcp.install",
      { ...LOCAL, tools: "read_file", confirm: "apply" },
      { toolCallId: "tc-replay" },
    );
    await h.call(
      "mcp.install",
      { ...LOCAL, tools: "read_file", confirm: "apply" },
      { toolCallId: "tc-replay" },
    );

    expect(listMcpOperations(h.db, "project-one")).toHaveLength(1);
    expect(listMcpServers(h.db, "project-one")).toHaveLength(1);
  });
});

/**
 * The properties the ticket names as acceptance 2 and 3, proved at the seam
 * that actually decides them.
 *
 * Deliberately NOT proved end to end through a started Session: a Ticket
 * Session does not hold `session.start`, and a subagent only inherits MCP tools
 * its parent already had, so neither could observe a newly installed tool. What
 * decides the answer is `resolveAgentToolSurface` over the project's selected
 * definitions, so that is what is asked.
 */
describe("what an install reaches, and what it must not", () => {
  const CAPABILITIES = { coding: ["read"], interaction: ["ask_user"] } as const;

  function surfaceFor(h: ReturnType<typeof harness>) {
    return resolveAgentToolSurface({
      role: "ticket",
      capabilities: {
        coding: [...CAPABILITIES.coding],
        interaction: [...CAPABILITIES.interaction],
      },
      mcpTools: h.settings.selectedTools("project-one"),
    });
  }

  it("puts the selected tools in a NEW Session's resolved surface (acceptance 2)", async () => {
    const h = harness();
    await installed(h);

    const surface = surfaceFor(h);

    const selected = h.settings.selectedTools("project-one");
    expect(selected.map((tool) => tool.toolName)).toEqual(["read_file"]);
    expect(surface).toContain(selected[0]!.providerName);
    // Only the SELECTED one: a discovered tool nobody turned on is not offered.
    expect(surface.filter((tool) => tool.startsWith("mcp__"))).toHaveLength(1);
  });

  it("leaves the calling Session's frozen tool list byte-identical (acceptance 3)", async () => {
    const h = harness();
    // The caller was born before this project had any MCP server, so its
    // surface was resolved from the tools selected AT THAT MOMENT. Capturing
    // the inputs, not the output, is the whole point: re-resolving from live
    // settings afterwards is the thing that must still produce the same bytes,
    // and comparing a local array to itself could never have shown that.
    const birth = {
      role: "project",
      capabilities: {
        coding: [...CAPABILITIES.coding],
        interaction: [...CAPABILITIES.interaction],
      },
      mcpTools: h.settings.selectedTools("project-one"),
    } as const;
    const before = JSON.stringify(resolveAgentToolSurface(birth));

    const result = await installed(h);

    // Re-resolved from the SAME birth inputs, against a project whose settings
    // have since changed. A surface that read live settings instead of the ones
    // it was born with would differ here.
    const after = JSON.stringify(resolveAgentToolSurface(birth));
    expect(after).toBe(before);
    expect(JSON.parse(after).some((tool: string) => tool.startsWith("mcp__"))).toBe(false);
    // And the project really did change underneath it, or the assertion above
    // would be proving nothing at all.
    expect(h.settings.selectedTools("project-one").map((tool) => tool.toolName)).toEqual([
      "read_file",
    ]);
    // The result says so in plain words rather than leaving the model to
    // discover it by calling a tool that is not there.
    expect(result.text).toContain("not available in this Session");
  });

  it("breaks reattachment for an older Session once its server is removed (acceptance 8)", async () => {
    const h = harness();
    await installed(h);
    const born = h.settings.selectedTools("project-one");

    // Reattachment works while the server is configured.
    expect(
      serversForFrozenMcpTools(h.settings.list("project-one"), born).map((server) => server.id),
    ).toEqual(["files"]);

    await h.call("mcp.remove", { server: "files", confirm: "apply" });

    expect(() => serversForFrozenMcpTools(h.settings.list("project-one"), born)).toThrow(
      /required MCP server is missing/,
    );
    // And re-adding under the SAME id is what puts those Sessions back —
    // the recovery mcp_remove's own warning names.
    await installed(h);
    expect(
      serversForFrozenMcpTools(h.settings.list("project-one"), born).map((server) => server.id),
    ).toEqual(["files"]);
  });

  it("keeps reattachment working when the server is only disabled", async () => {
    const h = harness();
    await installed(h);
    const born = h.settings.selectedTools("project-one");

    await h.call("mcp.disable", { server: "files" });

    expect(
      serversForFrozenMcpTools(h.settings.list("project-one"), born).map((server) => server.id),
    ).toEqual(["files"]);
    // But a Session created from now on is offered nothing.
    expect(surfaceFor(h).filter((tool) => tool.startsWith("mcp__"))).toEqual([]);
  });
});
