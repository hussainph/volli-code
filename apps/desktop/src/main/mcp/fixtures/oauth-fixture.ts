/**
 * A loopback OAuth authorization server and protected MCP resource, for tests
 * (VC-470).
 *
 * One HTTP server plays both parts, the way most hosted MCP servers are
 * deployed: `/mcp` is a Streamable HTTP MCP endpoint that demands a bearer
 * token, and the rest is an authorization server with metadata discovery,
 * dynamic client registration (optional), PKCE-checked authorization codes,
 * refresh tokens, and per-tool scopes so step-up can be exercised.
 *
 * `/authorize` approves at once and redirects — it is the browser and the
 * person in one — so a test's `openExternal` only has to follow the redirect.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface OAuthFixtureOptions {
  /** Offer `registration_endpoint` (dynamic client registration). Default true. */
  dynamicRegistration?: boolean;
  /** A pre-registered client the token endpoint accepts. */
  preRegistered?: { clientId: string; clientSecret: string; redirectUri?: string };
  /** Access-token lifetime in seconds. */
  expiresIn?: number;
  /** Never answer a refresh-token request: an authorization server that hangs. */
  hangRefresh?: boolean;
}

interface Grant {
  clientId: string;
  scope: string;
}

export interface OAuthFixture {
  readonly base: string;
  readonly mcpUrl: string;
  /** What the fixture has seen, for assertions. */
  readonly seen: {
    registrations: number;
    authorizations: {
      scope: string | null;
      clientId: string;
      challengeMethod: string | null;
      redirectUri: string;
    }[];
    tokenGrants: string[];
    toolCalls: { name: string; token: string }[];
    /** Every Authorization header the MCP endpoint received. */
    authorizationHeaders: string[];
    /** Every `x-api-key` header, by whether it reached `/mcp` or anywhere else. */
    apiKeys: { mcp: string[]; elsewhere: string[] };
  };
  /** Every access token issued, so a test can look for it where it must not be. */
  readonly issuedTokens: string[];
  /** Make every access token issued so far invalid, as an expiry would. */
  expireAccessTokens(): void;
  /** Make every refresh token invalid (`invalid_grant` on use). */
  revokeRefreshTokens(): void;
  close(): Promise<void>;
}

