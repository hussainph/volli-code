/**
 * OAuth for remote MCP servers, end to end against a loopback authorization
 * server (VC-470 acceptance: sign in with dynamic registration, refresh, step
 * up, sign out; a pre-registered client; tokens only in the user-only file).
 *
 * Nothing is faked between Volli and the fixture: the real pi-mcp client, the
 * real Streamable HTTP transport, the real loopback callback server, and a
 * `McpSettingsService` over a real database and a real credential file. The
 * only stand-in is the browser, which follows the authorization redirect the
 * way approving consent would.
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServerDraft, RuntimeAskChoice, RuntimeAskRequest } from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject, type TestDb } from "../db/test-helpers";
import { FileMcpCredentialStore } from "./credential-store";
import { approveInBrowser, startOAuthFixture, type OAuthFixture } from "./fixtures/oauth-fixture";
import { McpOAuthBroker, mcpOAuthCallbackOptions } from "./oauth";
import { McpSessionHost } from "./session-host";
import { McpSettingsService } from "./settings";

let ctx: TestDb;
let dir: string;
let fixture: OAuthFixture | null = null;
const hosts: McpSessionHost[] = [];

beforeEach(() => {
  ctx = openTestDb();
  insertProject(ctx.db, testProject({ id: "p1", path: "/repo/project" }));
  dir = mkdtempSync(join(tmpdir(), "volli-mcp-oauth-"));
});

afterEach(async () => {
  await Promise.allSettled(hosts.splice(0).map((host) => host.close()));
  await fixture?.close();
  fixture = null;
  ctx.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

function harness(options: { environment?: Record<string, string> } = {}) {
  const store = new FileMcpCredentialStore(join(dir, "mcp-credentials.json"));
  const opened: string[] = [];
  const broker = new McpOAuthBroker({
    store,
    openExternal: async (url) => {
      opened.push(url);
      await approveInBrowser(url);
    },
  });
  const settings = new McpSettingsService({
    db: ctx.db,
    credentials: store,
    oauth: broker,
    environment: () => options.environment ?? {},
  });
  const host = (server: McpServerDraft) => {
    const created = new McpSessionHost({
      workspacePath: "/repo/project",
      servers: [server],
      open: settings.opener(),
      credentialsRevision: (id) => store.revision(id),
      signIn: (target, signal) => settings.signIn({ projectId: "p1", serverId: target.id, signal }),
    });
    hosts.push(created);
    return created;
  };
  return { store, broker, settings, opened, host };
}

function remote(
  url: string,
  oauth?: McpServerDraft["transport"] extends infer T
    ? T extends { oauth?: infer O }
      ? O
      : never
    : never,
): McpServerDraft {
  return {
    id: "remote-1",
    name: "Fixture OAuth",
    enabled: true,
    transport: { type: "streamable-http", url, ...(oauth === undefined ? {} : { oauth }) },
  };
}

/** Every row of every table, as text — where a token must never appear. */
function databaseText(): string {
  const tables = ctx.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
    name: string;
  }[];
  return tables
    .map(({ name }) => JSON.stringify(ctx.db.prepare(`SELECT * FROM "${name}"`).all()))
    .join("\n");
}

function asking(choice: RuntimeAskChoice) {
  const seen: RuntimeAskRequest[] = [];
  return {
    seen,
    ask: vi.fn(async (request: RuntimeAskRequest) => {
      seen.push(request);
      return choice;
    }),
  };
}

const call = (toolName: string, toolCallId = `tc-${toolName}`) => ({
  serverId: "remote-1",
  toolName,
  arguments: {},
  toolCallId,
});

async function signedInServer(h: ReturnType<typeof harness>, server: McpServerDraft) {
  const first = await h.settings.save({ projectId: "p1", server, enabledTools: [] });
  expect(first).toMatchObject({ ok: false, blocked: { kind: "sign-in" } });
  const signedIn = await h.settings.signIn({ projectId: "p1", server });
  expect(signedIn).toEqual({ ok: true, message: "Signed in to Fixture OAuth." });
  const saved = await h.settings.save({
    projectId: "p1",
    server,
    enabledTools: ["whoami", "admin_op"],
  });
  if (!saved.ok) throw new Error(saved.error);
  return saved.server;
}

