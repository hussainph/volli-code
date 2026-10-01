/**
 * Credentials are routed to the person, and their values go to the one server
 * they belong to and nowhere else (VC-470).
 *
 * Two families of assertion, both made directly rather than inferred:
 *
 * 1. A header reference `${TOKEN}` reaches a real HTTP fixture server, and the
 *    value appears in no database row, no log line, no `mcp_operations` audit
 *    record, no verb result, no MCP tool result and no question put to the
 *    person — the four things a transcript is made of.
 * 2. A connection blocked on a sign-in or a missing credential asks the person
 *    driving (`confirm.mcp-sign-in` / `confirm.mcp-credential`), and the agent
 *    is told an outcome — signed in, declined, still missing — never a value.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_AUTHORITY_POLICY,
  type McpServerDraft,
  type RuntimeAskChoice,
  type RuntimeAskRequest,
  type RuntimeSessionIdentity,
} from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createAgentToolDoor, type VerbBudgetAsk } from "../agent-tool-door";
import { listMcpOperations } from "../db/mcp-operations-repo";
import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject, type TestDb } from "../db/test-helpers";
import { FileMcpCredentialStore, MemoryMcpCredentialStore } from "./credential-store";
import {
  McpCredentialMissingError,
  missingMcpSecretSlots,
  resolveMcpCredentialEntries,
} from "./credentials";
import { approveInBrowser, startOAuthFixture, type OAuthFixture } from "./fixtures/oauth-fixture";
import { McpOAuthBroker } from "./oauth";
import { McpSessionHost } from "./session-host";
import { McpSettingsService } from "./settings";

const CALLER: RuntimeSessionIdentity = {
  role: "project",
  sessionId: "caller-session",
  rootThreadId: "thread-1",
  attachmentId: "attachment-1",
  projectId: "p1",
  ticketId: null,
};

let ctx: TestDb;
let dir: string;
const closers: Array<() => Promise<void>> = [];
let logged: string[];

beforeEach(() => {
  ctx = openTestDb();
  insertProject(ctx.db, testProject({ id: "p1", path: "/repo/project" }));
  dir = mkdtempSync(join(tmpdir(), "volli-mcp-credentials-"));
  logged = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(
        args
          .map((arg) => (arg instanceof Error ? `${arg.message} ${arg.stack}` : String(arg)))
          .join(" "),
      );
    });
  }
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(closers.splice(0).map((close) => close()));
  ctx.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

/** Every row of every table, as text. */
function databaseText(): string {
  const tables = ctx.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
    name: string;
  }[];
  return tables
    .map(({ name }) => JSON.stringify(ctx.db.prepare(`SELECT * FROM "${name}"`).all()))
    .join("\n");
}

/**
 * A plain Streamable HTTP MCP server that demands one exact Authorization
 * header and offers no OAuth: the shape of a server configured with an API key.
 */
