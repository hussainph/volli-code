import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { isProviderRefused } from "./provider";
import { WORKOS_DEFAULT_API_BASE, workosProvider } from "./workos";

const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** A JWT-shaped access token: only its claims matter to main. */
function accessToken(claims: Record<string, unknown>): string {
  return `${part({ alg: "RS256" })}.${part(claims)}.sig`;
}

interface Seen {
  method: string;
  path: string;
  contentType: string | undefined;
  body: unknown;
}

const servers: (() => void)[] = [];
afterEach(() => {
  for (const close of servers.splice(0)) close();
});

/** A stand-in for WorkOS's API: records each request and answers what the test says. */
async function standIn(answer: (seen: Seen) => { status: number; body: unknown }) {
  const seen: Seen[] = [];
  const server = createServer(async (request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString();
    const entry = {
      method: request.method ?? "",
      path: request.url ?? "",
      contentType: request.headers["content-type"],
      body: text === "" ? null : JSON.parse(text),
    };
    seen.push(entry);
    const { status, body } = answer(entry);
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(() => server.close());
  return { apiBase: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

describe("the WorkOS adapter", () => {
  it("builds the authorization URL for a public client, the button's provider preselected", async () => {
    const provider = workosProvider({ clientId: "client_01TEST" });
    const url = new URL(
      await provider.authorizationUrl({
        redirectUri: "http://127.0.0.1:5000/auth/callback",
        state: "st",
        codeChallenge: "ch",
        connection: "github",
      }),
    );
    expect(url.origin + url.pathname).toBe(`${WORKOS_DEFAULT_API_BASE}/user_management/authorize`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "client_01TEST",
      redirect_uri: "http://127.0.0.1:5000/auth/callback",
      state: "st",
      code_challenge: "ch",
      code_challenge_method: "S256",
      provider: "GitHubOAuth",
    });
    const google = new URL(
      await provider.authorizationUrl({
        redirectUri: "http://127.0.0.1:5000/auth/callback",
        state: "st",
        codeChallenge: "ch",
        connection: "google",
      }),
    );
    expect(google.searchParams.get("provider")).toBe("GoogleOAuth");
    expect(provider.logoutUrl("session_01")).toBe(
      `${WORKOS_DEFAULT_API_BASE}/user_management/sessions/logout?session_id=session_01`,
    );
  });

  it("trades the code with the verifier and no secret, and refreshes the same way", async () => {
    const exp = Math.floor(Date.now() / 1000) + 300;
    const { apiBase, seen } = await standIn(() => ({
      status: 200,
      body: {
        user: { first_name: "Dana", last_name: "Scully", email: "dana@example.com" },
        access_token: accessToken({ sub: "user_01", sid: "session_01", exp }),
        refresh_token: "refresh-2",
      },
    }));
    const provider = workosProvider({ clientId: "client_01TEST", apiBase: `${apiBase}/` });
    const tokens = await provider.exchangeCode({
      code: "code-1",
      codeVerifier: "verifier-1",
      redirectUri: "http://127.0.0.1:5000/auth/callback",
    });
    expect(tokens).toMatchObject({
      refreshToken: "refresh-2",
      accessExpiresAt: exp * 1000,
      sessionId: "session_01",
      profile: { displayName: "Dana Scully", email: "dana@example.com" },
    });
    await provider.refresh("refresh-1");
    expect(seen).toEqual([
      {
        method: "POST",
        path: "/user_management/authenticate",
        contentType: "application/json",
        body: {
          client_id: "client_01TEST",
          grant_type: "authorization_code",
          code: "code-1",
          code_verifier: "verifier-1",
        },
      },
      {
        method: "POST",
        path: "/user_management/authenticate",
        contentType: "application/json",
        body: {
          client_id: "client_01TEST",
          grant_type: "refresh_token",
          refresh_token: "refresh-1",
        },
      },
    ]);
  });

  it("reads a refused grant as a dead sign-in, and anything else as transient", async () => {
    let status = 400;
    const { apiBase } = await standIn(() => ({
      status,
      body: { error: "invalid_grant", error_description: "Session has already ended." },
    }));
    const provider = workosProvider({ clientId: "client_01TEST", apiBase });
    const refused = await provider.refresh("dead").catch((error: unknown) => error);
    expect(isProviderRefused(refused)).toBe(true);
    expect((refused as Error).message).toContain("Session has already ended.");
    status = 503;
    const transient = await provider.refresh("any").catch((error: unknown) => error);
    expect(isProviderRefused(transient)).toBe(false);
    expect((transient as Error).message).toContain("503");
  });

  it("refuses an answer with no tokens in it", async () => {
    const { apiBase } = await standIn(() => ({ status: 200, body: { user: null } }));
    const provider = workosProvider({ clientId: "client_01TEST", apiBase });
    await expect(provider.refresh("r")).rejects.toThrow("without an access token");
  });
});