describe("signing in to a remote MCP server", () => {
  it("signs in with dynamic client registration and PKCE, storing tokens only in the user-only file", async () => {
    fixture = await startOAuthFixture();
    const h = harness();
    const server = remote(fixture.mcpUrl);

    const saved = await signedInServer(h, server);

    expect(saved.catalog.map((tool) => tool.name)).toEqual(["whoami", "admin_op"]);
    expect(fixture.seen.registrations).toBe(1);
    expect(fixture.seen.authorizations).toEqual([
      {
        scope: "read",
        clientId: "dyn-1",
        challengeMethod: "S256",
        redirectUri: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/callback$/),
      },
    ]);
    expect(fixture.seen.tokenGrants).toEqual(["authorization_code"]);
    expect(h.opened).toHaveLength(1);
    expect(new URL(h.opened[0]!).origin).toBe(fixture.base);
    expect(h.settings.accessFor("p1")).toEqual({
      "remote-1": { signIn: "signed-in", missingSecrets: [] },
    });

    // The file holds the tokens, readable by this user only…
    const file = join(dir, "mcp-credentials.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const stored = readFileSync(file, "utf8");
    expect(stored).toContain(fixture.issuedTokens[0]);
    // …the PKCE verifier and the state of a finished sign-in are not kept…
    expect(stored).not.toContain("codeVerifier");
    expect(stored).not.toContain("oauthState");
    // …and the database never sees any of it.
    const database = databaseText();
    for (const token of fixture.issuedTokens) expect(database).not.toContain(token);
  });

  it("refreshes an expired access token for a running Session without asking anyone", async () => {
    fixture = await startOAuthFixture();
    const h = harness();
    const server = await signedInServer(h, remote(fixture.mcpUrl));
    const host = h.host(server);
    const { ask } = asking("allow");

    await expect(
      host.port.call(call("whoami", "one"), new AbortController().signal, ask),
    ).resolves.toEqual({
      content: [{ type: "text", text: "whoami ok for dyn-1" }],
      isError: false,
    });
    fixture.expireAccessTokens();
    await expect(
      host.port.call(call("whoami", "two"), new AbortController().signal, ask),
    ).resolves.toEqual({
      content: [{ type: "text", text: "whoami ok for dyn-1" }],
      isError: false,
    });

    expect(fixture.seen.tokenGrants).toEqual(["authorization_code", "refresh_token"]);
    expect(ask).not.toHaveBeenCalled();
    // The refreshed token is the one the second call carried.
    const latest = fixture.issuedTokens.at(-2);
    expect(fixture.seen.toolCalls.at(-1)?.token).toBe(latest);
    expect(h.broker.signInState(server)).toBe("signed-in");
  });

  it("asks the person to step up when a tool needs more scope, then retries the call", async () => {
    fixture = await startOAuthFixture();
    const h = harness();
    const server = await signedInServer(h, remote(fixture.mcpUrl));
    const host = h.host(server);
    const { ask, seen } = asking("allow");

    const result = await host.port.call(call("admin_op"), new AbortController().signal, ask);

    expect(result).toEqual({
      content: [{ type: "text", text: "admin_op ok for dyn-1" }],
      isError: false,
    });
    expect(seen).toEqual([
      expect.objectContaining({
        cause: "confirm.mcp-sign-in",
        tool: "admin_op",
        toolCallId: "tc-admin_op",
        trip: "confirm",
        overridable: true,
      }),
    ]);
    expect(seen[0]?.reason).toMatch(/more access than it was granted/);
    // Step-up: a second authorization for what was granted AND what was asked
    // for, with no second registration.
    expect(fixture.seen.registrations).toBe(1);
    expect(fixture.seen.authorizations.at(-1)?.scope?.split(" ").toSorted()).toEqual([
      "admin",
      "read",
    ]);
    // The second sign-in listened on the port the registration named, so a
    // strict authorization server comparing redirect URIs still matches.
    expect(fixture.seen.authorizations.at(-1)?.redirectUri).toBe(
      fixture.seen.authorizations[0]?.redirectUri,
    );
    expect(h.broker.signInState(server)).toBe("signed-in");
    // Nothing the person or the model sees names a token.
    const visible = JSON.stringify({ result, seen });
    for (const token of fixture.issuedTokens) expect(visible).not.toContain(token);
  });

  it("signs out, after which an unattended call is told a person must sign in, and a declined one says so", async () => {
    fixture = await startOAuthFixture();
    const h = harness();
    const server = await signedInServer(h, remote(fixture.mcpUrl));

    expect(h.settings.signOut({ projectId: "p1", serverId: server.id })).toEqual({ ok: true });
    expect(h.store.read(server.id)?.oauth).toBeUndefined();
    expect(h.broker.signInState(server)).toBe("signed-out");
    expect(readFileSync(join(dir, "mcp-credentials.json"), "utf8")).not.toContain("at-");

    const unattended = await h.host(server).port.call(call("whoami"), new AbortController().signal);
    expect(unattended.isError).toBe(true);
    expect(JSON.stringify(unattended.content)).toMatch(
      /needs a person to sign in before whoami can run, and nobody could be asked/,
    );
    expect(h.broker.signInState(server)).toBe("needs-sign-in");

    const { ask } = asking("refuse");
    const declined = await h
      .host(server)
      .port.call(call("whoami"), new AbortController().signal, ask);
    expect(declined).toEqual({
      content: [
        {
          type: "text",
          text: "The person driving declined to sign in to Fixture OAuth, so whoami was not called.",
        },
      ],
      isError: true,
    });
    expect(fixture.seen.toolCalls).toEqual([]);
  });

  it("treats a dead refresh token as a sign-in a person must give", async () => {
    fixture = await startOAuthFixture();
    const h = harness();
    const server = await signedInServer(h, remote(fixture.mcpUrl));
    fixture.expireAccessTokens();
    fixture.revokeRefreshTokens();

    const result = await h.host(server).port.call(call("whoami"), new AbortController().signal);

    expect(result.isError).toBe(true);
    expect(h.broker.signInState(server)).toBe("needs-sign-in");
    // The dead grant is dropped; the registration is kept for the next sign-in.
    expect(h.store.read(server.id)?.oauth?.tokens).toBeUndefined();
    expect(h.store.read(server.id)?.oauth?.clientInformation?.client_id).toBe("dyn-1");
  });

  it("uses a pre-registered client, its secret read from a reference, on a fixed callback port", async () => {
    fixture = await startOAuthFixture({
      dynamicRegistration: false,
      preRegistered: { clientId: "volli-pre", clientSecret: "pre-secret-value" },
    });
    const port = await freePort();
    const h = harness({ environment: { FIXTURE_CLIENT_SECRET: "pre-secret-value" } });
    const server = remote(fixture.mcpUrl, {
      clientId: "volli-pre",
      clientSecret: { kind: "reference", template: "${FIXTURE_CLIENT_SECRET}" },
      callbackPort: port,
    });

    const saved = await signedInServer(h, server);

    expect(saved.transport).toEqual(server.transport);
    expect(fixture.seen.registrations).toBe(0);
    expect(fixture.seen.authorizations[0]?.clientId).toBe("volli-pre");
    expect(new URL(h.opened[0]!).searchParams.get("redirect_uri")).toBe(
      `http://127.0.0.1:${port}/callback`,
    );
    // The secret came from the environment and is stored nowhere.
    expect(readFileSync(join(dir, "mcp-credentials.json"), "utf8")).not.toContain(
      "pre-secret-value",
    );
    expect(databaseText()).not.toContain("pre-secret-value");
  });

  it("reports an unset client-secret reference by name before any browser opens", async () => {
    fixture = await startOAuthFixture({
      dynamicRegistration: false,
      preRegistered: { clientId: "volli-pre", clientSecret: "x" },
    });
    const h = harness();
    const outcome = await h.settings.signIn({
      projectId: "p1",
      server: remote(fixture.mcpUrl, {
        clientId: "volli-pre",
        clientSecret: { kind: "reference", template: "${UNSET_SECRET}" },
      }),
    });

    expect(outcome).toEqual({
      ok: false,
      cancelled: false,
      message: expect.stringContaining("${UNSET_SECRET} (for OAuth client secret)"),
    });
    expect(h.opened).toEqual([]);
  });

  it("joins a second sign-in for the same server instead of opening a second browser", async () => {
    fixture = await startOAuthFixture();
    const h = harness();
    const server = remote(fixture.mcpUrl);
    await h.settings.save({ projectId: "p1", server, enabledTools: [] });

    const [first, second] = await Promise.all([
      h.settings.signIn({ projectId: "p1", server }),
      h.settings.signIn({ projectId: "p1", server }),
    ]);

    expect(first).toEqual(second);
    expect(h.opened).toHaveLength(1);
  });

  it("cancels a sign-in that is waiting on the browser", async () => {
    fixture = await startOAuthFixture();
    const store = new FileMcpCredentialStore(join(dir, "mcp-credentials.json"));
    const controller = new AbortController();
    const broker = new McpOAuthBroker({
      store,
      // The person never comes back: the page opens and nothing follows.
      openExternal: async () => controller.abort(new Error("person closed the tab")),
    });
    const settings = new McpSettingsService({ db: ctx.db, credentials: store, oauth: broker });
    const server = remote(fixture.mcpUrl);
    await settings.save({ projectId: "p1", server, enabledTools: [] });

    await expect(
      settings.signIn({ projectId: "p1", server, signal: controller.signal }),
    ).resolves.toEqual({
      ok: false,
      cancelled: true,
      message: "The sign-in to Fixture OAuth was cancelled.",
    });
  });

  it("refuses to sign in to a server that does not use OAuth", async () => {
    const h = harness();
    const outcome = await h.settings.signIn({
      projectId: "p1",
      server: {
        id: "local",
        name: "Local",
        enabled: true,
        transport: { type: "stdio", command: "node", args: [] },
      },
    });
    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining("is not a server Volli signs in to"),
    });
  });
});

describe("mcpOAuthCallbackOptions", () => {
  it("listens on loopback, on the configured port or callback URL", () => {
    expect(mcpOAuthCallbackOptions(undefined, 1_000)).toEqual({
      host: "127.0.0.1",
      port: 0,
      path: "/callback",
      timeoutMs: 1_000,
    });
    expect(mcpOAuthCallbackOptions({ callbackPort: 8765 }, 1_000)).toMatchObject({ port: 8765 });
    expect(
      mcpOAuthCallbackOptions({ callbackUrl: "http://localhost:8080/oauth/callback" }, 1_000),
    ).toEqual({
      host: "127.0.0.1",
      redirectHost: "localhost",
      port: 8080,
      path: "/oauth/callback",
      timeoutMs: 1_000,
    });
    expect(mcpOAuthCallbackOptions({ callbackUrl: "http://[::1]/cb", callbackPort: 9 }, 1)).toEqual(
      {
        host: "::1",
        redirectHost: "::1",
        port: 9,
        path: "/cb",
        timeoutMs: 1,
      },
    );
  });
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}