async function read(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function headerServer(expected: string) {
  const received: string[] = [];
  const server: Server = createServer((request, response) => {
    void (async () => {
      received.push(request.headers.authorization ?? "");
      if (request.method !== "POST") {
        response.writeHead(request.method === "DELETE" ? 200 : 405).end();
        return;
      }
      const message = JSON.parse(await read(request)) as { id?: number; method: string };
      if (request.headers.authorization !== expected) {
        response.writeHead(401).end("no");
        return;
      }
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: "2025-11-25",
              capabilities: { tools: {} },
              serverInfo: { name: "header-fixture", version: "1" },
            }
          : message.method === "tools/list"
            ? {
                tools: [
                  { name: "lookup", description: "Look up", inputSchema: { type: "object" } },
                ],
              }
            : { content: [{ type: "text", text: "lookup ok" }] };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { url: `http://127.0.0.1:${address.port}/mcp`, received };
}

function harness(environment: Record<string, string> = {}) {
  const store = new FileMcpCredentialStore(join(dir, "mcp-credentials.json"));
  const broker = new McpOAuthBroker({ store, openExternal: approveInBrowser });
  const settings = new McpSettingsService({
    db: ctx.db,
    credentials: store,
    oauth: broker,
    environment: () => environment,
  });
  const door = createAgentToolDoor({
    db: ctx.db,
    projects: () => [{ id: "p1", name: "Project", path: "/repo/project" } as never],
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
    mcp: () => settings,
  });
  let calls = 0;
  const verb = (name: string, input: Record<string, unknown>, ask?: VerbBudgetAsk) => {
    calls += 1;
    return door(
      CALLER,
      { verb: name as never, input, toolCallId: `tc-${calls}` },
      new AbortController().signal,
      ask,
    );
  };
  const host = (servers: readonly McpServerDraft[]) => {
    const created = new McpSessionHost({
      workspacePath: "/repo/project",
      servers,
      open: settings.opener(),
      credentialsRevision: (id) => store.revision(id),
      signIn: (server, signal) => settings.signIn({ projectId: "p1", serverId: server.id, signal }),
    });
    closers.push(() => created.close());
    return created;
  };
  return { store, settings, verb, host };
}

function asking(
  choices: Partial<Record<RuntimeAskRequest["cause"], RuntimeAskChoice>>,
  onAsk?: (request: RuntimeAskRequest) => void,
) {
  const seen: RuntimeAskRequest[] = [];
  const ask = async (request: RuntimeAskRequest): Promise<RuntimeAskChoice> => {
    seen.push(request);
    onAsk?.(request);
    return choices[request.cause] ?? "refuse";
  };
  return { ask, seen };
}

describe("a header reference reaches its server and nothing else", () => {
  it("sends ${TOKEN} to the fixture, and the value appears in no row, log, audit record, result or question", async () => {
    const sentinel = `tok-${Math.random().toString(36).slice(2)}-SENTINEL`;
    const fixture = await headerServer(`Bearer ${sentinel}`);
    const h = harness({ TOKEN: sentinel });
    const server: McpServerDraft = {
      id: "api",
      name: "Header API",
      enabled: true,
      transport: {
        type: "streamable-http",
        url: fixture.url,
        headers: [
          { name: "Authorization", source: { kind: "reference", template: "Bearer ${TOKEN}" } },
        ],
      },
    };

    // A person configures it in Settings.
    const saved = await h.settings.save({ projectId: "p1", server, enabledTools: ["lookup"] });
    expect(saved.ok).toBe(true);
    // An agent lists it, refreshes it, re-installs it unchanged, and calls it.
    const { ask, seen } = asking({ "confirm.mcp-install": "allow" });
    const listed = await h.verb("mcp.list", {});
    const refreshed = await h.verb("mcp.refresh", { server: "api" }, ask);
    const reinstalled = await h.verb(
      "mcp.install",
      { id: "api", name: "Header API", url: fixture.url, tools: "lookup", confirm: "apply" },
      ask,
    );
    const called = await h
      .host([server])
      .port.call(
        { serverId: "api", toolName: "lookup", arguments: {}, toolCallId: "c1" },
        new AbortController().signal,
        ask,
      );

    // It reached the server it belongs to, on every request.
    expect(called).toEqual({ content: [{ type: "text", text: "lookup ok" }], isError: false });
    expect(fixture.received.length).toBeGreaterThan(0);
    expect(new Set(fixture.received)).toEqual(new Set([`Bearer ${sentinel}`]));
    // The person's header survived the agent's same-target re-install.
    expect(reinstalled.text).toContain("Installed Header API");
    expect(h.settings.list("p1")[0]?.transport).toEqual(server.transport);
    // The agent can see that a credential exists, and how it is kept — not what it is.
    expect(listed.text).toContain("header Authorization (reference)");
    expect(listed.text).not.toContain("${TOKEN}");

    const everywhere = [
      databaseText(),
      JSON.stringify(listMcpOperations(ctx.db, "p1")),
      logged.join("\n"),
      JSON.stringify([listed, refreshed, reinstalled, called]),
      JSON.stringify(seen),
      // A reference is stored as a reference: the value is not on disk at all.
      readFileSync(join(dir, "mcp-credentials.json"), "utf8").toString(),
    ];
    for (const text of everywhere) expect(text).not.toContain(sentinel);
  });

  it("does not follow an agent's re-install to a different endpoint: the person's header is dropped, not forwarded", async () => {
    const sentinel = `tok-${Math.random().toString(36).slice(2)}-SENTINEL`;
    const original = await headerServer(`Bearer ${sentinel}`);
    const elsewhere = await headerServer("Bearer none");
    const h = harness({ TOKEN: sentinel });
    await h.settings.save({
      projectId: "p1",
      server: {
        id: "api",
        name: "Header API",
        enabled: true,
        transport: {
          type: "streamable-http",
          url: original.url,
          headers: [{ name: "Authorization", source: { kind: "secret" } }],
        },
      },
      secrets: { "header:authorization": `Bearer ${sentinel}` },
      enabledTools: [],
    });
    expect(h.store.read("api")?.secrets).toEqual({ "header:authorization": `Bearer ${sentinel}` });

    const { ask, seen } = asking({
      "confirm.mcp-install": "allow",
      "confirm.mcp-credential": "refuse",
    });
    const preview = await h.verb("mcp.install", {
      id: "api",
      name: "Header API",
      url: elsewhere.url,
    });
    const result = await h.verb(
      "mcp.install",
      { id: "api", name: "Header API", url: elsewhere.url, confirm: "apply" },
      ask,
    );

    expect(preview.text).toMatch(/do not follow it to a different endpoint/);
    expect(seen[0]?.reason).toMatch(/would be deleted/);
    // The new endpoint never saw the person's credential…
    expect(elsewhere.received.every((header) => !header.includes(sentinel))).toBe(true);
    // …which also means it refused the unauthenticated connection, so nothing
    // was installed, and the person's original configuration and secret stand.
    expect(result.text).toMatch(/Could not install Header API/);
    expect(h.settings.list("p1")[0]?.transport).toMatchObject({ url: original.url });
    expect(h.store.read("api")?.secrets).toEqual({ "header:authorization": `Bearer ${sentinel}` });
    expect(JSON.stringify([preview, result, seen, listMcpOperations(ctx.db, "p1")])).not.toContain(
      sentinel,
    );
  });

  it("stores a typed secret in the user-only file only, and reports only which slots hold one", async () => {
    const sentinel = `typed-${Math.random().toString(36).slice(2)}-SENTINEL`;
    const fixture = await headerServer(sentinel);
    const h = harness();
    const server: McpServerDraft = {
      id: "typed",
      name: "Typed",
      enabled: true,
      transport: {
        type: "streamable-http",
        url: fixture.url,
        headers: [{ name: "Authorization", source: { kind: "secret" } }],
      },
    };

    // Test-and-discover uses the pending value without storing it…
    const tested = await h.settings.test({
      projectId: "p1",
      server,
      secrets: { "header:authorization": sentinel },
    });
    expect(tested.ok).toBe(true);
    expect(h.store.read("typed")).toBeUndefined();
    // …and the save that succeeds stores it, ignoring slots nobody configured.
    const saved = await h.settings.save({
      projectId: "p1",
      server,
      enabledTools: [],
      secrets: { "header:authorization": sentinel, "header:x-unconfigured": "dropped" },
    });
    expect(saved.ok).toBe(true);
    expect(h.store.read("typed")?.secrets).toEqual({ "header:authorization": sentinel });
    expect(h.settings.accessFor("p1")).toEqual({
      typed: { signIn: "not-applicable", missingSecrets: [] },
    });
    expect(databaseText()).not.toContain(sentinel);
    expect(JSON.stringify(h.settings.list("p1"))).not.toContain(sentinel);
    expect(readFileSync(join(dir, "mcp-credentials.json"), "utf8")).toContain(sentinel);

    // Removing the server takes its secret with it.
    expect(h.settings.remove({ projectId: "p1", serverId: "typed" })).toEqual({ ok: true });
    expect(h.store.read("typed")).toBeUndefined();
  });
});

/** A remote server whose Authorization header is a stored secret. */
function keyedServer(url: string): McpServerDraft {
  return {
    id: "keyed",
    name: "Keyed API",
    enabled: true,
    transport: {
      type: "streamable-http",
      url,
      headers: [{ name: "Authorization", source: { kind: "secret" } }],
    },
  };
}

describe("a missing credential is routed to the person", () => {
  const server = keyedServer;

  it("asks confirm.mcp-credential, and retries the call once the person has added it in Settings", async () => {
    const value = `added-${Date.now()}-SENTINEL`;
    const fixture = await headerServer(value);
    const h = harness();
    const target = server(fixture.url);
    const { ask, seen } = asking({ "confirm.mcp-credential": "allow" }, () => {
      // The person adds the value in Settings while the question is up.
      h.store.update("keyed", (current) => ({
        ...current,
        secrets: { "header:authorization": value },
      }));
    });

    const result = await h
      .host([target])
      .port.call(
        { serverId: "keyed", toolName: "lookup", arguments: {}, toolCallId: "c1" },
        new AbortController().signal,
        ask,
      );

    expect(result).toEqual({ content: [{ type: "text", text: "lookup ok" }], isError: false });
    expect(seen).toEqual([
      expect.objectContaining({
        cause: "confirm.mcp-credential",
        tool: "lookup",
        toolCallId: "c1",
      }),
    ]);
    expect(seen[0]?.reason).toContain("header Authorization");
    expect(seen[0]?.reason).toMatch(/never sees the value/);
    expect(JSON.stringify([result, seen])).not.toContain(value);
  });

  it("says the credential is still missing when the person allowed without adding it", async () => {
    const fixture = await headerServer("unused");
    const h = harness();
    const { ask } = asking({ "confirm.mcp-credential": "allow" });

    const result = await h
      .host([server(fixture.url)])
      .port.call(
        { serverId: "keyed", toolName: "lookup", arguments: {}, toolCallId: "c1" },
        new AbortController().signal,
        ask,
      );

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/still missing header Authorization/);
    expect(fixture.received).toEqual([]);
  });

  it("tells an unattended Session in plain words that a person must add it", async () => {
    const fixture = await headerServer("unused");
    const h = harness();

    const result = await h
      .host([server(fixture.url)])
      .port.call(
        { serverId: "keyed", toolName: "lookup", arguments: {}, toolCallId: "c1" },
        new AbortController().signal,
      );

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(
      /needs header Authorization before lookup can run, and only a person can add it/,
    );
  });

  it("names a missing secret in Settings before anything fails", () => {
    const store = new MemoryMcpCredentialStore();
    expect(missingMcpSecretSlots(server("http://127.0.0.1:1/mcp"), store)).toEqual([
      "header Authorization",
    ]);
    expect(() =>
      resolveMcpCredentialEntries(
        { id: "keyed", name: "Keyed API" },
        "env",
        [{ name: "API_KEY", source: { kind: "reference", template: "${UNSET_ONE}" } }],
        { store, environment: {} },
      ),
    ).toThrow(McpCredentialMissingError);
  });
});

describe("an agent's install of a server that needs a sign-in", () => {
  let fixture: OAuthFixture;
  beforeEach(async () => {
    fixture = await startOAuthFixture();
    closers.push(() => fixture.close());
  });

  const install = () => ({
    id: "oauthy",
    name: "OAuth Fixture",
    url: fixture.mcpUrl,
    tools: "whoami",
    confirm: "apply",
  });

  it("asks the person to sign in, and installs once they have — the agent learns only that it worked", async () => {
    const h = harness();
    const { ask, seen } = asking({
      "confirm.mcp-install": "allow",
      "confirm.mcp-sign-in": "allow",
    });

    const result = await h.verb("mcp.install", install(), ask);

    expect(seen.map((request) => request.cause)).toEqual([
      "confirm.mcp-install",
      "confirm.mcp-sign-in",
    ]);
    expect(result.text).toContain("Installed OAuth Fixture (id oauthy) with 1 of 2 tools on.");
    expect(result.text).toContain("The person driving signed in to OAuth Fixture.");
    expect(h.settings.accessFor("p1")).toEqual({
      oauthy: { signIn: "signed-in", missingSecrets: [] },
    });
    const visible =
      JSON.stringify([result, seen, listMcpOperations(ctx.db, "p1"), logged]) + databaseText();
    for (const token of fixture.issuedTokens) expect(visible).not.toContain(token);
  });

  it("installs nothing when the person declines to sign in, and says so", async () => {
    const h = harness();
    const { ask } = asking({ "confirm.mcp-install": "allow", "confirm.mcp-sign-in": "refuse" });

    const result = await h.verb("mcp.install", install(), ask);

    expect(result.text).toMatch(/declined to sign in to OAuth Fixture/);
    expect(h.settings.list("p1")).toEqual([]);
    expect(fixture.seen.authorizations).toEqual([]);
    expect(listMcpOperations(ctx.db, "p1")[0]).toMatchObject({ outcome: "failed" });
  });

  it("tells an unattended Session that a person must sign in", async () => {
    const h = harness();

    const result = await h.verb("mcp.install", install());

    expect(result.text).toMatch(
      /needs a person to sign in before Volli can read its tools, and nobody could be asked/,
    );
    expect(h.settings.list("p1")).toEqual([]);
  });

  it("previews a server that needs a sign-in without asking anyone", async () => {
    const h = harness();
    const result = await h.verb("mcp.preview", {
      id: "oauthy",
      name: "OAuth Fixture",
      url: fixture.mcpUrl,
    });
    expect(result.text).toMatch(/needs a person to sign in before its tools can be read/);
  });
});