function json(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const TOOLS = [
  {
    name: "whoami",
    description: "Says which client is calling",
    inputSchema: { type: "object", properties: {} },
    scope: "read",
  },
  {
    name: "admin_op",
    description: "Needs the admin scope",
    inputSchema: { type: "object", properties: {} },
    scope: "admin",
  },
] as const;

export async function startOAuthFixture(options: OAuthFixtureOptions = {}): Promise<OAuthFixture> {
  const dynamic = options.dynamicRegistration ?? true;
  const clients = new Map<string, { secret?: string }>();
  if (options.preRegistered !== undefined) {
    clients.set(options.preRegistered.clientId, { secret: options.preRegistered.clientSecret });
  }
  const codes = new Map<
    string,
    { clientId: string; challenge: string; redirectUri: string; scope: string }
  >();
  const access = new Map<string, Grant>();
  const refresh = new Map<string, Grant>();
  const issuedTokens: string[] = [];
  const seen: OAuthFixture["seen"] = {
    registrations: 0,
    authorizations: [],
    tokenGrants: [],
    toolCalls: [],
    authorizationHeaders: [],
    apiKeys: { mcp: [], elsewhere: [] },
  };
  let base = "";

  const issue = (grant: Grant): Record<string, unknown> => {
    const accessToken = `at-${randomBytes(12).toString("hex")}`;
    const refreshToken = `rt-${randomBytes(12).toString("hex")}`;
    access.set(accessToken, grant);
    refresh.set(refreshToken, grant);
    issuedTokens.push(accessToken, refreshToken);
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: options.expiresIn ?? 3_600,
      refresh_token: refreshToken,
      scope: grant.scope,
    };
  };

  const resourceMetadata = (): string => `${base}/.well-known/oauth-protected-resource/mcp`;
  const challenge = (response: ServerResponse): void => {
    response.writeHead(401, {
      "www-authenticate": `Bearer resource_metadata="${resourceMetadata()}"`,
      "content-type": "text/plain",
    });
    response.end("unauthorized");
  };

  const handleMcp = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method === "GET") {
      response.writeHead(405).end();
      return;
    }
    if (request.method === "DELETE") {
      response.writeHead(200).end();
      return;
    }
    const header = request.headers.authorization ?? "";
    seen.authorizationHeaders.push(header);
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const grant = access.get(token);
    const text = await readBody(request);
    if (grant === undefined) {
      challenge(response);
      return;
    }
    const message = JSON.parse(text) as {
      id?: number;
      method: string;
      params?: Record<string, unknown>;
    };
    if (message.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    const reply = (result: unknown): void =>
      json(
        response,
        200,
        { jsonrpc: "2.0", id: message.id, result },
        { "mcp-session-id": "fixture-session" },
      );
    if (message.method === "initialize") {
      reply({
        protocolVersion: (message.params?.["protocolVersion"] as string) ?? "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "oauth-fixture", version: "1.0.0" },
      });
      return;
    }
    if (message.method === "tools/list") {
      reply({ tools: TOOLS.map(({ scope: _scope, ...tool }) => tool) });
      return;
    }
    if (message.method === "tools/call") {
      const name = String(message.params?.["name"]);
      const tool = TOOLS.find((candidate) => candidate.name === name);
      const scopes = grant.scope.split(" ");
      if (tool !== undefined && !scopes.includes(tool.scope)) {
        response.writeHead(403, {
          "www-authenticate": `Bearer error="insufficient_scope", scope="${[...new Set([...scopes, tool.scope])].join(" ")}", resource_metadata="${resourceMetadata()}"`,
        });
        response.end("insufficient scope");
        return;
      }
      seen.toolCalls.push({ name, token });
      reply({ content: [{ type: "text", text: `${name} ok for ${grant.clientId}` }] });
      return;
    }
    json(response, 200, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "no" } });
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", base);
    const apiKey = request.headers["x-api-key"];
    if (typeof apiKey === "string") {
      (url.pathname === "/mcp" ? seen.apiKeys.mcp : seen.apiKeys.elsewhere).push(apiKey);
    }
    if (url.pathname === "/mcp") return handleMcp(request, response);
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      json(response, 200, {
        resource: `${base}/mcp`,
        authorization_servers: [base],
        scopes_supported: ["read"],
      });
      return;
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      json(response, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        ...(dynamic ? { registration_endpoint: `${base}/register` } : {}),
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
      });
      return;
    }
    if (url.pathname === "/register" && dynamic && request.method === "POST") {
      const metadata = JSON.parse(await readBody(request)) as Record<string, unknown>;
      seen.registrations += 1;
      const clientId = `dyn-${seen.registrations}`;
      clients.set(clientId, {});
      json(response, 201, { ...metadata, client_id: clientId });
      return;
    }
    if (url.pathname === "/authorize") {
      const clientId = url.searchParams.get("client_id") ?? "";
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      const challengeValue = url.searchParams.get("code_challenge") ?? "";
      seen.authorizations.push({
        scope: url.searchParams.get("scope"),
        clientId,
        challengeMethod: url.searchParams.get("code_challenge_method"),
        redirectUri,
      });
      if (!clients.has(clientId) || url.searchParams.get("code_challenge_method") !== "S256") {
        response.writeHead(400).end("bad authorization request");
        return;
      }
      const code = `code-${randomBytes(8).toString("hex")}`;
      codes.set(code, {
        clientId,
        challenge: challengeValue,
        redirectUri,
        scope: url.searchParams.get("scope") ?? "read",
      });
      const target = new URL(redirectUri);
      target.searchParams.set("code", code);
      target.searchParams.set("state", url.searchParams.get("state") ?? "");
      response.writeHead(302, { location: target.href }).end();
      return;
    }
    if (url.pathname === "/token" && request.method === "POST") {
      const form = new URLSearchParams(await readBody(request));
      const grantType = form.get("grant_type") ?? "";
      seen.tokenGrants.push(grantType);
      const clientId = form.get("client_id") ?? "";
      const client = clients.get(clientId);
      if (
        client === undefined ||
        (client.secret !== undefined && form.get("client_secret") !== client.secret)
      ) {
        json(response, 401, { error: "invalid_client" });
        return;
      }
      if (grantType === "authorization_code") {
        const stored = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        const computed = createHash("sha256").update(verifier).digest("base64url");
        if (
          stored === undefined ||
          stored.clientId !== clientId ||
          stored.redirectUri !== form.get("redirect_uri") ||
          computed !== stored.challenge
        ) {
          json(response, 400, { error: "invalid_grant" });
          return;
        }
        json(response, 200, issue({ clientId, scope: stored.scope }));
        return;
      }
      if (grantType === "refresh_token" && options.hangRefresh === true) return;
      if (grantType === "refresh_token") {
        const grant = refresh.get(form.get("refresh_token") ?? "");
        if (grant === undefined) {
          json(response, 400, { error: "invalid_grant" });
          return;
        }
        refresh.delete(form.get("refresh_token") ?? "");
        json(response, 200, issue(grant));
        return;
      }
      json(response, 400, { error: "unsupported_grant_type" });
      return;
    }
    response.writeHead(404).end();
  };

  const server: Server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture did not listen");
  base = `http://127.0.0.1:${address.port}`;

  return {
    base,
    mcpUrl: `${base}/mcp`,
    seen,
    issuedTokens,
    expireAccessTokens: () => access.clear(),
    revokeRefreshTokens: () => refresh.clear(),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * The person and their browser: follow the authorization page's redirect to
 * Volli's loopback callback, as approving consent would.
 */
export async function approveInBrowser(url: string): Promise<void> {
  const authorize = await fetch(url, { redirect: "manual" });
  const location = authorize.headers.get("location");
  if (location === null) throw new Error(`authorization was not approved (${authorize.status})`);
  await fetch(location);
}
