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
import { closeSync, fstatSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServerDraft, RuntimeAskChoice, RuntimeAskRequest } from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { putMcpServer } from "../db/mcp-servers-repo";
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

function harness(
  options: {
    environment?: Record<string, string>;
    requestTimeoutMs?: number;
    /** Stand-in for the browser; approves at once unless replaced. */
    browser?: (url: string) => Promise<void>;
  } = {},
) {
  const store = new FileMcpCredentialStore(join(dir, "mcp-credentials.json"));
  const opened: string[] = [];
  const broker = new McpOAuthBroker({
    store,
    openExternal: async (url) => {
      opened.push(url);
      await (options.browser ?? approveInBrowser)(url);
    },
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
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

/** A saved server row, as Settings would leave it. */
function seedServer(server: McpServerDraft): void {
  putMcpServer(ctx.db, {
    ...server,
    projectId: "p1",
    provenance: { source: null, registryType: null, version: null, digest: null },
    catalog: [],
    stale: false,
    error: null,
    refreshedAt: 1,
    createdAt: 1,
    updatedAt: 1,
  });
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
    const fd = openSync(join(dir, "mcp-credentials.json"), "r");
    const mode = fstatSync(fd).mode & 0o777;
    const stored = readFileSync(fd, "utf8");
    closeSync(fd);
    expect(mode).toBe(0o600);
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

describe("signing in — scope, time limits and who may stop it", () => {
  it("asks for the scope a person configured instead of the scopes the server advertises", async () => {
    fixture = await startOAuthFixture();
    const h = harness();
    const server = remote(fixture.mcpUrl, { scope: "read admin" });

    await signedInServer(h, server);

    expect(fixture.seen.authorizations[0]?.scope?.split(" ").toSorted()).toEqual(["admin", "read"]);
    // With the scope granted up front, the admin tool needs no step-up.
    const { ask } = asking("allow");
    await expect(
      h.host(server).port.call(call("admin_op"), new AbortController().signal, ask),
    ).resolves.toMatchObject({ isError: false });
    expect(ask).not.toHaveBeenCalled();
  });

  it("gives up on a refresh the authorization server never answers, without calling it a sign-in", async () => {
    fixture = await startOAuthFixture({ hangRefresh: true });
    const h = harness({ requestTimeoutMs: 300 });
    const server = await signedInServer(h, remote(fixture.mcpUrl));
    fixture.expireAccessTokens();

    const started = Date.now();
    const result = await h.host(server).port.call(call("whoami"), new AbortController().signal);

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result).toEqual({
      content: [{ type: "text", text: "MCP server Fixture OAuth call failed." }],
      isError: true,
    });
    // A hung request says nothing about the grant: no sign-in is demanded.
    expect(h.broker.signInState(server)).toBe("signed-in");
  });

  it("keeps a sign-in running for the person when the agent that asked stops waiting, and stops it on Cancel", async () => {
    fixture = await startOAuthFixture();
    const browserOpened = Promise.withResolvers<void>();
    // The page opens; the person has not approved yet.
    const h = harness({ browser: async () => browserOpened.resolve() });
    const server = remote(fixture.mcpUrl);

    const agent = new AbortController();
    const agentWait = h.settings.signIn({ projectId: "p1", server, signal: agent.signal });
    const personWait = h.settings.signIn({ projectId: "p1", server });
    await browserOpened.promise;
    agent.abort(new Error("turn interrupted"));

    await expect(agentWait).resolves.toMatchObject({ ok: false, cancelled: true });
    expect(h.broker.signingIn(server.id)).toBe(true);

    h.settings.cancelSignIn({ projectId: "p1", serverId: server.id });
    await expect(personWait).resolves.toEqual({
      ok: false,
      cancelled: true,
      message: "The sign-in to Fixture OAuth was cancelled.",
    });
    await vi.waitFor(() => expect(h.broker.signingIn(server.id)).toBe(false));
    expect(h.opened).toHaveLength(1);
  });

  it("stops a sign-in nobody is waiting on any more", async () => {
    fixture = await startOAuthFixture();
    const browserOpened = Promise.withResolvers<void>();
    const h = harness({ browser: async () => browserOpened.resolve() });
    const server = remote(fixture.mcpUrl);

    const only = new AbortController();
    const wait = h.settings.signIn({ projectId: "p1", server, signal: only.signal });
    await browserOpened.promise;
    only.abort(new Error("gone"));

    await expect(wait).resolves.toMatchObject({ ok: false, cancelled: true });
    await vi.waitFor(() => expect(h.broker.signingIn(server.id)).toBe(false));
  });
});

describe("signing in — what Volli refuses", () => {
  it.each([
    ["correct", true],
    ["wrong", false],
    ["withheld", false],
  ] as const)("checks the RFC 9207 issuer on the redirect (%s)", async (iss, signsIn) => {
    fixture = await startOAuthFixture({ iss });
    const h = harness();

    const outcome = await h.settings.signIn({ projectId: "p1", server: remote(fixture.mcpUrl) });

    if (signsIn) {
      expect(outcome).toEqual({ ok: true, message: "Signed in to Fixture OAuth." });
    } else {
      expect(outcome).toMatchObject({
        ok: false,
        message: expect.stringContaining("authorization server other than the one it started with"),
      });
      // The code was never exchanged.
      expect(fixture.seen.tokenGrants).toEqual([]);
    }
  });

  it("refuses an authorization server that does not say it supports PKCE with S256, before any browser opens", async () => {
    for (const pkceMethods of [null, ["plain"]] as const) {
      fixture = await startOAuthFixture({ pkceMethods });
      const h = harness();

      const outcome = await h.settings.signIn({ projectId: "p1", server: remote(fixture.mcpUrl) });

      expect(outcome).toMatchObject({
        ok: false,
        message: expect.stringContaining("PKCE with S256"),
      });
      expect(h.opened).toEqual([]);
      await fixture.close();
      fixture = null;
    }
  });

  it("never hands a non-https authorization page to the browser", async () => {
    fixture = await startOAuthFixture({
      authorizationEndpoint: "http://auth.example.test/authorize",
    });
    const h = harness();

    const outcome = await h.settings.signIn({ projectId: "p1", server: remote(fixture.mcpUrl) });

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining("not an https address"),
    });
    expect(h.opened).toEqual([]);
  });

  it("refuses to sign in to a plain-http endpoint on another host, before any request", async () => {
    const h = harness();
    const outcome = await h.settings.signIn({
      projectId: "p1",
      server: remote("http://mcp.example.test/mcp"),
    });
    expect(outcome).toMatchObject({ ok: false, message: expect.stringContaining("plain http") });
    expect(h.opened).toEqual([]);
  });

  it("refuses a Session's sign-in when the stored address no longer matches the one it was started with", async () => {
    fixture = await startOAuthFixture();
    const h = harness();
    const frozen = await signedInServer(h, remote(fixture.mcpUrl));
    h.settings.signOut({ projectId: "p1", serverId: frozen.id });
    // Someone re-points the stored row; the running Session still holds the old address.
    const moved = await startOAuthFixture();
    putMcpServer(ctx.db, { ...frozen, transport: { type: "streamable-http", url: moved.mcpUrl } });
    const host = new McpSessionHost({
      workspacePath: "/repo/project",
      servers: [frozen],
      open: h.settings.opener(),
      signIn: (target, signal) =>
        h.settings.signIn({
          projectId: "p1",
          serverId: target.id,
          signal,
          ...(target.transport.type === "streamable-http"
            ? { expectedUrl: target.transport.url }
            : {}),
        }),
    });
    hosts.push(host);
    const { ask } = asking("allow");
    const openedBefore = h.opened.length;

    const result = await host.port.call(call("whoami"), new AbortController().signal, ask);

    expect(JSON.stringify(result.content)).toMatch(/address changed since this Session started/);
    expect(h.opened).toHaveLength(openedBefore);
    expect(moved.seen.authorizations).toEqual([]);
    await moved.close();
  });

  it("cancels a sign-in still waiting on the browser when the person signs out", async () => {
    fixture = await startOAuthFixture();
    const browserOpened = Promise.withResolvers<void>();
    const h = harness({ browser: async () => browserOpened.resolve() });
    const server = remote(fixture.mcpUrl);
    seedServer(server);

    const waiting = h.settings.signIn({ projectId: "p1", serverId: server.id });
    await browserOpened.promise;
    h.settings.signOut({ projectId: "p1", serverId: server.id });

    await expect(waiting).resolves.toMatchObject({ ok: false, cancelled: true });
  });

  it("clears needs-sign-in once the server connects without asking for one", async () => {
    fixture = await startOAuthFixture({ requireAuth: false });
    const h = harness();
    const server = remote(fixture.mcpUrl);
    h.broker.markRefused(
      { id: server.id, name: server.name, url: fixture.mcpUrl },
      { insufficientScope: false },
    );
    expect(h.broker.signInState(server)).toBe("needs-sign-in");

    await expect(h.settings.test({ projectId: "p1", server })).resolves.toMatchObject({ ok: true });

    expect(h.broker.signInState(server)).toBe("signed-out");
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
